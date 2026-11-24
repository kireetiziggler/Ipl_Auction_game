class StadiumAudioService {
  private ctx: AudioContext | null = null;
  private sfxEnabled = true;
  private musicEnabled = false;
  private masterVolume = 0.8;
  private sfxVolume = 0.85;
  private musicVolume = 0.3;
  private ambientInterval: number | null = null;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      try {
        this.ctx = new AudioCtx();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  unlock(): void {
    this.ensureContext();
  }

  configure(opts: {
    sfxEnabled?: boolean;
    musicEnabled?: boolean;
    masterVolume?: number;
    sfxVolume?: number;
    musicVolume?: number;
  }): void {
    if (opts.sfxEnabled !== undefined) this.sfxEnabled = opts.sfxEnabled;
    if (opts.masterVolume !== undefined) this.masterVolume = opts.masterVolume;
    if (opts.sfxVolume !== undefined) this.sfxVolume = opts.sfxVolume;
    if (opts.musicVolume !== undefined) this.musicVolume = opts.musicVolume;
    if (opts.musicEnabled !== undefined) {
      this.musicEnabled = opts.musicEnabled;
      if (this.musicEnabled) {
        this.startAmbientLoop();
      } else {
        this.stopAmbientLoop();
      }
    }
  }

  private gainLevel(): number {
    return Math.max(0.01, this.masterVolume * this.sfxVolume);
  }

  playBid(isUser = true): void {
    if (!this.sfxEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = isUser ? 'triangle' : 'sine';
    const baseFreq = isUser ? 587.33 : 493.88; // D5 vs B4
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.25, now + 0.09);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18 * this.gainLevel(), now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  playCountdownTick(urgent = false): void {
    if (!this.sfxEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(urgent ? 880 : 620, now);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime((urgent ? 0.16 : 0.09) * this.gainLevel(), now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  playSoldGavel(): void {
    if (!this.sfxEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    // Double wooden gavel thump + bright championship chord
    [0, 0.16].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(160, now + offset);
      osc.frequency.exponentialRampToValueAtTime(48, now + offset + 0.12);
      gain.gain.setValueAtTime(0.32 * this.gainLevel(), now + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.15);
    });

    // Warm celebratory triad shimmer
    [523.25, 659.25, 783.99].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + 0.24 + idx * 0.03);
      gain.gain.setValueAtTime(0.001, now + 0.24 + idx * 0.03);
      gain.gain.linearRampToValueAtTime(0.11 * this.gainLevel(), now + 0.28 + idx * 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.82);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + 0.24 + idx * 0.03);
      osc.stop(now + 0.85);
    });
  }

  playUnsold(): void {
    if (!this.sfxEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.linearRampToValueAtTime(155, now + 0.28);

    gain.gain.setValueAtTime(0.09 * this.gainLevel(), now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  playVictoryFanfare(): void {
    if (!this.sfxEnabled) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((freq, i) => {
      const start = now + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(0.16 * this.gainLevel(), start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.55);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.6);
    });
  }

  private startAmbientLoop(): void {
    if (typeof window === 'undefined' || this.ambientInterval !== null) return;
    const pulse = () => {
      if (!this.musicEnabled) return;
      const ctx = this.ensureContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const chord = [130.81, 196.0, 246.94];
      chord.forEach((freq) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        const vol = 0.028 * this.masterVolume * this.musicVolume;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.linearRampToValueAtTime(vol, now + 1.2);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 3.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 3.5);
      });
    };
    pulse();
    this.ambientInterval = window.setInterval(pulse, 3600);
  }

  stopAmbientLoop(): void {
    if (this.ambientInterval !== null) {
      window.clearInterval(this.ambientInterval);
      this.ambientInterval = null;
    }
  }
}

export const audioService = new StadiumAudioService();
