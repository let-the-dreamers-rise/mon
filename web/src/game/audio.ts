import * as THREE from 'three';

const BASE = `${import.meta.env.BASE_URL}audio/`;

export const VOICE_FILES: Record<string, string> = {
  help: 'voice_lure_help.mp3',
  here: 'voice_lure_here.mp3',
  itsme: 'voice_lure_itsme.mp3',
  donttrust: 'voice_lure_donttrust.mp3',
  fuse: 'voice_lure_fuse.mp3',
  run: 'voice_lure_run.mp3',
};
const WHISPERS = Array.from({ length: 12 }, (_, i) => `voice_whisper_${String(i + 1).padStart(2, '0')}.mp3`);
const SHIFT_VOICES = ['voice_shift_01.mp3', 'voice_shift_02.mp3', 'voice_shift_03.mp3'];
const STEPS = [1, 2, 3, 4].map((i) => `step_carpet_${i}.mp3`);

/** Horror audio: layered loops, HRTF-positioned voices, a heartbeat driven by fear. */
/** the film harness (tools/film) records every sound with its time, to mix the soundtrack offline */
const FILM_LOG = (window as unknown as { __audioLog?: { t: number; file: string; volume: number; rate: number; dist: number }[] }).__audioLog;
function filmLog(file: string, volume: number, rate: number, dist: number) {
  FILM_LOG?.push({ t: performance.now(), file, volume, rate, dist });
}

export class Audio {
  readonly listener = new THREE.AudioListener();
  private ctx = this.listener.context;
  private buffers = new Map<string, AudioBuffer | null>();
  private loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>();
  private master: GainNode;
  private started = false;
  private nextWhisper = 0;
  private voice: SpeechSynthesisVoice | null = null;

  constructor(private scene: THREE.Scene) {
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(this.listener.getInput());
    if ('speechSynthesis' in window) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find((v) => /en/i.test(v.lang) && /male|daniel|fred|alex/i.test(v.name)) ?? vs.find((v) => /en/i.test(v.lang)) ?? null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
  }

  async load(file: string): Promise<AudioBuffer | null> {
    if (this.buffers.has(file)) return this.buffers.get(file)!;
    this.buffers.set(file, null);
    try {
      const res = await fetch(BASE + file);
      if (!res.ok) throw new Error(String(res.status));
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(file, buf);
      return buf;
    } catch {
      return null;
    }
  }

  async preload() {
    const all = [
      'amb_drone_loop.mp3', 'amb_buzz_loop.mp3', 'whisper_bed_loop.mp3', 'heartbeat_slow_loop.mp3', 'heartbeat_fast_loop.mp3',
      'breath_scared_loop.mp3', 'static_burst.mp3', 'glitch_shift.mp3', 'jumpscare_sting.mp3', 'scream_turned.mp3',
      'fuse_pickup.mp3', 'exit_power.mp3', 'door_open.mp3', 'ui_click.mp3', 'ui_hover.mp3', 'flashlight_click.mp3',
      'flashlight_flicker.mp3', 'voice_turned.mp3', 'voice_intro.mp3',
      ...Object.values(VOICE_FILES), ...WHISPERS, ...SHIFT_VOICES, ...STEPS,
    ];
    await Promise.all(all.map((f) => this.load(f)));
  }

  /** must be called from a user gesture */
  async start() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.started) return;
    this.started = true;
    void this.loop('amb_drone_loop.mp3', 0.55);
    void this.loop('amb_buzz_loop.mp3', 0.12);
    void this.loop('whisper_bed_loop.mp3', 0);
    void this.loop('heartbeat_slow_loop.mp3', 0);
    void this.loop('heartbeat_fast_loop.mp3', 0);
    void this.loop('breath_scared_loop.mp3', 0);
    this.startRain();
    this.setOutdoors(true);
  }

  private async loop(file: string, volume: number) {
    const buf = await this.load(file);
    if (!buf || this.loops.has(file)) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(this.master);
    src.start();
    this.loops.set(file, { src, gain });
  }

  private setLoop(file: string, volume: number, ramp = 0.4) {
    const l = this.loops.get(file);
    if (l) l.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, ramp);
  }

  /** fear 0..1 drives heartbeat, breathing and the whisper bed */
  setFear(fear: number, insanity: number) {
    this.setLoop('heartbeat_slow_loop.mp3', fear > 0.15 && fear < 0.6 ? 0.5 * fear + 0.1 : 0);
    this.setLoop('heartbeat_fast_loop.mp3', fear >= 0.6 ? 0.35 + fear * 0.5 : 0);
    this.setLoop('breath_scared_loop.mp3', Math.max(0, fear - 0.3) * 0.5);
    this.setLoop('whisper_bed_loop.mp3', insanity * 0.6);
    this.setLoop('amb_drone_loop.mp3', 0.45 + insanity * 0.3);
  }

  duck(seconds: number) {
    const g = this.master.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(0.15, this.ctx.currentTime, 0.05);
    g.setTargetAtTime(0.9, this.ctx.currentTime + seconds, 0.6);
  }

  async play(file: string, volume = 1, rate = 1) {
    filmLog(file, volume, rate, 0);
    const buf = await this.load(file);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(this.master);
    src.start();
  }

  /** a sound at a point in the world, HRTF-panned */
  async playAt(file: string, pos: THREE.Vector3, volume = 1, refDistance = 2.5, rate = 1) {
    if (FILM_LOG) {
      // what this sound would weigh at the listener (THREE's inverse distance model, rolloff 1.4)
      const d = this.listener.getWorldPosition(new THREE.Vector3()).distanceTo(pos);
      filmLog(file, volume * (refDistance / (refDistance + 1.4 * (Math.max(d, refDistance) - refDistance))), rate, d);
    }
    const buf = await this.load(file);
    if (!buf) return;
    const holder = new THREE.Object3D();
    holder.position.copy(pos);
    this.scene.add(holder);
    const pa = new THREE.PositionalAudio(this.listener);
    pa.panner.panningModel = 'HRTF';
    pa.setBuffer(buf);
    pa.setRefDistance(refDistance);
    pa.setRolloffFactor(1.4);
    pa.setVolume(volume);
    pa.setPlaybackRate(rate);
    holder.add(pa);
    pa.play();
    pa.source!.onended = () => {
      holder.remove(pa);
      this.scene.remove(holder);
    };
  }

  step(pos: THREE.Vector3, loud: boolean) {
    void this.playAt(STEPS[Math.floor(Math.random() * STEPS.length)], pos, loud ? 0.9 : 0.5, 1.5, 0.9 + Math.random() * 0.2);
  }

  voiceAt(key: string, pos: THREE.Vector3) {
    const f = VOICE_FILES[key];
    if (f) void this.playAt(f, pos, 1.6, 4);
  }

  shift() {
    void this.play('glitch_shift.mp3', 1);
    void this.play(SHIFT_VOICES[Math.floor(Math.random() * SHIFT_VOICES.length)], 0.9);
  }

  /** an Entity whisper right behind the listener */
  whisper(behind: THREE.Vector3) {
    void this.playAt(WHISPERS[Math.floor(Math.random() * WHISPERS.length)], behind, 0.9, 1);
  }

  maybeWhisper(now: number, insanity: number, behind: THREE.Vector3) {
    if (now < this.nextWhisper || insanity < 0.25) return;
    this.nextWhisper = now + 9000 + Math.random() * 20000 * (1.2 - insanity);
    this.whisper(behind);
  }

  // ------------------------------------------------------------------ synthesized weather & items
  private rain: { gain: GainNode; filter: BiquadFilterNode } | null = null;
  private synth = new Map<string, AudioBuffer>();

  private noiseBuffer(seconds: number, pink = true) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        if (!pink) { d[i] = w; continue; }
        b0 = 0.99765 * b0 + w * 0.099046;
        b1 = 0.963 * b1 + w * 0.2965164;
        b2 = 0.57 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
      }
      // crossfade the loop point
      const f = Math.floor(this.ctx.sampleRate * 0.3);
      for (let i = 0; i < f; i++) d[len - f + i] = d[len - f + i] * (1 - i / f) + d[i] * (i / f);
    }
    return buf;
  }

  /** rain on the town; muffled when you are inside */
  startRain() {
    if (this.rain) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(6);
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 5000;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(hp).connect(filter).connect(gain).connect(this.master);
    src.start();
    this.rain = { gain, filter };
  }

  setOutdoors(outdoor: boolean) {
    if (!this.rain) return;
    const t = this.ctx.currentTime;
    this.rain.gain.gain.setTargetAtTime(outdoor ? 0.55 : 0.18, t, 0.6);
    this.rain.filter.frequency.setTargetAtTime(outdoor ? 5200 : 700, t, 0.6);
  }

  thunder() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.synth.get('thunder') ?? this.noiseBuffer(5, false);
    this.synth.set('thunder', src.buffer);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    lp.frequency.setValueAtTime(1800, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 4.5);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.1, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.5, t + 1.2);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.8);
    src.connect(lp).connect(g).connect(this.master);
    src.start();
  }

  /** a slightly detuned music-box lullaby, rendered once offline */
  private async lullabyBuffer() {
    const cached = this.synth.get('lullaby');
    if (cached) return cached;
    const sr = 44100;
    const off = new OfflineAudioContext(1, sr * 12, sr);
    const notes = [76, 74, 72, 74, 76, 76, 76, 0, 74, 74, 74, 0, 76, 79, 79, 0, 76, 74, 72, 74, 76, 76, 76, 76, 74, 74, 76, 74, 72];
    notes.forEach((n, i) => {
      if (!n) return;
      const t = i * 0.38 + (Math.random() - 0.5) * 0.02;
      const f = 440 * Math.pow(2, (n - 69) / 12) * (1 + (Math.random() - 0.5) * 0.008);
      for (const [mult, amp] of [[1, 0.5], [2.01, 0.18], [4.2, 0.06]]) {
        const o = off.createOscillator();
        o.type = 'sine';
        o.frequency.value = f * mult;
        const g = off.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(amp, t + 0.005);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
        o.connect(g).connect(off.destination);
        o.start(t);
        o.stop(t + 1.7);
      }
    });
    const buf = await off.startRendering();
    this.synth.set('lullaby', buf);
    return buf;
  }

  async lullaby(pos: THREE.Vector3) {
    const buf = await this.lullabyBuffer();
    this.playBufferAt(buf, pos, 1.4, 6);
  }

  shutter() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.12, false);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3200;
    const g = this.ctx.createGain();
    g.gain.value = 0.7;
    src.connect(bp).connect(g).connect(this.master);
    src.start();
  }

  playBufferAt(buf: AudioBuffer, pos: THREE.Vector3, volume = 1, refDistance = 2.5) {
    const holder = new THREE.Object3D();
    holder.position.copy(pos);
    this.scene.add(holder);
    const pa = new THREE.PositionalAudio(this.listener);
    pa.panner.panningModel = 'HRTF';
    pa.setBuffer(buf);
    pa.setRefDistance(refDistance);
    pa.setVolume(volume);
    holder.add(pa);
    pa.play();
    pa.source!.onended = () => {
      holder.remove(pa);
      this.scene.remove(holder);
    };
  }

  /** the browser's own voice, slowed and lowered, speaks a real player's name */
  speak(text: string, opts: { pitch?: number; rate?: number; volume?: number } = {}) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.pitch = opts.pitch ?? 0.1;
    u.rate = opts.rate ?? 0.62;
    u.volume = opts.volume ?? 0.55;
    speechSynthesis.speak(u);
  }
}
