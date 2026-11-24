// 80s MODE: the whole app as a 1984 TV ident (see retro.css), with optional
// soundscapes. Every sound is synthesized live with the Web Audio API (no
// audio files): a synthwave track, or the hum of a 1980s computer room whose
// floppy drive chatters while the game (or the AI) is thinking, plus key
// clicks and blips. The choice is kept in this browser only.

import { store } from './storage.js';
import { t } from './i18n.js';

const KEY = 'pf.retro';
const state = Object.assign({ on: false, sound: 'off', volume: 0.5, ui: true }, store.get(KEY, {}));
const save = () => store.set(KEY, { on: state.on, sound: state.sound, volume: state.volume, ui: state.ui });
const listeners = new Set();
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const retro = {
  get on() { return state.on; },
  get sound() { return state.sound; },
  onChange(fn) { listeners.add(fn); },
};

/** Apply the saved state at start-up (before anything is drawn). */
export function initRetro() {
  apply(false);
  // Browsers only allow sound after a user gesture: start then.
  const unlock = () => {
    removeEventListener('pointerdown', unlock, true);
    removeEventListener('keydown', unlock, true);
    if (state.on && state.sound !== 'off') audio.start(state.sound);
  };
  addEventListener('pointerdown', unlock, true);
  addEventListener('keydown', unlock, true);
  // Typing clicks like a 1984 keyboard.
  addEventListener('keydown', (e) => {
    if (!state.on || !state.ui || state.sound === 'off' || e.repeat) return;
    if (!(e.target instanceof HTMLInputElement) || e.target.type === 'checkbox' || e.target.type === 'range') return;
    if (e.key === 'Enter') audio.blip('send');
    else if (e.key.length === 1 || e.key === 'Backspace') audio.blip(e.key === ' ' ? 'space' : 'key');
  }, true);
}

function apply(animate) {
  const root = document.documentElement;
  if (state.on) root.dataset.retro = '80s'; else delete root.dataset.retro;
  if (!document.querySelector('.crt-overlay')) {
    const crt = document.createElement('div');
    crt.className = 'crt-overlay';
    crt.setAttribute('aria-hidden', 'true');
    document.body.append(crt);
  }
  if (animate && state.on && !reducedMotion()) {
    const p = document.createElement('div');
    p.className = 'crt-power';
    document.body.append(p);
    setTimeout(() => p.remove(), 1500);
  }
  for (const fn of listeners) fn(state);
}

function setOn(on) {
  state.on = on;
  save();
  apply(true);
  if (on) {
    audio.blip('power');
    if (state.sound !== 'off') audio.start(state.sound);
  } else {
    audio.stop();
  }
  syncControls();
}

function setSound(kind) {
  state.sound = kind;
  save();
  if (kind === 'off') audio.stop(); else if (state.on) audio.start(kind);
  syncControls();
}

// ---------------------------------------------------------------------------
// Controls (the main game list and the settings dialog)
// ---------------------------------------------------------------------------

const controls = new Set();

/** The 80s switch with the sound options, as an element. */
export function retroControls() {
  const panel = document.createElement('div');
  panel.className = 'retro-panel';
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'retro-switch';
  sw.setAttribute('role', 'switch');
  const stripes = document.createElement('span'); stripes.className = 'rs-stripes';
  const label = document.createElement('span'); label.className = 'rs-text';
  const knob = document.createElement('span'); knob.className = 'rs-knob';
  sw.append(stripes, label, knob);
  sw.addEventListener('click', () => setOn(!state.on));

  const sound = document.createElement('div');
  sound.className = 'retro-sound';
  const sl = document.createElement('span'); sl.className = 'rs-label';
  const seg = document.createElement('div'); seg.className = 'rs-seg'; seg.setAttribute('role', 'group');
  for (const kind of ['off', 'synth', 'machine']) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.kind = kind;
    b.addEventListener('click', () => setSound(kind));
    seg.append(b);
  }
  const vol = document.createElement('input');
  vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.05'; vol.className = 'rs-vol';
  vol.addEventListener('input', () => { state.volume = Number(vol.value); audio.volume(state.volume); save(); });
  const ui = document.createElement('label'); ui.className = 'rs-ui';
  const uiBox = document.createElement('input'); uiBox.type = 'checkbox';
  uiBox.addEventListener('change', () => { state.ui = uiBox.checked; save(); });
  const uiText = document.createElement('span');
  ui.append(uiBox, uiText);
  sound.append(sl, seg, vol, ui);
  panel.append(sw, sound);

  const c = { panel, sw, label, sound, sl, seg, vol, uiBox, uiText };
  controls.add(c);
  syncControl(c);
  return panel;
}

function syncControl(c) {
  if (!c.panel.isConnected && c.synced) { controls.delete(c); return; }
  c.synced = true;
  c.sw.setAttribute('aria-checked', String(state.on));
  c.label.textContent = t('retroSwitch');
  c.sw.title = t('retroSwitchTitle');
  c.sound.hidden = !state.on;
  c.sl.textContent = t('retroSound');
  for (const b of c.seg.children) {
    b.textContent = t(`retroSound_${b.dataset.kind}`);
    b.setAttribute('aria-pressed', String(state.sound === b.dataset.kind));
  }
  c.vol.value = String(state.volume);
  c.vol.setAttribute('aria-label', t('retroVolume'));
  c.vol.hidden = state.sound === 'off';
  c.uiBox.checked = state.ui;
  c.uiText.textContent = t('retroUiSounds');
}
function syncControls() { for (const c of [...controls]) syncControl(c); }
export function refreshRetroControls() { syncControls(); }

// ---------------------------------------------------------------------------
// Sound events from the app
// ---------------------------------------------------------------------------

const uiOn = () => state.on && state.ui && state.sound !== 'off';
export const sfx = {
  /** The game or the AI is working (the floppy drive runs in the computer room). */
  busy(on) { if (state.on && state.sound !== 'off') audio.busy(on); },
  reply() { if (uiOn()) audio.blip('reply'); },
  score() { if (uiOn()) audio.blip('score'); },
  begin() { if (state.on && state.sound !== 'off') audio.blip('power'); },
};

// ---------------------------------------------------------------------------
// The synthesizer
// ---------------------------------------------------------------------------

const audio = (() => {
  let ctx = null; let master = null; let music = null; let fx = null; let verb = null;
  let kind = 'off'; let timer = 0; let nextTime = 0; let step = 0; let roomNodes = []; let drive = null;

  const ensure = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = state.volume * 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);
    // A big 80s room: a convolver with a generated, decaying noise tail.
    verb = ctx.createConvolver();
    const len = ctx.sampleRate * 2.6;
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.4;
    }
    verb.buffer = ir;
    const verbGain = ctx.createGain(); verbGain.gain.value = 0.32;
    verb.connect(verbGain).connect(master);
    music = ctx.createGain(); music.gain.value = 0; music.connect(master); music.connect(verb);
    fx = ctx.createGain(); fx.gain.value = 0.55; fx.connect(master);
    return true;
  };

  const noiseCache = new Map();
  const noiseBuffer = (seconds, brown = false) => {
    const key = `${seconds}|${brown}`;
    if (noiseCache.has(key)) return noiseCache.get(key);
    const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    noiseCache.set(key, b);
    return b;
  };

  // ---- synthwave: Am - F - C - G, pad, bass, arpeggio, gated drums ----
  const BPM = 92; const BEAT = 60 / BPM; const S16 = BEAT / 4;
  const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 55, 64], [55, 59, 62]]; // MIDI
  const freq = (m) => 440 * 2 ** ((m - 69) / 12);
  let delay = null; let arp = null;

  function voice(t, f, dur, { type = 'sawtooth', gain = 0.05, attack = 0.01, release = 0.3, cutoff = 2400, q = 1, detune = 0, dest = music }) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune;
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = cutoff; flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setValueAtTime(gain, t + Math.max(attack, dur - release));
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(flt).connect(g).connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
    return flt;
  }

  function drum(t, which) {
    if (which === 'kick') {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
      g.gain.setValueAtTime(0.32, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      o.connect(g).connect(music); o.start(t); o.stop(t + 0.35);
      return;
    }
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.4);
    const flt = ctx.createBiquadFilter();
    flt.type = which === 'hat' ? 'highpass' : 'bandpass';
    flt.frequency.value = which === 'hat' ? 7000 : 1800;
    const g = ctx.createGain();
    const peak = which === 'hat' ? 0.035 : 0.16; const len = which === 'hat' ? 0.05 : 0.22;
    g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(flt).connect(g).connect(music);
    if (which === 'snare') { const s = ctx.createGain(); s.gain.value = 0.9; g.connect(s).connect(verb); } // gated-reverb snare
    src.start(t); src.stop(t + len + 0.05);
  }

  function scheduleSynth() {
    while (nextTime < ctx.currentTime + 0.25) {
      const t = nextTime;
      const bar = Math.floor(step / 16); const s = step % 16;
      const chord = CHORDS[Math.floor(bar / 2) % CHORDS.length];
      if (s === 0 && bar % 2 === 0) {
        // pad: two detuned saws per note, slow filter swell
        for (const m of chord) {
          for (const det of [-9, 9]) {
            const flt = voice(t, freq(m), BEAT * 8, { gain: 0.022, attack: 1.4, release: 1.6, cutoff: 700, detune: det });
            flt.frequency.setValueAtTime(500, t); flt.frequency.linearRampToValueAtTime(1800, t + BEAT * 4); flt.frequency.linearRampToValueAtTime(700, t + BEAT * 8);
          }
        }
      }
      // bass: eighth-note pulse on the root
      if (s % 2 === 0) voice(t, freq(chord[0] - 24), S16 * 1.7, { gain: 0.09, attack: 0.005, release: 0.12, cutoff: 600, q: 4 });
      // arpeggio through a dotted-eighth echo
      if (bar >= 4 && s % 2 === 0) {
        const notes = [chord[0], chord[1], chord[2], chord[0] + 12, chord[2], chord[1], chord[0] + 12, chord[1] + 12];
        voice(t, freq(notes[(s / 2) % notes.length] + 12), S16 * 1.5, { type: 'square', gain: 0.022, attack: 0.004, release: 0.1, cutoff: 3200, dest: arp });
      }
      // drums come in after the intro
      if (bar >= 8) {
        if (s === 0 || s === 8) drum(t, 'kick');
        if (s === 4 || s === 12) drum(t, 'snare');
        if (s % 2 === 1) drum(t, 'hat');
      }
      nextTime += S16; step++;
    }
  }

  // ---- computer room: fan, mains hum, CRT whine; floppy drive when busy ----
  function startRoom() {
    const fan = ctx.createBufferSource(); fan.buffer = noiseBuffer(4, true); fan.loop = true;
    const fanF = ctx.createBiquadFilter(); fanF.type = 'lowpass'; fanF.frequency.value = 380;
    const fanG = ctx.createGain(); fanG.gain.value = 0.12;
    fan.connect(fanF).connect(fanG).connect(music); fan.start();
    const hum = ctx.createOscillator(); hum.frequency.value = 50; hum.type = 'triangle';
    const humG = ctx.createGain(); humG.gain.value = 0.02; hum.connect(humG).connect(music); hum.start();
    const whine = ctx.createOscillator(); whine.frequency.value = 15734; // the line frequency of an NTSC set
    const whineG = ctx.createGain(); whineG.gain.value = 0.0035; whine.connect(whineG).connect(music); whine.start();
    roomNodes = [fan, hum, whine];
    // now and then a relay click or a printer somewhere down the hall
    const tick = () => {
      if (kind !== 'machine') return;
      const t = ctx.currentTime;
      click(t, 0.05, 2400);
      if (Math.random() < 0.35) for (let i = 0; i < 8; i++) click(t + 0.6 + i * 0.07, 0.02, 1500 + Math.random() * 900);
      roomTimer = setTimeout(tick, 9000 + Math.random() * 14000);
    };
    roomTimer = setTimeout(tick, 4000);
  }
  let roomTimer = 0; let stopTimer = 0;

  function click(t, gain, f) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(0.03);
    const flt = ctx.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = f; flt.Q.value = 2;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.025);
    src.connect(flt).connect(g).connect(fx); src.start(t); src.stop(t + 0.04);
  }

  // A 5.25" drive: the spindle motor hums, the head stepper grinds in bursts.
  function driveOn() {
    if (drive) return;
    const motor = ctx.createOscillator(); motor.type = 'sawtooth'; motor.frequency.value = 75;
    const mf = ctx.createBiquadFilter(); mf.type = 'lowpass'; mf.frequency.value = 260;
    const mg = ctx.createGain(); mg.gain.setValueAtTime(0, ctx.currentTime); mg.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 0.3);
    motor.connect(mf).connect(mg).connect(fx); motor.start();
    drive = { motor, mg, timer: 0 };
    const seek = () => {
      if (!drive) return;
      const t = ctx.currentTime; const n = 3 + Math.floor(Math.random() * 14); const rate = 0.012 + Math.random() * 0.01;
      for (let i = 0; i < n; i++) {
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 90 + Math.random() * 40;
        const g = ctx.createGain(); const at = t + i * rate;
        g.gain.setValueAtTime(0.06, at); g.gain.exponentialRampToValueAtTime(0.0005, at + 0.011);
        o.connect(g).connect(fx); o.start(at); o.stop(at + 0.015);
      }
      drive.timer = setTimeout(seek, 140 + Math.random() * 520);
    };
    seek();
  }
  function driveOff() {
    if (!drive) return;
    clearTimeout(drive.timer);
    const { motor, mg } = drive;
    mg.gain.cancelScheduledValues(ctx.currentTime);
    mg.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
    setTimeout(() => motor.stop(), 900);
    drive = null;
  }

  return {
    start(k) {
      if (!ensure()) return;
      clearTimeout(stopTimer);
      if (kind === k) { // still fading out: fade back in
        music.gain.cancelScheduledValues(ctx.currentTime);
        music.gain.setTargetAtTime(k === 'synth' ? 1.4 : 1, ctx.currentTime, 0.4);
        return;
      }
      this.stopMusic();
      kind = k;
      music.gain.cancelScheduledValues(ctx.currentTime);
      music.gain.setValueAtTime(0, ctx.currentTime);
      music.gain.linearRampToValueAtTime(k === 'synth' ? 1.4 : 1, ctx.currentTime + 2.5);
      if (k === 'synth') {
        delay = ctx.createDelay(1); delay.delayTime.value = BEAT * 0.75;
        const fb = ctx.createGain(); fb.gain.value = 0.38;
        const wet = ctx.createGain(); wet.gain.value = 0.7;
        delay.connect(fb).connect(delay); delay.connect(wet).connect(music);
        arp = ctx.createGain(); arp.gain.value = 1; // the arpeggio: dry, and into the echo
        arp.connect(music); arp.connect(delay);
        nextTime = ctx.currentTime + 0.1; step = 0;
        timer = setInterval(scheduleSynth, 60);
      } else if (k === 'machine') {
        startRoom();
      }
    },
    stopMusic() {
      clearInterval(timer); timer = 0;
      clearTimeout(roomTimer);
      for (const n of roomNodes) { try { n.stop(); } catch { /* already stopped */ } }
      roomNodes = [];
      driveOff();
      kind = 'off';
    },
    stop() {
      if (!ctx) return;
      music.gain.cancelScheduledValues(ctx.currentTime);
      music.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
      clearTimeout(stopTimer);
      stopTimer = setTimeout(() => this.stopMusic(), 1200);
    },
    volume(v) { if (master) master.gain.setTargetAtTime(v * 0.8, ctx.currentTime, 0.05); },
    busy(on) {
      if (!ctx || kind !== 'machine') return;
      if (on) driveOn(); else driveOff();
    },
    blip(type) {
      if (!ensure()) return;
      const t = ctx.currentTime;
      const tone = (f, at, dur, wave = 'square', gain = 0.05) => voice(t + at, f, dur, { type: wave, gain, attack: 0.004, release: dur * 0.6, cutoff: 5000, dest: fx });
      switch (type) {
        case 'key': click(t, 0.12, 1800 + Math.random() * 600); break;
        case 'space': click(t, 0.14, 900); break;
        case 'send': tone(660, 0, 0.06); tone(990, 0.06, 0.09); break;
        case 'reply': tone(1320, 0, 0.04, 'triangle', 0.04); tone(1760, 0.045, 0.06, 'triangle', 0.03); break;
        case 'score': [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.08, 0.12, 'square', 0.045)); break;
        case 'power': {
          // the thump of a CRT switching on, the degauss hum, the whine rising
          const o = ctx.createOscillator(); const g = ctx.createGain();
          o.frequency.setValueAtTime(60, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.5);
          g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
          o.connect(g).connect(fx); o.start(t); o.stop(t + 1);
          const w = ctx.createOscillator(); const wg = ctx.createGain();
          w.frequency.setValueAtTime(3000, t); w.frequency.exponentialRampToValueAtTime(15000, t + 0.8);
          wg.gain.setValueAtTime(0.012, t); wg.gain.exponentialRampToValueAtTime(0.0008, t + 1.2);
          w.connect(wg).connect(fx); w.start(t); w.stop(t + 1.3);
          const n = ctx.createBufferSource(); n.buffer = noiseBuffer(0.5); const ng = ctx.createGain();
          ng.gain.setValueAtTime(0.06, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
          n.connect(ng).connect(fx); n.start(t);
          break;
        }
        default: break;
      }
    },
  };
})();
