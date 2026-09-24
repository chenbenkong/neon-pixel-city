import { rng } from './util.js';

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// voiced chords: pad notes, bass root
const CHORDS = {
  Am: { pad: [57, 60, 64, 69], bass: 33 },
  F: { pad: [53, 57, 60, 65], bass: 29 },
  C: { pad: [55, 60, 64, 67], bass: 36 },
  G: { pad: [55, 59, 62, 67], bass: 31 },
  Em: { pad: [55, 59, 64, 67], bass: 28 },
  Dm: { pad: [53, 57, 62, 65], bass: 38 },
};
const PROGS = [
  ['Am', 'F', 'C', 'G'],
  ['F', 'G', 'Em', 'Am'],
  ['Am', 'Dm', 'F', 'G'],
];
const SCALE = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79, 81]; // A minor pentatonic

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.flavor = '2d';
    this.bpm = 94;
    this.step = 0;
    this.kicks = [];
    this.trackIndex = 0;
    this.onTrack = null;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = (this.ctx = new AC());

    this.out = c.createGain();
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(0.9, c.currentTime, 1.2);
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.ratio.value = 3.5;
    this.comp.knee.value = 12;
    this.comp.attack.value = 0.008;
    this.comp.release.value = 0.25;
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 128;
    this.analyser.smoothingTimeConstant = 0.78;
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.comp.connect(this.out);
    this.out.connect(this.analyser);
    this.analyser.connect(c.destination);

    this.musicFilter = c.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 18000;
    this.musicFilter.Q.value = 1.2;
    this.music = c.createGain();
    this.music.gain.value = 0.62;
    this.music.connect(this.musicFilter);
    this.musicFilter.connect(this.comp);

    this.duck = c.createGain(); // sidechained bus for pad/bass
    this.duck.connect(this.music);

    this.sfx = c.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.comp);

    // reverb
    this.reverb = c.createConvolver();
    this.reverb.buffer = this.impulse(3.4, 2.6);
    this.revSend = c.createGain();
    this.revSend.gain.value = 1;
    const revOut = c.createGain();
    revOut.gain.value = 0.55;
    this.revSend.connect(this.reverb);
    this.reverb.connect(revOut);
    revOut.connect(this.musicFilter);

    // ping-pong-ish delay
    this.delay = c.createDelay(2);
    this.delay.delayTime.value = (60 / this.bpm) * 0.75;
    const fb = c.createGain();
    fb.gain.value = 0.42;
    const dl = c.createBiquadFilter();
    dl.type = 'lowpass';
    dl.frequency.value = 2600;
    this.delSend = c.createGain();
    const delOut = c.createGain();
    delOut.gain.value = 0.5;
    const pan = c.createStereoPanner ? c.createStereoPanner() : c.createGain();
    if (pan.pan) pan.pan.value = 0.35;
    this.delSend.connect(this.delay);
    this.delay.connect(dl);
    dl.connect(fb);
    fb.connect(this.delay);
    dl.connect(pan);
    pan.connect(delOut);
    delOut.connect(this.musicFilter);
    delOut.connect(this.revSend);

    this.noiseBuf = this.makeNoise(2);
    this.startAmbience();
    this.newMotif();

    this.nextTime = c.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else if (!this.muted) this.ctx.resume();
    });
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running' && !this.muted) this.ctx.resume();
  }

  impulse(sec, decay) {
    const c = this.ctx, len = Math.floor(c.sampleRate * sec);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  makeNoise(sec) {
    const c = this.ctx, len = Math.floor(c.sampleRate * sec);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  noiseSrc(loop = false) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = loop;
    return s;
  }

  startAmbience() {
    const c = this.ctx;
    // rain
    const n = this.noiseSrc(true);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 5200;
    this.rainGain = c.createGain();
    this.rainGain.gain.value = 0.07;
    n.connect(hp); hp.connect(lp); lp.connect(this.rainGain); this.rainGain.connect(this.comp);
    n.start();
    // city rumble
    const n2 = this.noiseSrc(true);
    n2.playbackRate.value = 0.5;
    const lp2 = c.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = 140;
    const g2 = c.createGain();
    g2.gain.value = 0.16;
    n2.connect(lp2); lp2.connect(g2); g2.connect(this.comp);
    n2.start();
    // engine (3D)
    this.engOsc = c.createOscillator();
    this.engOsc.type = 'sawtooth';
    this.engOsc.frequency.value = 48;
    this.engOsc2 = c.createOscillator();
    this.engOsc2.type = 'square';
    this.engOsc2.frequency.value = 72.5;
    this.engFilter = c.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 300;
    this.engFilter.Q.value = 4;
    this.engGain = c.createGain();
    this.engGain.gain.value = 0;
    const eg2 = c.createGain();
    eg2.gain.value = 0.35;
    this.engOsc.connect(this.engFilter);
    this.engOsc2.connect(eg2); eg2.connect(this.engFilter);
    this.engFilter.connect(this.engGain); this.engGain.connect(this.sfx);
    this.engOsc.start(); this.engOsc2.start();
    const wn = this.noiseSrc(true);
    this.windFilter = c.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 600;
    this.windFilter.Q.value = 0.6;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0;
    wn.connect(this.windFilter); this.windFilter.connect(this.windGain); this.windGain.connect(this.sfx);
    wn.start();
  }

  setEngine(on, speed01 = 0, boost = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engGain.gain.setTargetAtTime(on ? 0.05 + speed01 * 0.07 : 0, t, 0.15);
    this.engOsc.frequency.setTargetAtTime(42 + speed01 * 70 + (boost ? 25 : 0), t, 0.2);
    this.engOsc2.frequency.setTargetAtTime(63 + speed01 * 104 + (boost ? 40 : 0), t, 0.2);
    this.engFilter.frequency.setTargetAtTime(220 + speed01 * 1300 + (boost ? 900 : 0), t, 0.2);
    this.windGain.gain.setTargetAtTime(on ? speed01 * speed01 * 0.22 : 0, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(400 + speed01 * 1800, t, 0.3);
  }

  setRain(v) {
    if (this.ctx) this.rainGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.5);
  }

  toggleMute() {
    if (!this.ctx) return this.muted;
    this.muted = !this.muted;
    const t = this.ctx.currentTime;
    if (this.muted) {
      this.out.gain.setTargetAtTime(0, t, 0.08);
      setTimeout(() => this.muted && this.ctx.suspend(), 400);
    } else {
      this.ctx.resume();
      this.out.gain.setTargetAtTime(0.9, t, 0.2);
    }
    return this.muted;
  }

  setFlavor(f) {
    this.flavor = f;
  }

  newMotif() {
    const r = rng(Math.random());
    this.motif = [];
    let idx = 4 + Math.floor(r() * 3);
    for (let s = 0; s < 32; s++) {
      const on = s % 4 === 0 ? r() < 0.8 : s % 2 === 0 ? r() < 0.45 : r() < 0.12;
      if (on) {
        idx = Math.max(0, Math.min(SCALE.length - 1, idx + Math.round((r() - 0.5) * 4)));
        const len = s % 4 === 0 ? 1 + Math.floor(r() * 3) : 1;
        this.motif.push({ s, n: SCALE[idx], len });
      }
    }
    this.progIndex = Math.floor(Math.random() * PROGS.length);
  }

  getBeat() {
    if (!this.ctx) return 0;
    const now = this.ctx.currentTime;
    while (this.kicks.length > 1 && this.kicks[1] <= now) this.kicks.shift();
    const k = this.kicks[0];
    if (k === undefined || k > now) return 0;
    return Math.exp(-(now - k) * 7);
  }

  spectrum() {
    if (!this.ctx) return null;
    this.analyser.getByteFrequencyData(this.freq);
    return this.freq;
  }

  schedule() {
    const c = this.ctx;
    const spb = 60 / this.bpm / 4;
    while (this.nextTime < c.currentTime + 0.14) {
      this.playStep(this.step, this.nextTime, spb);
      this.nextTime += spb;
      this.step++;
    }
  }

  playStep(step, t, spb) {
    const bar = Math.floor(step / 16) % 32;
    const s = step % 16;
    if (step > 0 && step % (16 * 32) === 0) {
      this.newMotif();
      this.trackIndex++;
      this.onTrack && this.onTrack(this.trackIndex);
    }
    const prog = PROGS[(this.progIndex + Math.floor(bar / 8)) % PROGS.length];
    const chord = CHORDS[prog[bar % 4]];
    const intro = bar < 4, drums = bar >= 4 && !(bar >= 20 && bar < 24), snare = bar >= 12 && drums;
    const lead = bar >= 12, full = bar >= 24, breakdown = bar >= 20 && bar < 24;

    if (s === 0) this.pad(chord.pad, t, spb * 16);
    if (drums) {
      if (s % 4 === 0 && (full || bar >= 8 || s % 8 === 0)) this.kick(t);
      if (snare && (s === 4 || s === 12)) this.snare(t);
      if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.09 : 0.04, false);
      else if (full) this.hat(t, 0.025, false);
      if (s === 14 && bar % 2 === 1) this.hat(t, 0.06, true);
    }
    if (!intro && s % 2 === 0) {
      const oct = (s / 2) % 2 === 1 ? 12 : 0;
      this.bass(chord.bass + oct, t, spb * (breakdown ? 3.5 : 1.7), breakdown ? 0.5 : 1);
    }
    // arpeggio
    const pat = [0, 1, 2, 3, 2, 1, 2, 3];
    const an = chord.pad[pat[s % 8]] + 12;
    this.arp(an, t, spb * 0.9, intro ? 0.35 : 0.6);
    if (lead) {
      const phrase = bar % 4;
      const local = (bar % 2) * 16 + s;
      for (const m of this.motif) {
        if (m.s === local) {
          let n = m.n;
          if (phrase === 3 && local > 24) n = chord.pad[0] + 12;
          this.leadNote(n, t, spb * m.len * 1.8);
        }
      }
    }
    if (bar === 31 && s === 8) this.riserMusic(t, spb * 8);
  }

  env(g, t, a, peak, d, sus, r, end) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.setTargetAtTime(sus, t + a, d);
    g.gain.setTargetAtTime(0.0001, end, r);
  }

  kick(t) {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(1.0, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
    o.connect(g); g.connect(this.music);
    o.start(t); o.stop(t + 0.45);
    // click
    const n = this.noiseSrc(), ng = c.createGain(), nf = c.createBiquadFilter();
    nf.type = 'highpass'; nf.frequency.value = 3000;
    ng.gain.setValueAtTime(0.12, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
    n.connect(nf); nf.connect(ng); ng.connect(this.music);
    n.start(t); n.stop(t + 0.03);
    // sidechain duck
    this.duck.gain.setValueAtTime(0.35, t);
    this.duck.gain.setTargetAtTime(1, t + 0.02, 0.11);
    this.kicks.push(t);
  }

  snare(t) {
    const c = this.ctx;
    const n = this.noiseSrc(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.7;
    g.gain.setValueAtTime(0.42, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    n.connect(f); f.connect(g); g.connect(this.music); g.connect(this.revSend);
    n.start(t); n.stop(t + 0.3);
    const o = c.createOscillator(), og = c.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.1);
    og.gain.setValueAtTime(0.3, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(og); og.connect(this.music); og.connect(this.revSend);
    o.start(t); o.stop(t + 0.15);
  }

  hat(t, vol, open) {
    const c = this.ctx;
    const n = this.noiseSrc(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'highpass'; f.frequency.value = open ? 6500 : 8000;
    const d = open ? 0.22 : 0.045;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    n.connect(f); f.connect(g); g.connect(this.music);
    n.start(t, Math.random()); n.stop(t + d + 0.01);
  }

  bass(m, t, dur, vol) {
    const c = this.ctx;
    const o = c.createOscillator(), o2 = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
    o.type = 'sawtooth'; o2.type = 'square';
    o.frequency.value = mtof(m); o2.frequency.value = mtof(m - 12) * 1.003;
    f.type = 'lowpass'; f.Q.value = 6;
    f.frequency.setValueAtTime(1400, t);
    f.frequency.exponentialRampToValueAtTime(180, t + dur * 0.9);
    const og = c.createGain(); og.gain.value = 0.5;
    this.env(g, t, 0.005, 0.26 * vol, 0.08, 0.16 * vol, 0.04, t + dur);
    o.connect(f); o2.connect(og); og.connect(f); f.connect(g); g.connect(this.duck);
    o.start(t); o2.start(t); o.stop(t + dur + 0.3); o2.stop(t + dur + 0.3);
  }

  pad(notes, t, dur) {
    const c = this.ctx;
    const f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.linearRampToValueAtTime(this.flavor === '3d' ? 1900 : 1300, t + dur * 0.6);
    f.frequency.linearRampToValueAtTime(700, t + dur);
    this.env(g, t, dur * 0.3, 0.075, dur * 0.3, 0.06, 0.35, t + dur);
    f.connect(g); g.connect(this.duck); g.connect(this.revSend);
    const oscs = [];
    for (const m of notes) {
      for (const det of [-9, 8]) {
        const o = c.createOscillator();
        o.type = this.flavor === '3d' ? 'sawtooth' : 'triangle';
        o.frequency.value = mtof(m);
        o.detune.value = det;
        o.connect(f);
        oscs.push(o);
      }
    }
    const sub = c.createOscillator();
    sub.type = 'sine'; sub.frequency.value = mtof(notes[0] - 12);
    const sg = c.createGain(); sg.gain.value = 0.8;
    sub.connect(sg); sg.connect(f);
    oscs.push(sub);
    for (const o of oscs) { o.start(t); o.stop(t + dur + 1.6); }
  }

  arp(m, t, dur, vol) {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
    const chip = this.flavor === '2d';
    o.type = chip ? 'square' : 'sawtooth';
    o.frequency.value = mtof(m);
    f.type = 'lowpass';
    f.frequency.setValueAtTime(chip ? 3200 : 4200, t);
    f.frequency.exponentialRampToValueAtTime(chip ? 1400 : 600, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime((chip ? 0.035 : 0.05) * vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(f); f.connect(g); g.connect(this.music); g.connect(this.delSend);
    o.start(t); o.stop(t + dur + 0.05);
  }

  leadNote(m, t, dur) {
    const c = this.ctx;
    const chip = this.flavor === '2d';
    const o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain(), f = c.createBiquadFilter();
    o.type = chip ? 'square' : 'sawtooth';
    o2.type = chip ? 'square' : 'sawtooth';
    o.frequency.value = mtof(m + 12);
    o2.frequency.value = mtof(m + 12);
    o2.detune.value = chip ? 1200 : 12;
    const lfo = c.createOscillator(), lg = c.createGain();
    lfo.frequency.value = chip ? 7 : 5.2;
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(chip ? 10 : 14, t + dur * 0.6);
    lfo.connect(lg); lg.connect(o.detune); lg.connect(o2.detune);
    f.type = 'lowpass'; f.frequency.value = chip ? 3800 : 2600; f.Q.value = 3;
    const g2 = c.createGain(); g2.gain.value = chip ? 0.25 : 0.6;
    this.env(g, t, 0.02, chip ? 0.045 : 0.06, 0.2, chip ? 0.03 : 0.045, 0.12, t + dur);
    o.connect(f); o2.connect(g2); g2.connect(f); f.connect(g);
    g.connect(this.music); g.connect(this.delSend); g.connect(this.revSend);
    for (const x of [o, o2, lfo]) { x.start(t); x.stop(t + dur + 0.8); }
  }

  riserMusic(t, dur) {
    const c = this.ctx;
    const n = this.noiseSrc(true), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'bandpass'; f.Q.value = 3;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(7000, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.1);
    n.connect(f); f.connect(g); g.connect(this.music); g.connect(this.revSend);
    n.start(t); n.stop(t + dur + 0.2);
  }

  // ---------- SFX ----------
  transition() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    // music filter dip
    const mf = this.musicFilter.frequency;
    mf.cancelScheduledValues(t);
    mf.setValueAtTime(mf.value, t);
    mf.exponentialRampToValueAtTime(320, t + 0.5);
    mf.setValueAtTime(320, t + 1.05);
    mf.exponentialRampToValueAtTime(18000, t + 2.2);
    // riser
    const n = this.noiseSrc(true), nf = c.createBiquadFilter(), ng = c.createGain();
    nf.type = 'bandpass'; nf.Q.value = 4;
    nf.frequency.setValueAtTime(300, t);
    nf.frequency.exponentialRampToValueAtTime(9000, t + 1.0);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.4, t + 0.98);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    n.connect(nf); nf.connect(ng); ng.connect(this.sfx); ng.connect(this.revSend);
    n.start(t); n.stop(t + 1.2);
    const o = c.createOscillator(), og = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(1400, t + 1.0);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.07, t + 0.95);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
    o.connect(og); og.connect(this.sfx); og.connect(this.delSend);
    o.start(t); o.stop(t + 1.1);
    // glitch blips
    for (let i = 0; i < 14; i++) {
      const bt = t + Math.random() * 0.55;
      const b = c.createOscillator(), bg = c.createGain();
      b.type = 'square';
      b.frequency.value = 200 + Math.random() * 2400;
      bg.gain.setValueAtTime(0.05, bt);
      bg.gain.exponentialRampToValueAtTime(0.0001, bt + 0.03 + Math.random() * 0.04);
      b.connect(bg); bg.connect(this.sfx);
      b.start(bt); b.stop(bt + 0.1);
    }
    // impact
    const it = t + 1.02;
    const k = c.createOscillator(), kg = c.createGain();
    k.frequency.setValueAtTime(110, it);
    k.frequency.exponentialRampToValueAtTime(26, it + 1.0);
    kg.gain.setValueAtTime(0.9, it);
    kg.gain.exponentialRampToValueAtTime(0.001, it + 1.4);
    k.connect(kg); kg.connect(this.sfx);
    k.start(it); k.stop(it + 1.5);
    const cn = this.noiseSrc(true), cf = c.createBiquadFilter(), cg = c.createGain();
    cf.type = 'lowpass';
    cf.frequency.setValueAtTime(9000, it);
    cf.frequency.exponentialRampToValueAtTime(300, it + 1.6);
    cg.gain.setValueAtTime(0.35, it);
    cg.gain.exponentialRampToValueAtTime(0.001, it + 1.8);
    cn.connect(cf); cf.connect(cg); cg.connect(this.sfx); cg.connect(this.revSend);
    cn.start(it); cn.stop(it + 1.9);
    // shimmer chord
    for (const m of [69, 76, 81, 88]) {
      const s = c.createOscillator(), sg = c.createGain();
      s.type = 'triangle'; s.frequency.value = mtof(m);
      sg.gain.setValueAtTime(0.0001, it);
      sg.gain.linearRampToValueAtTime(0.03, it + 0.05);
      sg.gain.exponentialRampToValueAtTime(0.0001, it + 2.2);
      s.connect(sg); sg.connect(this.sfx); sg.connect(this.revSend); sg.connect(this.delSend);
      s.start(it); s.stop(it + 2.3);
    }
  }

  blip(freq = 1600, dur = 0.04, vol = 0.05, type = 'sine') {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.sfx);
    o.start(t); o.stop(t + dur + 0.02);
  }

  step2d() {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noiseSrc(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'bandpass'; f.frequency.value = 700 + Math.random() * 500; f.Q.value = 1.4;
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    n.connect(f); f.connect(g); g.connect(this.sfx);
    n.start(t, Math.random()); n.stop(t + 0.08);
  }

  jump() { this.blip(320, 0.12, 0.05, 'square'); }

  land(power = 1) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noiseSrc(), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'lowpass'; f.frequency.value = 900;
    g.gain.setValueAtTime(0.25 * power, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    n.connect(f); f.connect(g); g.connect(this.sfx);
    n.start(t); n.stop(t + 0.3);
    if (power > 1) {
      const o = c.createOscillator(), og = c.createGain();
      o.frequency.setValueAtTime(90, t);
      o.frequency.exponentialRampToValueAtTime(30, t + 0.5);
      og.gain.setValueAtTime(0.5, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      o.connect(og); og.connect(this.sfx);
      o.start(t); o.stop(t + 0.65);
    }
  }

  whoosh(vol = 0.2, dur = 1.2) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime;
    const n = this.noiseSrc(true), f = c.createBiquadFilter(), g = c.createGain();
    f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2200, t + dur * 0.5);
    f.frequency.exponentialRampToValueAtTime(400, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f); f.connect(g); g.connect(this.sfx);
    n.start(t, Math.random()); n.stop(t + dur + 0.05);
  }

  thunder(delay = 0.8) {
    if (!this.ctx || this.muted) return;
    const c = this.ctx, t = c.currentTime + delay;
    const n = this.noiseSrc(true), f = c.createBiquadFilter(), g = c.createGain();
    n.playbackRate.value = 0.35;
    f.type = 'lowpass'; f.frequency.value = 260;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.12);
    g.gain.setTargetAtTime(0.35, t + 0.3, 0.3);
    g.gain.setTargetAtTime(0.0001, t + 1.2, 0.8);
    n.connect(f); f.connect(g); g.connect(this.sfx); g.connect(this.revSend);
    n.start(t); n.stop(t + 5);
  }
}
