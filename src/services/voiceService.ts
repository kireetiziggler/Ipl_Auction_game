import { formatSpokenPrice } from '../data/rulesets';

export type AnnouncementPriority = 'HIGH' | 'NORMAL' | 'LOW';

export interface AnnounceCallbacks {
  onStart?: () => void;
  onEnd?: () => void;
}

export interface AnnounceOptions {
  /** When true (e.g. SOLD / UNSOLD), subsequent announcements queue cleanly behind this sentence instead of cutting it off mid-word. */
  protectCompletion?: boolean;
}

interface QueuedAnnouncement {
  text: string;
  priority: AnnouncementPriority;
  token: number;
  callbacks?: AnnounceCallbacks;
  protectCompletion?: boolean;
}

const FRANCHISE_SPOKEN_NAMES: Record<string, string> = {
  CSK: 'Chennai Super Kings',
  MI: 'Mumbai Indians',
  RCB: 'Royal Challengers Bengaluru',
  KKR: 'Kolkata Knight Riders',
  SRH: 'Sunrisers Hyderabad',
  RR: 'Rajasthan Royals',
  DC: 'Delhi Capitals',
  PBKS: 'Punjab Kings',
  GT: 'Gujarat Titans',
  LSG: 'Lucknow Super Giants',
};

/**
 * Guarantees broadcast-perfect Indian English auctioneer pronunciation.
 * - Converts any "₹5.50 Cr" / "₹75 L" / "2 Cr" into "5 crore 50 lakhs" / "75 lakhs" / "2 crores".
 * - Expands franchise codes (CSK -> Chennai Super Kings, MI -> Mumbai Indians, etc.) and RTM/IPL
 *   so neural & mobile voices never spell awkward abbreviations.
 */
export function sanitizeForAuctionSpeech(raw: string): string {
  let text = raw;
  text = text.replace(/₹?\s*(\d+(?:\.\d+)?)\s*(?:Cr\.?|crores?)\b/gi, (_m, num) =>
    formatSpokenPrice(parseFloat(num))
  );
  text = text.replace(/₹?\s*(\d+(?:\.\d+)?)\s*L\b/g, (_m, num) => {
    const val = Math.round(parseFloat(num));
    return val === 1 ? '1 lakh' : `${val} lakhs`;
  });

  // Expand franchise codes so mobile & neural TTS always pronounce full team names clearly
  text = text.replace(
    /\b(CSK|MI|RCB|KKR|SRH|RR|DC|PBKS|GT|LSG)\b/g,
    (code) => FRANCHISE_SPOKEN_NAMES[code] ?? code
  );

  // Smooth pronunciation of cricket auction terms
  text = text.replace(/\bRTM\b/g, 'Right to Match');
  text = text.replace(/\bXI\b/g, 'Eleven');
  text = text.replace(/\bIPL\b/g, 'I P L');
  text = text.replace(/₹/g, '').replace(/\s+/g, ' ').trim();
  return text;
}

class AuctioneerVoiceService {
  private volume = 0.95;
  private selectedFallbackVoice: SpeechSynthesisVoice | null = null;
  private queue: QueuedAnnouncement[] = [];
  private isSpeaking = false;
  private currentIsProtected = false;
  private unlocked = false;

  // Mobile-proof audio playback: WebAudio AudioContext + reusable unlocked HTMLAudioElement
  private audioCtx: AudioContext | null = null;
  private currentBufferSource: AudioBufferSourceNode | null = null;
  private sharedAudioEl: HTMLAudioElement | null = null;
  private currentBlobUrl: string | null = null;
  private currentAbort: AbortController | null = null;
  private generationToken = 0;

  // Cache raw MP3 ArrayBuffers so WebAudio decodes with zero network latency on repeat phrases
  private audioBytesCache = new Map<string, { bytes: ArrayBuffer; mimeType: string }>();
  private inflightPreloads = new Map<string, Promise<{ bytes: ArrayBuffer; mimeType: string } | null>>();
  private captionListeners = new Set<(text: string) => void>();
  private ttsServerDisabled = false;

  constructor() {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      const loadVoices = () => {
        const voices = window.speechSynthesis.getVoices();
        if (!voices.length) return;
        const scoreVoice = (v: SpeechSynthesisVoice): number => {
          const name = v.name.toLowerCase();
          const lang = v.lang.toLowerCase();
          let score = 0;
          if (lang.includes('en-in')) score += 60;
          else if (lang.includes('en-gb')) score += 35;
          else if (lang.includes('en-au') || lang.includes('en-us')) score += 20;
          else if (lang.startsWith('en')) score += 10;

          if (
            /female|neerja|heera|veena|aditi|raveena|priya|kavya|samantha|victoria|karen|moira|tessa|serena|aria|jenny|zira|google uk english female/.test(
              name
            )
          ) {
            score += 45;
          }
          if (/natural|neural|google|enhanced|premium/.test(name)) score += 25;
          if (/male|rishi|daniel|alex|david|mark|prabhat/.test(name)) score -= 45;
          return score;
        };
        const sorted = [...voices].sort((a, b) => scoreVoice(b) - scoreVoice(a));
        this.selectedFallbackVoice = sorted[0] ?? null;
      };
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    if (typeof window !== 'undefined') {
      const autoUnlock = () => {
        this.unlock();
      };
      window.addEventListener('pointerdown', autoUnlock, { passive: true });
      window.addEventListener('touchstart', autoUnlock, { passive: true });
      window.addEventListener('keydown', autoUnlock, { passive: true });
    }
  }

  /**
   * Unlocks WebAudio AudioContext & a reusable HTMLAudioElement inside a user gesture
   * so iOS Safari & Android Chrome play studio MP3 audio even from async WebSocket events.
   */
  unlock(): void {
    this.unlocked = true;
    if (typeof window === 'undefined') return;

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        if (!this.audioCtx) {
          this.audioCtx = new AudioCtx();
        }
        if (this.audioCtx.state === 'suspended') {
          void this.audioCtx.resume().catch(() => {});
        }
        // Play a 1-sample silent buffer to firmly unlock iOS/Android WebAudio pipeline
        const silentBuf = this.audioCtx.createBuffer(1, 1, 22050);
        const src = this.audioCtx.createBufferSource();
        src.buffer = silentBuf;
        src.connect(this.audioCtx.destination);
        src.start(0);
      }
    } catch {
      // Ignore if AudioContext unavailable
    }

    if (!this.sharedAudioEl) {
      try {
        const el = new Audio();
        el.setAttribute('playsinline', 'true');
        el.preload = 'auto';
        this.sharedAudioEl = el;
      } catch {
        // Ignore
      }
    }
  }

  isCurrentlySpeaking(): boolean {
    return this.isSpeaking || this.queue.length > 0;
  }

  configure(opts: { volume?: number }): void {
    if (opts.volume !== undefined) {
      this.volume = Math.max(0.2, Math.min(1, opts.volume));
      if (this.sharedAudioEl) {
        this.sharedAudioEl.volume = this.volume;
      }
    }
  }

  onCaption(listener: (text: string) => void): () => void {
    this.captionListeners.add(listener);
    return () => {
      this.captionListeners.delete(listener);
    };
  }

  private emitCaption(text: string): void {
    this.captionListeners.forEach((cb) => {
      try {
        cb(text);
      } catch {
        // Never disrupt auction gameplay
      }
    });
  }

  /**
   * Silently pre-fetches studio female neural TTS audio for an upcoming phrase (e.g. the next player lot)
   * so when the lot begins, audio plays instantaneously with zero network lag.
   */
  preload(rawText: string): void {
    if (this.ttsServerDisabled || typeof window === 'undefined') return;
    const text = sanitizeForAuctionSpeech(rawText);
    if (!text) return;
    const cacheKey = text.toLowerCase();
    if (this.audioBytesCache.has(cacheKey) || this.inflightPreloads.has(cacheKey)) return;

    const task = this.fetchAudioBytes(text).finally(() => {
      this.inflightPreloads.delete(cacheKey);
    });
    this.inflightPreloads.set(cacheKey, task);
  }

  cancelActive(): void {
    this.generationToken += 1;
    this.queue = [];
    this.isSpeaking = false;
    this.currentIsProtected = false;

    if (this.currentAbort) {
      try {
        this.currentAbort.abort();
      } catch {
        // ignore
      }
      this.currentAbort = null;
    }

    if (this.currentBufferSource) {
      try {
        this.currentBufferSource.onended = null;
        this.currentBufferSource.stop();
        this.currentBufferSource.disconnect();
      } catch {
        // ignore
      }
      this.currentBufferSource = null;
    }

    if (this.sharedAudioEl) {
      try {
        this.sharedAudioEl.onended = null;
        this.sharedAudioEl.onerror = null;
        this.sharedAudioEl.pause();
        this.sharedAudioEl.currentTime = 0;
      } catch {
        // ignore
      }
    }

    if (this.currentBlobUrl) {
      try {
        URL.revokeObjectURL(this.currentBlobUrl);
      } catch {
        // ignore
      }
      this.currentBlobUrl = null;
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
  }

  stopAll(): void {
    this.cancelActive();
  }

  announce(
    rawText: string,
    priority: AnnouncementPriority = 'HIGH',
    callbacks?: AnnounceCallbacks,
    options?: AnnounceOptions
  ): void {
    const text = sanitizeForAuctionSpeech(rawText);
    if (!text) return;

    this.emitCaption(text);
    if (!this.unlocked || typeof window === 'undefined') return;

    // NEVER cut off a protected SOLD / UNSOLD sentence mid-word!
    // Instead, queue the new announcement right after it finishes cleanly.
    if (this.isSpeaking && this.currentIsProtected && !options?.protectCompletion) {
      const token = this.generationToken;
      this.queue = [{ text, priority, token, callbacks, protectCompletion: false }];
      // Pre-fetch the queued phrase immediately so it starts seamlessly the instant SOLD finishes
      this.preload(text);
      return;
    }

    if (priority === 'HIGH') {
      this.cancelActive();
      const token = this.generationToken;
      this.queue = [
        {
          text,
          priority,
          token,
          callbacks,
          protectCompletion: options?.protectCompletion,
        },
      ];
      void this.flush();
      return;
    }

    const token = this.generationToken;
    this.queue = [
      ...this.queue.slice(-1),
      {
        text,
        priority,
        token,
        callbacks,
        protectCompletion: options?.protectCompletion,
      },
    ];
    if (!this.isSpeaking) {
      void this.flush();
    }
  }

  private async fetchAudioBytes(
    text: string,
    signal?: AbortSignal
  ): Promise<{ bytes: ArrayBuffer; mimeType: string } | null> {
    if (this.ttsServerDisabled) return null;
    const cacheKey = text.toLowerCase();
    const cached = this.audioBytesCache.get(cacheKey);
    if (cached) return cached;

    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal,
      });

      if (res.status === 503) {
        this.ttsServerDisabled = true;
        return null;
      }
      if (!res.ok) return null;

      const data = (await res.json()) as { audioBase64?: string; mimeType?: string };
      if (!data.audioBase64) return null;

      const binary = atob(data.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      const entry = {
        bytes: bytes.buffer,
        mimeType: data.mimeType || 'audio/mpeg',
      };

      if (this.audioBytesCache.size >= 110) {
        const oldestKey = this.audioBytesCache.keys().next().value;
        if (oldestKey) this.audioBytesCache.delete(oldestKey);
      }
      this.audioBytesCache.set(cacheKey, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private async flush(): Promise<void> {
    if (this.isSpeaking || this.queue.length === 0) return;
    const item = this.queue.shift()!;
    if (item.token !== this.generationToken) {
      void this.flush();
      return;
    }

    this.isSpeaking = true;
    this.currentIsProtected = Boolean(item.protectCompletion);

    try {
      const playedStudio = await this.playStudioFemaleVoice(item.text, item.token, item.callbacks);
      if (!playedStudio && item.token === this.generationToken) {
        await this.playFallbackSpeech(item.text, item.token, item.callbacks);
      }
    } catch {
      // Never block auction state on audio failure
    } finally {
      if (item.token === this.generationToken) {
        this.isSpeaking = false;
        this.currentIsProtected = false;
        item.callbacks?.onEnd?.();
        if (this.queue.length > 0) {
          void this.flush();
        }
      }
    }
  }

  private async playStudioFemaleVoice(
    text: string,
    token: number,
    callbacks?: AnnounceCallbacks
  ): Promise<boolean> {
    if (this.ttsServerDisabled) return false;
    const cacheKey = text.toLowerCase();

    let entry = this.audioBytesCache.get(cacheKey) ?? null;
    if (!entry) {
      const inflight = this.inflightPreloads.get(cacheKey);
      if (inflight) {
        entry = await inflight;
      }
    }

    if (!entry && token === this.generationToken) {
      const controller = new AbortController();
      this.currentAbort = controller;
      const timeout = window.setTimeout(() => controller.abort(), 6500);
      try {
        entry = await this.fetchAudioBytes(text, controller.signal);
      } finally {
        window.clearTimeout(timeout);
        if (this.currentAbort === controller) {
          this.currentAbort = null;
        }
      }
    }

    if (!entry || token !== this.generationToken) return false;

    // Path A: Mobile-Proof WebAudio AudioContext playback (immune to iOS/Android async autoplay blocks)
    if (this.audioCtx) {
      try {
        if (this.audioCtx.state === 'suspended') {
          await this.audioCtx.resume();
        }
        // Slice a copy because decodeAudioData detaches the passed ArrayBuffer
        const copy = entry.bytes.slice(0);
        const decoded = await this.audioCtx.decodeAudioData(copy);
        if (token !== this.generationToken) return true;

        return await new Promise<boolean>((resolve) => {
          if (!this.audioCtx || token !== this.generationToken) {
            resolve(false);
            return;
          }
          const src = this.audioCtx.createBufferSource();
          const gain = this.audioCtx.createGain();
          gain.gain.value = this.volume;
          src.buffer = decoded;
          src.connect(gain);
          gain.connect(this.audioCtx.destination);
          this.currentBufferSource = src;

          let finished = false;
          const finish = (ok: boolean) => {
            if (finished) return;
            finished = true;
            if (this.currentBufferSource === src) {
              this.currentBufferSource = null;
            }
            resolve(ok);
          };

          src.onended = () => finish(true);
          try {
            callbacks?.onStart?.();
            src.start(0);
          } catch {
            finish(false);
          }
        });
      } catch {
        // Fall through cleanly to Path B (<audio>)
      }
    }

    // Path B: Reusable HTMLAudioElement playback
    if (token !== this.generationToken) return false;
    return await new Promise<boolean>((resolve) => {
      const blob = new Blob([entry!.bytes], { type: entry!.mimeType });
      const blobUrl = URL.createObjectURL(blob);
      if (this.currentBlobUrl) {
        try {
          URL.revokeObjectURL(this.currentBlobUrl);
        } catch {
          // ignore
        }
      }
      this.currentBlobUrl = blobUrl;

      const audio = this.sharedAudioEl ?? new Audio();
      this.sharedAudioEl = audio;
      audio.src = blobUrl;
      audio.volume = this.volume;

      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        audio.onplay = null;
        resolve(ok);
      };

      audio.onplay = () => {
        if (token === this.generationToken) {
          callbacks?.onStart?.();
        }
      };
      audio.onended = () => finish(true);
      audio.onerror = () => finish(false);
      audio.play().catch(() => finish(false));
    });
  }

  private playFallbackSpeech(
    text: string,
    token: number,
    callbacks?: AnnounceCallbacks
  ): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        resolve();
        return;
      }
      if (token !== this.generationToken) {
        resolve();
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        if (this.selectedFallbackVoice) {
          utterance.voice = this.selectedFallbackVoice;
          utterance.lang = this.selectedFallbackVoice.lang;
        } else {
          utterance.lang = 'en-IN';
        }
        utterance.volume = this.volume;
        utterance.rate = 0.94;
        utterance.pitch = 1.03;
        utterance.onstart = () => {
          if (token === this.generationToken) {
            callbacks?.onStart?.();
          }
        };
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        window.speechSynthesis.speak(utterance);
      } catch {
        resolve();
      }
    });
  }
}

export const voiceService = new AuctioneerVoiceService();
