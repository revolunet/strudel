import { toMidi, fromMidi } from '@strudel.cycles/core/util.mjs';
// import './feedbackdelay.mjs';
// import './reverb.mjs';

// TODO: reuse as much logic as possible between webaudio.mjs and render.mjs

const logger = console.log;

export const splitSN = (s, n) => {
  if (!s.includes(':')) {
    return [s, n];
  }
  let [s2, n2] = s.split(':');
  if (isNaN(Number(n2))) {
    return [s, n];
  }
  return [s2, n2];
};

const getOscillator = (ac, { s, freq, t, duration, release }) => {
  // make oscillator
  const o = ac.createOscillator();
  o.type = s || 'triangle';
  o.frequency.value = Number(freq);
  o.start(t);
  o.stop(t + duration + release);
  return o;
};
const getADSR = (ac, attack, decay, sustain, release, velocity, begin, end) => {
  const gainNode = ac.createGain();
  gainNode.gain.setValueAtTime(0, begin);
  gainNode.gain.linearRampToValueAtTime(velocity, begin + attack); // attack
  gainNode.gain.linearRampToValueAtTime(sustain * velocity, begin + attack + decay); // sustain start
  gainNode.gain.setValueAtTime(sustain * velocity, end); // sustain end
  gainNode.gain.linearRampToValueAtTime(0, end + release); // release
  // for some reason, using exponential ramping creates little cracklings
  /* let t = begin;
  gainNode.gain.setValueAtTime(0, t);
  gainNode.gain.exponentialRampToValueAtTime(velocity, (t += attack));
  const sustainGain = Math.max(sustain * velocity, 0.001);
  gainNode.gain.exponentialRampToValueAtTime(sustainGain, (t += decay));
  if (end - begin < attack + decay) {
    gainNode.gain.cancelAndHoldAtTime(end);
  } else {
    gainNode.gain.setValueAtTime(sustainGain, end);
  }
  gainNode.gain.exponentialRampToValueAtTime(0.001, end + release); // release */
  return gainNode;
};

function gainNode(ac, value) {
  const node = ac.createGain();
  node.gain.value = value;
  return node;
}

/* let delays = {};
function getDelay(ac, orbit, delaytime, delayfeedback, t) {
  if (!delays[orbit]) {
    const dly = ac.createFeedbackDelay(1, delaytime, delayfeedback);
    dly.start?.(t); // for some reason, this throws when audion extension is installed..
    dly.connect(ac.destination);
    delays[orbit] = dly;
  }
  delays[orbit].delayTime.value !== delaytime && delays[orbit].delayTime.setValueAtTime(delaytime, t);
  delays[orbit].feedback.value !== delayfeedback && delays[orbit].feedback.setValueAtTime(delayfeedback, t);
  return delays[orbit];
}

let reverbs = {};
function getReverb(ac, orbit, duration = 2) {
  if (!reverbs[orbit]) {
    const reverb = ac.createReverb(duration);
    reverb.connect(ac.destination);
    reverbs[orbit] = reverb;
  }
  if (reverbs[orbit].duration !== duration) {
    reverbs[orbit] = reverbs[orbit].setDuration(duration);
    reverbs[orbit].duration = duration;
  }
  return reverbs[orbit];
} */

function effectSend(input, effect, wet) {
  const send = gainNode(wet);
  input.connect(send);
  send.connect(effect);
  return send;
}

const getFilter = (ac, type, frequency, Q) => {
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = Q;
  return filter;
};

// export const webaudioOutput = async (t, hap, ct, cps) => {
export const renderHap = async (ac, hap, deadline) => {
  const hapDuration = hap.duration;
  /* if (isNote(hap.value)) {
        // supports primitive hap values that look like notes
        hap.value = { note: hap.value };
      } */
  if (typeof hap.value !== 'object') {
    logger(
      `hap.value "${hap.value}" is not supported by webaudio output. Hint: append .note() or .s() to the end`,
      'error',
    );
    /*     throw new Error(
        `hap.value "${hap.value}"" is not supported by webaudio output. Hint: append .note() or .s() to the end`,
      ); */
    return;
  }
  // calculate correct time (tone.js workaround)
  let t = ac.currentTime + deadline;
  // destructure value
  let {
    freq,
    s,
    bank,
    sf,
    clip = 0, // if 1, samples will be cut off when the hap ends
    n = 0,
    note,
    gain = 0.8,
    // low pass
    lpf,
    cutoff = lpf,
    lpq = 1,
    resonance = lpq,
    // high pass
    hpf,
    hcutoff = hpf,
    hpq = 1,
    hresonance = hpq,
    // band pass
    bpf,
    bandf = bpf,
    bpq = 1,
    bandq = bpq,
    //
    coarse,
    crush,
    shape,
    pan,
    speed = 1, // sample playback speed
    begin = 0,
    end = 1,
    vowel,
    delay = 0,
    delayfeedback = 0.5,
    delaytime = 0.25,
    unit,
    nudge = 0, // TODO: is this in seconds?
    cut,
    loop,
    orbit = 1,
    room,
    size = 2,
    roomsize = size,
  } = hap.value;
  const { velocity = 1 } = hap.context;
  gain *= velocity; // legacy fix for velocity
  // the chain will hold all audio nodes that connect to each other
  const chain = [];
  if (bank && s) {
    s = `${bank}_${s}`;
  }
  if (typeof s === 'string') {
    [s, n] = splitSN(s, n);
  }
  if (typeof note === 'string') {
    [note, n] = splitSN(note, n);
  }
  if (!s || ['sine', 'square', 'triangle', 'sawtooth'].includes(s)) {
    // destructure adsr here, because the default should be different for synths and samples
    const { attack = 0.001, decay = 0.05, sustain = 0.6, release = 0.01 } = hap.value;
    // with synths, n and note are the same thing
    n = note || n || 36;
    if (typeof n === 'string') {
      n = toMidi(n); // e.g. c3 => 48
    }
    // get frequency
    if (!freq && typeof n === 'number') {
      freq = fromMidi(n); // + 48);
    }
    // make oscillator
    const o = getOscillator(ac, { t, s, freq, duration: hapDuration, release });
    chain.push(o);
    // level down oscillators as they are really loud compared to samples i've tested
    chain.push(gainNode(ac, 0.3));
    // TODO: make adsr work with samples without pops
    // envelope
    const adsr = getADSR(ac, attack, decay, sustain, release, 1, t, t + hapDuration);
    chain.push(adsr);
  } else {
    // TODO: refactor sampler to node
    /* 
    // destructure adsr here, because the default should be different for synths and samples
    const { attack = 0.001, decay = 0.001, sustain = 1, release = 0.001 } = hap.value;
    // load sample
    if (speed === 0) {
      // no playback
      return;
    }
    if (!s) {
      console.warn('no sample specified');
      return;
    }
    const soundfont = getSoundfontKey(s);
    let bufferSource;

    if (soundfont) {
      // is soundfont
      bufferSource = await globalThis.getFontBufferSource(soundfont, note || n, ac, freq);
    } else {
      // is sample from loaded samples(..)
      bufferSource = await getSampleBufferSource(s, n, note, speed, freq);
    }
    // asny stuff above took too long?
    if (ac.currentTime > t) {
      logger(`[sampler] still loading sound "${s}:${n}"`, 'highlight');
      // console.warn('sample still loading:', s, n);
      return;
    }
    if (!bufferSource) {
      console.warn('no buffer source');
      return;
    }
    bufferSource.playbackRate.value = Math.abs(speed) * bufferSource.playbackRate.value;
    if (unit === 'c') {
      // are there other units?
      bufferSource.playbackRate.value = bufferSource.playbackRate.value * bufferSource.buffer.duration;
    }
    let duration = soundfont || clip ? hapDuration : bufferSource.buffer.duration / bufferSource.playbackRate.value;
    // "The computation of the offset into the sound is performed using the sound buffer's natural sample rate,
    // rather than the current playback rate, so even if the sound is playing at twice its normal speed,
    // the midway point through a 10-second audio buffer is still 5."
    const offset = begin * duration * bufferSource.playbackRate.value;
    duration = (end - begin) * duration;
    if (loop) {
      bufferSource.loop = true;
      bufferSource.loopStart = offset;
      bufferSource.loopEnd = offset + duration;
      duration = loop * duration;
    }
    t += nudge;

    bufferSource.start(t, offset);
    if (cut !== undefined) {
      cutGroups[cut]?.stop(t); // fade out?
      cutGroups[cut] = bufferSource;
    }
    chain.push(bufferSource);
    bufferSource.stop(t + duration + release);
    const adsr = getADSR(ac, attack, decay, sustain, release, 1, t, t + duration);
    chain.push(adsr); */
  }

  // gain stage
  chain.push(gainNode(ac, gain));

  // filters
  cutoff !== undefined && chain.push(getFilter(ac, 'lowpass', cutoff, resonance));
  hcutoff !== undefined && chain.push(getFilter(ac, 'highpass', hcutoff, hresonance));
  bandf !== undefined && chain.push(getFilter(ac, 'bandpass', bandf, bandq));
  vowel !== undefined && chain.push(ac.createVowelFilter(vowel));

  // effects
  /* coarse !== undefined && chain.push(getWorklet(ac, 'coarse-processor', { coarse }));
  crush !== undefined && chain.push(getWorklet(ac, 'crush-processor', { crush }));
  shape !== undefined && chain.push(getWorklet(ac, 'shape-processor', { shape })); */

  // panning
  if (pan !== undefined) {
    const panner = ac.createStereoPanner();
    panner.pan.value = 2 * pan - 1;
    chain.push(panner);
  }

  // last gain
  const post = gainNode(ac, 1);
  chain.push(post);
  // post.connect(getDestination());
  post.connect(ac.destination);

  // TODO: refactor delay / reverb for node: extending nodes does not work..
  // delay
  /* let delaySend;
  if (delay > 0 && delaytime > 0 && delayfeedback > 0) {
    const delyNode = getDelay(ac, orbit, delaytime, delayfeedback, t);
    delaySend = effectSend(post, delyNode, delay);
  }
  // reverb
  let reverbSend;
  if (room > 0 && roomsize > 0) {
    const reverbNode = getReverb(ac, orbit, roomsize);
    reverbSend = effectSend(post, reverbNode, room);
  } */

  // connect chain elements together
  chain.slice(1).reduce((last, current) => last.connect(current), chain[0]);

  // disconnect all nodes when source node has ended:
  chain[0].onended = () =>
    chain
      .concat([
        /*delaySend  , reverbSend */
      ])
      .forEach((n) => n?.disconnect());
};
