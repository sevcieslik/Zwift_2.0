// Procedural ride sounds (Web Audio, no sound files): wind in the ears, tyres on tarmac,
// freewheel ticking when coasting, chain whirr when pedalling, rain and the odd bird.

export class RideAudio {
  constructor() {
    this.ctx = null;
    try { this.enabled = localStorage.getItem('gpxride.sound') !== '0'; } catch { this.enabled = true; }
    this.volume = 0.8;
    this._birdAt = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    try { localStorage.setItem('gpxride.sound', on ? '1' : '0'); } catch {}
    if (on) this.start();
    if (this.master) this.master.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.2);
  }

  /** Must be called from a user gesture (click) the first time. */
  start() {
    if (!this.enabled) return;
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    const noise = ctx.createBuffer(2, ctx.sampleRate * 2, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = noise.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const src = (rate = 1) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; s.playbackRate.value = rate; s.start(); return s; };
    const chain = (node, ...rest) => { let n = node; for (const r of rest) { n.connect(r); n = r; } return n; };
    const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };

    // wind: band-passed noise, louder and brighter with air speed; a slow LFO makes it gust
    this.windF = filt('bandpass', 400, 0.5); this.windG = gain();
    chain(src(), this.windF, filt('lowpass', 2500), this.windG, this.master);
    this.windLfo = ctx.createOscillator(); this.windLfo.frequency.value = 0.23;
    this.windLfoG = gain(0); this.windLfo.connect(this.windLfoG).connect(this.windG.gain); this.windLfo.start();

    // tyres: low rumble + a little hiss (more when wet)
    this.tyreF = filt('lowpass', 200, 0.9); this.tyreG = gain();
    chain(src(0.7), this.tyreF, this.tyreG, this.master);
    this.hissF = filt('highpass', 2500); this.hissG = gain();
    chain(src(1.3), this.hissF, filt('lowpass', 7000), this.hissG, this.master);

    // chain/drivetrain whirr while pedalling
    this.chainF = filt('bandpass', 1800, 3); this.chainG = gain();
    chain(src(1.1), this.chainF, this.chainG, this.master);

    // freewheel: a looped buffer of 20 short clicks per second, playback rate follows the wheel
    const fw = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = fw.getChannelData(0);
    for (let k = 0; k < 20; k++) {
      const o = Math.floor((k / 20) * d.length);
      for (let i = 0; i < 260; i++) d[o + i] += (Math.random() * 2 - 1) * Math.exp(-i / 40) * 0.9;
    }
    this.fw = ctx.createBufferSource(); this.fw.buffer = fw; this.fw.loop = true;
    this.fwG = gain();
    chain(this.fw, filt('highpass', 1500), this.fwG, this.master); this.fw.start();

    // rain on the road
    this.rainG = gain();
    chain(src(1), filt('highpass', 900), filt('lowpass', 6500), this.rainG, this.master);
    this._birdAt = ctx.currentTime + 4;
    if (!this.enabled) this.master.gain.value = 0;
  }

  _bird() {
    const ctx = this.ctx, t0 = ctx.currentTime;
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = Math.random() * 1.6 - 0.8;
    const out = ctx.createGain(); out.gain.value = 0.05 + Math.random() * 0.05;
    if (pan) out.connect(pan).connect(this.master); else out.connect(this.master);
    const notes = 2 + Math.floor(Math.random() * 5), base = 2500 + Math.random() * 2500;
    let t = t0;
    for (let k = 0; k < notes; k++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      const f0 = base * (0.85 + Math.random() * 0.3), dur = 0.06 + Math.random() * 0.1;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f0 * (Math.random() < 0.5 ? 1.35 : 0.7), t + dur);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(out); o.start(t); o.stop(t + dur + 0.02);
      t += dur + 0.03 + Math.random() * 0.08;
    }
  }

  /** speed, airspeed (m/s), power (W), cadence (rpm), rain/wet/day 0..1 */
  update({ speed = 0, airspeed = 0, power = 0, cadence = 0, rain = 0, wet = 0, day = 1, windSpeed = 0 }) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime, T = 0.25;
    const air = Math.abs(airspeed);
    // wind noise grows roughly with air speed squared; standing still you still hear the weather
    const w = Math.min(0.55, 0.0009 * air * air + 0.004 * windSpeed * windSpeed);
    this.windG.gain.setTargetAtTime(w, t, T);
    this.windLfoG.gain.setTargetAtTime(w * 0.35, t, T);
    this.windF.frequency.setTargetAtTime(250 + air * 45, t, T);
    this.tyreG.gain.setTargetAtTime(Math.min(0.35, speed * 0.022), t, T);
    this.tyreF.frequency.setTargetAtTime(120 + speed * 14, t, T);
    this.hissG.gain.setTargetAtTime(Math.min(0.25, speed * (0.002 + wet * 0.012)), t, T);
    const pedalling = cadence > 20 || power > 25;
    this.chainG.gain.setTargetAtTime(pedalling ? Math.min(0.05, 0.012 + power * 0.00008) : 0, t, 0.15);
    this.chainF.frequency.setTargetAtTime(1400 + (cadence || 85) * 6, t, T);
    const coasting = !pedalling && speed > 1.2;
    this.fwG.gain.setTargetAtTime(coasting ? 0.12 : 0, t, 0.08);
    // wheel circumference 2.1 m, ~24 pawl clicks per turn; the buffer plays 20 clicks per second
    this.fw.playbackRate.setTargetAtTime(Math.max(0.05, (speed / 2.1) * 24 / 20), t, 0.1);
    this.rainG.gain.setTargetAtTime(rain * 0.22, t, 0.6);
    if (t > this._birdAt) {
      if (day > 0.5 && rain < 0.1 && speed < 14) this._bird();
      this._birdAt = t + 2 + Math.random() * 9;
    }
  }
}
