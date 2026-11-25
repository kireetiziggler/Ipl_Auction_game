import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { formatSpokenPrice, SEASON_RULESETS } from '../data/rulesets.ts';
import type { AIDifficulty, FranchiseId, NominationMode, Player } from '../engine/types.ts';
import {
  bulkImportCustomPlayers,
  claimFirstRunAdmin,
  getAdminStatus,
  getMergedPlayerMap,
  getMergedPlayers,
  loginAdmin,
  upsertCustomPlayer,
} from './adminService.ts';
import {
  AuthError,
  authenticateSessionToken,
  createGuestSession,
  exchangeFirebaseIdToken,
  loginUser,
  refreshSessionToken,
  registerUser,
  revokeSessionToken,
  updateSessionProfile,
  type AuthenticatedSession,
} from './authService.ts';
import {
  clearSessionCookie,
  extractAdminToken,
  extractSessionToken,
  getClientIp,
  hashToken,
  isValidFranchiseId,
  normalizeEmail,
  parseCookieHeader,
  passesCsrfCheck,
  sanitizeText,
  SERVER_CONFIG,
  setSessionCookie,
} from './config.ts';
import { RoomPubSubListener } from './pubsub.ts';
import { checkPersistentRateLimit } from './rateLimitService.ts';
import {
  createMultiplayerRoom,
  executeRoomAction,
  getActiveRoomsCount,
  getRoomByCode,
  joinOrReconnectRoom,
  markParticipantDisconnected,
  RoomError,
  updateParticipantHeartbeat,
  type CommittedRoomMutation,
  type RoomActionPayload,
} from './roomRepository.ts';
import { AuctionSchedulerWorker } from './schedulerWorker.ts';

interface SocketEntry {
  ws: WebSocket;
  socketId: string;
  session: AuthenticatedSession;
  franchiseId: FranchiseId;
  isAlive: boolean;
}

export interface ArenaServerHandle {
  app: express.Express;
  httpServer: http.Server;
  wss: WebSocketServer;
  scheduler: AuctionSchedulerWorker;
  pubsub: RoomPubSubListener;
  startBackgroundWorkers: () => void;
  shutdown: () => Promise<void>;
}

export interface CreateArenaServerOptions {
  enableViteMiddleware?: boolean;
  enableBackgroundWorkers?: boolean;
}

export async function createArenaServer(
  options: CreateArenaServerOptions = {}
): Promise<ArenaServerHandle> {
  const enableVite = options.enableViteMiddleware ?? false;
  const DATA_DIR = path.resolve(process.cwd(), 'data');

  const app = express();
  app.set('trust proxy', SERVER_CONFIG.TRUST_PROXY_HOPS);
  app.use(express.json({ limit: '2mb' }));

  // Baseline security headers (preserving iframe compatibility for preview environments)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-XSS-Protection', '0');
    next();
  });

  // ---- Local WebSocket Transport Registry (Authoritative state lives in PostgreSQL) ----
  const localRoomSockets = new Map<string, Map<string, SocketEntry>>(); // roomCode -> (sessionId -> SocketEntry)

  function broadcastToLocalRoom(
    roomCode: string,
    eventType: string,
    state: unknown,
    stateVersion: number,
    extra?: Record<string, unknown>
  ): void {
    const sockets = localRoomSockets.get(roomCode);
    if (!sockets || sockets.size === 0) return;
    const payload = JSON.stringify({
      type: eventType,
      serverTime: Date.now(),
      stateVersion,
      state,
      ...extra,
    });
    for (const entry of sockets.values()) {
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(payload);
      }
    }
  }

  function broadcastMutation(mutation: CommittedRoomMutation): void {
    broadcastToLocalRoom(
      mutation.roomCode,
      mutation.eventType,
      mutation.state,
      mutation.stateVersion
    );
  }

  // ---- Health & Public Catalog Routes ----
  app.get('/api/health', async (_req, res) => {
    try {
      const [roomsActive, players] = await Promise.all([
        getActiveRoomsCount(),
        getMergedPlayers(),
      ]);
      res.json({
        ok: true,
        roomsActive,
        playersCount: players.length,
        instanceId: SERVER_CONFIG.INSTANCE_ID,
      });
    } catch {
      res.status(503).json({ ok: false, error: 'Database unavailable.' });
    }
  });

  app.get('/api/players', async (_req, res) => {
    try {
      const players = await getMergedPlayers();
      res.json({ players, rulesets: SEASON_RULESETS });
    } catch (error) {
      console.error('[API] GET /api/players failed:', error);
      res.status(500).json({ error: 'Could not load player catalog.' });
    }
  });

  // ---- Studio Female Auctioneer Voice (Optional ElevenLabs + Built-In Indian Female Neural Studio Voice) ----
  const ttsCache = new Map<string, { audioBase64: string; mimeType: string }>();
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY?.trim();
  const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || '21m00Tcm4TlvDq8ikWAM';

  const SERVER_FRANCHISE_SPOKEN: Record<string, string> = {
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

  function normalizeTtsText(raw: string): string {
    let t = sanitizeText(raw, 280);
    t = t.replace(/₹?\s*(\d+(?:\.\d+)?)\s*(?:Cr\.?|crores?)\b/gi, (_m, num) =>
      formatSpokenPrice(parseFloat(num))
    );
    t = t.replace(/₹?\s*(\d+(?:\.\d+)?)\s*L\b/g, (_m, num) => {
      const val = Math.round(parseFloat(num));
      return val === 1 ? '1 lakh' : `${val} lakhs`;
    });
    t = t.replace(
      /\b(CSK|MI|RCB|KKR|SRH|RR|DC|PBKS|GT|LSG)\b/g,
      (code) => SERVER_FRANCHISE_SPOKEN[code] ?? code
    );
    t = t.replace(/\bRTM\b/g, 'Right to Match');
    t = t.replace(/\bXI\b/g, 'Eleven');
    t = t.replace(/\bIPL\b/g, 'I P L');
    t = t.replace(/₹/g, '').replace(/\s+/g, ' ').trim();
    return t;
  }

  async function synthesizeElevenLabs(
    text: string
  ): Promise<{ audioBase64: string; mimeType: string } | null> {
    if (!elevenLabsApiKey || elevenLabsApiKey === 'MY_ELEVENLABS_API_KEY') return null;
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(elevenLabsVoiceId)}`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': elevenLabsApiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.46,
              similarity_boost: 0.82,
              style: 0.35,
              use_speaker_boost: true,
            },
          }),
          signal: AbortSignal.timeout(8000),
        }
      );
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) return null;
      return { audioBase64: buf.toString('base64'), mimeType: 'audio/mpeg' };
    } catch {
      return null;
    }
  }

  async function synthesizeNeuralIndianFemale(
    text: string
  ): Promise<{ audioBase64: string; mimeType: string } | null> {
    const voices = ['en-IN-NeerjaExpressiveNeural', 'en-IN-NeerjaNeural', 'en-GB-SoniaNeural'];
    for (const voice of voices) {
      const tts = new MsEdgeTTS();
      try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text, { rate: '-4%', pitch: '+1Hz' });
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Neural TTS timeout')), 7500);
          audioStream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
          audioStream.on('end', () => {
            clearTimeout(timeout);
            resolve();
          });
          audioStream.on('error', (err: Error) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
        const buf = Buffer.concat(chunks);
        if (buf.length > 512) {
          return { audioBase64: buf.toString('base64'), mimeType: 'audio/mpeg' };
        }
      } catch (err) {
        console.warn(`[TTS] ${voice} fallback:`, err instanceof Error ? err.message : err);
      } finally {
        try {
          tts.close();
        } catch {
          // ignore
        }
      }
    }
    return null;
  }

  app.post('/api/tts', async (req, res) => {
    const ip = getClientIp(req);
    const rl = await checkPersistentRateLimit(`tts:${ip}`, 120, 60_000);
    if (!rl.allowed) {
      return res.status(429).json({ error: 'TTS rate limit reached.' });
    }
    const text = normalizeTtsText(req.body?.text);
    if (!text) {
      return res.status(400).json({ error: 'Text is required.' });
    }

    const cacheKey = text.toLowerCase();
    const cached = ttsCache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      const result =
        (await synthesizeElevenLabs(text)) ?? (await synthesizeNeuralIndianFemale(text));

      if (!result) {
        return res.status(502).json({ error: 'TTS synthesis failed.' });
      }

      if (ttsCache.size >= 300) {
        const firstKey = ttsCache.keys().next().value;
        if (firstKey) ttsCache.delete(firstKey);
      }
      ttsCache.set(cacheKey, result);
      return res.json(result);
    } catch (err) {
      console.error('[TTS] synthesis error:', err instanceof Error ? err.message : err);
      return res.status(502).json({ error: 'TTS synthesis failed.' });
    }
  });

  // ---- Zero-Mismatch Official IPL Transparent Cutout PNG + Verified Portrait Proxy ----
  const PHOTO_CACHE_DIR = path.join(DATA_DIR, 'photo-cache-v2');
  const missingPhotoCache = new Set<string>();
  const inflightPhotos = new Map<
    string,
    Promise<{ filePath: string; contentType: string; isCutout: boolean } | null>
  >();

  const IPL_SLUG_ALIASES: Record<string, string> = {
    'ms-dhoni': 'mahendra-singh-dhoni',
    'mitchell-marsh': 'mitch-marsh',
    't-natarajan': 'thangarasu-natarajan',
    'rasikh-salam': 'rasikh-dar',
    'sediqullah-atal': 'sediq-atal',
    'mitchell-santner': 'mitch-santner',
    'kusal-perera': 'mathurage-don-kusal-janith-perera-16500',
    'vaibhav-suryavanshi': 'vaibhav-sooryavanshi',
    'harnoor-pannu': 'harnoor-singh',
    'kunal-singh-rathore': 'kunal-rathore',
    'vyshak-vijaykumar': 'vijaykumar-vyshak',
    'shreyas-iyer-spin-alt': 'praveen-dubey',
  };

  let iplPlayerSitemapMap: Map<string, string> | null = null;
  let iplSitemapLoadPromise: Promise<Map<string, string>> | null = null;

  async function getIplSitemapMap(): Promise<Map<string, string>> {
    if (iplPlayerSitemapMap) return iplPlayerSitemapMap;
    if (iplSitemapLoadPromise) return iplSitemapLoadPromise;

    iplSitemapLoadPromise = (async () => {
      const map = new Map<string, string>();
      try {
        const res = await fetch('https://www.iplt20.com/sitemaps/players-0.xml', {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IPLAuctionArena/2.0)' },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const xml = await res.text();
          const locs = [
            ...xml.matchAll(/<loc>(https:\/\/www\.iplt20\.com\/players\/[^/]+\/[^/<]+)<\/loc>/g),
          ].map((m) => m[1]);
          for (const url of locs) {
            const slug = url.split('/').pop()!.toLowerCase();
            if (!map.has(slug)) map.set(slug, url);
            const clean = slug.replace(/-\d+$/, '');
            if (!map.has(clean)) map.set(clean, url);
          }
        }
      } catch (err) {
        console.warn(
          '[Photo] Could not load official IPL sitemap:',
          err instanceof Error ? err.message : err
        );
      }
      if (map.size > 0) {
        iplPlayerSitemapMap = map;
      }
      iplSitemapLoadPromise = null;
      return map;
    })();

    return iplSitemapLoadPromise;
  }

  const BLOCKED_WIKI_IMAGE_TERMS = [
    'prime_minister',
    'narendra_modi',
    'pmo_',
    'flag_of_',
    'stadium',
    'ground',
    'pitch',
    'trophy',
    'crest',
    'logo',
    'emblem',
    'silhouette',
    'no_image',
    'map_of_',
    'coat_of_arms',
  ];

  function normalizeTitle(s: string): string {
    return s
      .toLowerCase()
      .replace(/\s*\(cricketer\)\s*/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  async function resolveAndCachePlayerPhoto(
    player: Player
  ): Promise<{ filePath: string; contentType: string; isCutout: boolean } | null> {
    const safeId = player.id.replace(/[^a-z0-9-]/gi, '');
    if (!safeId) return null;

    const cachedFile = path.join(PHOTO_CACHE_DIR, `${safeId}.img`);
    const cachedMetaFile = path.join(PHOTO_CACHE_DIR, `${safeId}.meta.json`);
    if (fs.existsSync(cachedFile) && fs.existsSync(cachedMetaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(cachedMetaFile, 'utf-8')) as {
          contentType: string;
          isCutout: boolean;
        };
        return { filePath: cachedFile, contentType: meta.contentType, isCutout: meta.isCutout };
      } catch {
        // Re-fetch if metadata corrupted
      }
    }
    if (missingPhotoCache.has(safeId)) return null;

    const existing = inflightPhotos.get(safeId);
    if (existing) return existing;

    const task = (async (): Promise<{
      filePath: string;
      contentType: string;
      isCutout: boolean;
    } | null> => {
      const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; IPLAuctionArena/2.0)' };
      const writeCached = (buf: Buffer, contentType: string, isCutout: boolean) => {
        if (!fs.existsSync(PHOTO_CACHE_DIR)) {
          fs.mkdirSync(PHOTO_CACHE_DIR, { recursive: true });
        }
        fs.writeFileSync(cachedFile, buf);
        fs.writeFileSync(cachedMetaFile, JSON.stringify({ contentType, isCutout }), 'utf-8');
        return { filePath: cachedFile, contentType, isCutout };
      };

      try {
        const sitemap = await getIplSitemapMap();
        const nameSlug = player.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        const aliasSlug = IPL_SLUG_ALIASES[player.id];
        const profileUrl =
          (aliasSlug ? sitemap.get(aliasSlug) : undefined) ??
          sitemap.get(nameSlug) ??
          sitemap.get(player.id);

        if (profileUrl) {
          try {
            const pRes = await fetch(profileUrl, { headers, signal: AbortSignal.timeout(6000) });
            if (pRes.ok) {
              const html = await pRes.text();
              const raw = html.replace(/\\"/g, '"');
              const pngMatch = raw.match(/pathname=(player(?:\/|%2F|%252F)[^&"'\s]+\.png)/);
              if (pngMatch) {
                const assetPath = decodeURIComponent(decodeURIComponent(pngMatch[1]));
                if (/^player\/\d+\/\d+\/\d+\.png$/.test(assetPath)) {
                  const assetUrl = `https://www.iplt20.com/api/team-assets?pathname=${encodeURIComponent(
                    assetPath
                  )}&brand=ipl`;
                  const imgRes = await fetch(assetUrl, {
                    headers,
                    signal: AbortSignal.timeout(7000),
                  });
                  const ct = (imgRes.headers.get('content-type') || '').toLowerCase();
                  if (
                    imgRes.ok &&
                    (ct.startsWith('image/png') ||
                      ct.startsWith('image/jpeg') ||
                      ct.startsWith('image/webp'))
                  ) {
                    const buf = Buffer.from(await imgRes.arrayBuffer());
                    if (buf.length >= 4000 && buf.length <= 6 * 1024 * 1024) {
                      return writeCached(buf, ct.split(';')[0], ct.startsWith('image/png'));
                    }
                  }
                }
              }
            }
          } catch {
            // Fall through cleanly to Tier 2 exact-title verification
          }
        }

        const wikiHeaders = {
          'User-Agent': 'IPLAuctionArena/2.0 (https://github.com/ipl-auction-arena)',
        };
        const expectedNorm = normalizeTitle(player.name);
        const exactTitles = [player.name, `${player.name} (cricketer)`];
        let thumbUrl: string | null = null;

        for (const title of exactTitles) {
          const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
            title.replace(/ /g, '_')
          )}`;
          const sumRes = await fetch(summaryUrl, {
            headers: wikiHeaders,
            signal: AbortSignal.timeout(4500),
          });
          if (!sumRes.ok) continue;
          const sumData = (await sumRes.json()) as {
            title?: string;
            description?: string;
            extract?: string;
            thumbnail?: { source?: string };
          };
          const titleNorm = normalizeTitle(sumData.title || '');
          const desc = `${sumData.description || ''} ${sumData.extract || ''}`.toLowerCase();
          const candidateImg = sumData.thumbnail?.source || '';
          const lowerImg = candidateImg.toLowerCase();

          if (
            titleNorm === expectedNorm &&
            desc.includes('cricket') &&
            candidateImg &&
            !BLOCKED_WIKI_IMAGE_TERMS.some((bad) => lowerImg.includes(bad))
          ) {
            thumbUrl = candidateImg;
            break;
          }
        }

        if (!thumbUrl) {
          missingPhotoCache.add(safeId);
          return null;
        }

        const ALLOWED_WIKI_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
        const parsed = new URL(thumbUrl);
        if (parsed.protocol !== 'https:' || !ALLOWED_WIKI_HOSTS.has(parsed.hostname)) {
          missingPhotoCache.add(safeId);
          return null;
        }

        const imgRes = await fetch(parsed.toString(), {
          headers: wikiHeaders,
          signal: AbortSignal.timeout(5000),
        });
        if (!imgRes.ok) {
          missingPhotoCache.add(safeId);
          return null;
        }
        const contentType = (imgRes.headers.get('content-type') || '').toLowerCase();
        if (
          !contentType.startsWith('image/jpeg') &&
          !contentType.startsWith('image/png') &&
          !contentType.startsWith('image/webp')
        ) {
          missingPhotoCache.add(safeId);
          return null;
        }
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.length < 2000 || buf.length > 5 * 1024 * 1024) {
          missingPhotoCache.add(safeId);
          return null;
        }

        return writeCached(buf, contentType.split(';')[0], false);
      } catch {
        missingPhotoCache.add(safeId);
        return null;
      } finally {
        inflightPhotos.delete(safeId);
      }
    })();

    inflightPhotos.set(safeId, task);
    return task;
  }

  app.get('/api/player-photo/:id', async (req, res) => {
    const id = sanitizeText(req.params.id, 80);
    const playerMap = await getMergedPlayerMap();
    const player = playerMap[id];
    if (!player) {
      return res.status(404).end();
    }
    const resolved = await resolveAndCachePlayerPhoto(player);
    if (!resolved || !fs.existsSync(resolved.filePath)) {
      return res.status(404).end();
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.setHeader('Content-Type', resolved.contentType || 'image/png');
    res.setHeader('X-Photo-Cutout', resolved.isCutout ? '1' : '0');
    return res.sendFile(resolved.filePath);
  });

  // ---- Authentication & Session Routes (PostgreSQL-backed) ----
  app.post('/api/auth/register', async (req, res) => {
    const ip = getClientIp(req);
    const rl = await checkPersistentRateLimit(
      `auth:register:${ip}`,
      15,
      SERVER_CONFIG.RATE_LIMIT_WINDOW_MS,
      { failClosed: true }
    );
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many registration requests. Please wait a minute.' });
    }
    try {
      const result = await registerUser({
        email: req.body?.email,
        username: req.body?.username,
        password: req.body?.password,
        favoriteFranchise: req.body?.favoriteFranchise,
        deviceInfo: req.headers['user-agent'],
      });
      setSessionCookie(req, res, SERVER_CONFIG.SESSION_COOKIE_NAME, result.token, result.expiresAt);
      return res.status(201).json({
        token: result.token,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt.toISOString(),
        isGuest: false,
        profile: result.profile,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Registration failed.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const ip = getClientIp(req);
    const ipRl = await checkPersistentRateLimit(
      `auth:login:ip:${ip}`,
      20,
      SERVER_CONFIG.RATE_LIMIT_WINDOW_MS,
      { failClosed: true }
    );
    if (!ipRl.allowed) {
      return res.status(429).json({ error: 'Too many login attempts. Please wait a minute.' });
    }

    const normEmail = normalizeEmail(req.body?.email);
    if (normEmail) {
      const emailBucket = `auth:login:acct:${hashToken(normEmail).slice(0, 24)}`;
      const emailRl = await checkPersistentRateLimit(emailBucket, 12, 5 * 60_000, {
        failClosed: true,
      });
      if (!emailRl.allowed) {
        return res
          .status(429)
          .json({ error: 'Too many failed attempts for this account. Try again in a few minutes.' });
      }
    }

    try {
      const result = await loginUser({
        email: req.body?.email,
        password: req.body?.password,
        deviceInfo: req.headers['user-agent'],
      });
      setSessionCookie(req, res, SERVER_CONFIG.SESSION_COOKIE_NAME, result.token, result.expiresAt);
      return res.json({
        token: result.token,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt.toISOString(),
        isGuest: false,
        profile: result.profile,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Authentication failed.' });
    }
  });

  app.post('/api/auth/guest', async (req, res) => {
    const ip = getClientIp(req);
    const rl = await checkPersistentRateLimit(
      `auth:guest:${ip}`,
      30,
      SERVER_CONFIG.RATE_LIMIT_WINDOW_MS
    );
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many session requests. Please wait a minute.' });
    }
    try {
      const result = await createGuestSession({
        username: req.body?.username,
        favoriteFranchise: req.body?.favoriteFranchise,
        deviceInfo: req.headers['user-agent'],
      });
      setSessionCookie(req, res, SERVER_CONFIG.SESSION_COOKIE_NAME, result.token, result.expiresAt);
      return res.status(201).json({
        token: result.token,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt.toISOString(),
        isGuest: true,
        profile: result.profile,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Could not create guest session.' });
    }
  });

  app.post('/api/auth/firebase', async (req, res) => {
    const ip = getClientIp(req);
    const rl = await checkPersistentRateLimit(
      `auth:firebase:${ip}`,
      25,
      SERVER_CONFIG.RATE_LIMIT_WINDOW_MS,
      { failClosed: true }
    );
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many authentication attempts.' });
    }
    try {
      const result = await exchangeFirebaseIdToken({
        idToken: req.body?.idToken,
        favoriteFranchise: req.body?.favoriteFranchise,
        deviceInfo: req.headers['user-agent'],
      });
      setSessionCookie(req, res, SERVER_CONFIG.SESSION_COOKIE_NAME, result.token, result.expiresAt);
      return res.json({
        token: result.token,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt.toISOString(),
        isGuest: false,
        profile: result.profile,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Google sign-in sync failed.' });
    }
  });

  app.get('/api/auth/me', async (req, res) => {
    const token = extractSessionToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const session = await authenticateSessionToken(token, ['USER', 'GUEST']);
    if (!session) {
      return res.status(401).json({ error: 'Session expired or revoked.' });
    }
    return res.json({
      sessionId: session.sessionId,
      isGuest: session.isGuest,
      expiresAt: session.expiresAt.toISOString(),
      profile: session.profile,
    });
  });

  app.post('/api/auth/refresh', async (req, res) => {
    if (!passesCsrfCheck(req)) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    const token = extractSessionToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    try {
      const refreshed = await refreshSessionToken(token);
      if (!refreshed) {
        clearSessionCookie(req, res, SERVER_CONFIG.SESSION_COOKIE_NAME);
        return res.status(401).json({ error: 'Session expired or revoked.' });
      }
      setSessionCookie(
        req,
        res,
        SERVER_CONFIG.SESSION_COOKIE_NAME,
        refreshed.token,
        refreshed.expiresAt
      );
      return res.json({
        token: refreshed.token,
        sessionId: refreshed.sessionId,
        expiresAt: refreshed.expiresAt.toISOString(),
        isGuest: refreshed.isGuest,
        profile: refreshed.profile,
      });
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Could not refresh session.' });
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (!passesCsrfCheck(req)) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    const token = extractSessionToken(req);
    if (token) {
      await revokeSessionToken(token);
    }
    clearSessionCookie(req, res, SERVER_CONFIG.SESSION_COOKIE_NAME);
    return res.json({ ok: true });
  });

  app.patch('/api/auth/profile', async (req, res) => {
    if (!passesCsrfCheck(req)) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    const token = extractSessionToken(req);
    const session = await authenticateSessionToken(token, ['USER', 'GUEST']);
    if (!session) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    try {
      const profile = await updateSessionProfile(session, {
        username: req.body?.username,
        favoriteFranchise: req.body?.favoriteFranchise,
      });
      return res.json({ profile });
    } catch (error) {
      if (error instanceof AuthError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Could not update profile.' });
    }
  });

  // ---- Admin Auth & Custom Player Management (PostgreSQL-backed) ----
  app.get('/api/admin/status', async (req, res) => {
    try {
      const status = await getAdminStatus();
      const token = extractAdminToken(req);
      const adminSession = token ? await authenticateSessionToken(token, ['ADMIN']) : null;
      return res.json({
        isClaimed: status.isClaimed,
        authenticated: Boolean(adminSession),
        usingEnvPasscode: status.usingEnvPasscode,
      });
    } catch {
      return res.status(500).json({ error: 'Could not check admin status.' });
    }
  });

  app.post('/api/admin/claim', async (req, res) => {
    const ip = getClientIp(req);
    const rl = await checkPersistentRateLimit(`admin:claim:${ip}`, 5, 5 * 60_000, {
      failClosed: true,
    });
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
    }
    try {
      const result = await claimFirstRunAdmin(req.body?.password, req.headers['user-agent']);
      setSessionCookie(req, res, SERVER_CONFIG.ADMIN_COOKIE_NAME, result.token, result.expiresAt);
      return res.status(201).json({ token: result.token, expiresAt: result.expiresAt.toISOString() });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode || 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : 'Admin setup failed.',
      });
    }
  });

  app.post('/api/admin/login', async (req, res) => {
    const ip = getClientIp(req);
    const rl = await checkPersistentRateLimit(`admin:login:${ip}`, 10, 60_000, {
      failClosed: true,
    });
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' });
    }
    try {
      const result = await loginAdmin(req.body?.password, req.headers['user-agent']);
      setSessionCookie(req, res, SERVER_CONFIG.ADMIN_COOKIE_NAME, result.token, result.expiresAt);
      return res.json({ token: result.token, expiresAt: result.expiresAt.toISOString() });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode || 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : 'Invalid admin password.',
      });
    }
  });

  app.post('/api/admin/logout', async (req, res) => {
    if (!passesCsrfCheck(req)) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    const token = extractAdminToken(req);
    if (token) {
      await revokeSessionToken(token);
    }
    clearSessionCookie(req, res, SERVER_CONFIG.ADMIN_COOKIE_NAME);
    return res.json({ ok: true });
  });

  const requireAdmin: express.RequestHandler = async (req, res, next) => {
    if (!passesCsrfCheck(req)) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    const token = extractAdminToken(req);
    const adminSession = await authenticateSessionToken(token, ['ADMIN']);
    if (!adminSession) {
      return res.status(401).json({ error: 'Admin authorization required.' });
    }
    (req as express.Request & { adminSession?: AuthenticatedSession }).adminSession = adminSession;
    next();
  };

  app.post('/api/admin/players', requireAdmin, async (req, res) => {
    const adminSession = (req as express.Request & { adminSession?: AuthenticatedSession })
      .adminSession;
    const raw = req.body?.player;
    if (!raw || typeof raw !== 'object') {
      return res.status(400).json({ error: 'Player payload is required.' });
    }
    try {
      const result = await upsertCustomPlayer(
        raw as Record<string, unknown>,
        adminSession?.sessionId || 'admin'
      );
      return res.status(201).json(result);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode || 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : 'Could not save player.',
      });
    }
  });

  app.post('/api/admin/players/import', requireAdmin, async (req, res) => {
    const adminSession = (req as express.Request & { adminSession?: AuthenticatedSession })
      .adminSession;
    const rl = await checkPersistentRateLimit(
      `admin:import:${adminSession?.sessionId || getClientIp(req)}`,
      10,
      60_000,
      { failClosed: true }
    );
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many bulk imports. Please wait a minute.' });
    }
    try {
      const result = await bulkImportCustomPlayers(
        req.body?.players,
        adminSession?.sessionId || 'admin'
      );
      return res.json(result);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode || 500;
      return res.status(status).json({
        error: error instanceof Error ? error.message : 'Bulk import failed.',
      });
    }
  });

  // ---- Multiplayer Room REST Endpoints (Authenticated & PostgreSQL-persisted) ----
  app.post('/api/rooms', async (req, res) => {
    if (!passesCsrfCheck(req)) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    const token = extractSessionToken(req);
    const session = await authenticateSessionToken(token, ['USER', 'GUEST']);
    if (!session) {
      return res.status(401).json({
        error: 'Valid session required to create a multiplayer room. Initialize a guest or user session first.',
      });
    }

    const rl = await checkPersistentRateLimit(
      `rooms:create:${session.sessionId}`,
      20,
      SERVER_CONFIG.RATE_LIMIT_WINDOW_MS
    );
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many rooms created. Please wait a minute.' });
    }

    try {
      const created = await createMultiplayerRoom(session, {
        username: req.body?.username,
        franchiseId: req.body?.franchiseId,
        mode: req.body?.mode,
        rulesetId: req.body?.rulesetId,
        customRuleset: req.body?.customRuleset,
        aiDifficulty: req.body?.aiDifficulty,
        nominationMode: req.body?.nominationMode,
        auctionSpeed: req.body?.auctionSpeed,
      });
      return res.status(201).json({
        roomId: created.roomId,
        roomCode: created.roomCode,
        stateVersion: created.stateVersion,
        hostSessionId: session.sessionId,
        franchiseId: created.franchiseId,
        state: created.state,
      });
    } catch (error) {
      if (error instanceof RoomError) {
        return res.status(error.statusCode).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Could not create multiplayer room.' });
    }
  });

  app.get('/api/rooms/:code', async (req, res) => {
    const ip = getClientIp(req);
    const rl = await checkPersistentRateLimit(
      `rooms:get:${ip}`,
      SERVER_CONFIG.RATE_LIMIT_MAX_REQUESTS,
      SERVER_CONFIG.RATE_LIMIT_WINDOW_MS
    );
    if (!rl.allowed) {
      return res.status(429).json({ error: 'Too many requests.' });
    }
    try {
      const room = await getRoomByCode(req.params.code);
      if (!room) {
        return res.status(404).json({ error: 'Room not found or expired.' });
      }
      return res.json({
        roomCode: room.roomCode,
        status: room.status,
        stateVersion: room.stateVersion,
        state: room.state,
      });
    } catch {
      return res.status(500).json({ error: 'Could not load room.' });
    }
  });

  // ---- HTTP & Authenticated WebSocket Server ----
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/auction',
    maxPayload: SERVER_CONFIG.WS_MAX_PAYLOAD_BYTES,
  });

  function parseValidatedAction(msg: Record<string, unknown>): RoomActionPayload | null {
    const type = typeof msg.type === 'string' ? msg.type : '';
    switch (type) {
      case 'lobby:select_franchise':
        if (!isValidFranchiseId(msg.franchiseId)) return null;
        return { type, franchiseId: msg.franchiseId };
      case 'lobby:toggle_ready':
        return { type, ready: typeof msg.ready === 'boolean' ? msg.ready : undefined };
      case 'lobby:update_settings': {
        const s =
          msg.settings && typeof msg.settings === 'object'
            ? (msg.settings as Record<string, unknown>)
            : {};
        return {
          type,
          settings: {
            aiDifficulty:
              typeof s.aiDifficulty === 'string' &&
              ['EASY', 'NORMAL', 'HARD', 'EXPERT'].includes(s.aiDifficulty)
                ? (s.aiDifficulty as AIDifficulty)
                : undefined,
            auctionSpeed:
              typeof s.auctionSpeed === 'string' &&
              ['NORMAL', 'FAST', 'BLITZ'].includes(s.auctionSpeed)
                ? (s.auctionSpeed as 'NORMAL' | 'FAST' | 'BLITZ')
                : undefined,
            rulesetId: typeof s.rulesetId === 'string' ? sanitizeText(s.rulesetId, 40) : undefined,
            nominationMode:
              s.nominationMode === 'SET_ORDER' || s.nominationMode === 'MANAGER_NOMINATION'
                ? (s.nominationMode as NominationMode)
                : undefined,
          },
        };
      }
      case 'lobby:enter_retention':
        return { type };
      case 'retention:confirm': {
        const rawSel =
          msg.selections && typeof msg.selections === 'object'
            ? (msg.selections as Record<string, unknown>)
            : {};
        const cleanSel: Partial<Record<FranchiseId, string[]>> = {};
        for (const [k, v] of Object.entries(rawSel)) {
          if (isValidFranchiseId(k) && Array.isArray(v)) {
            cleanSel[k] = v
              .filter((id): id is string => typeof id === 'string')
              .map((id) => sanitizeText(id, 80))
              .filter(Boolean)
              .slice(0, 10);
          }
        }
        return { type, selections: cleanSel };
      }
      case 'auction:start':
        return { type };
      case 'auction:bid':
        return {
          type,
          amountCr:
            typeof msg.amountCr === 'number' && Number.isFinite(msg.amountCr)
              ? msg.amountCr
              : undefined,
          requestId: typeof msg.requestId === 'string' ? sanitizeText(msg.requestId, 64) : undefined,
        };
      case 'auction:pass':
        return { type };
      case 'auction:rtm_offer':
        return { type, useRtm: Boolean(msg.useRtm) };
      case 'auction:rtm_counter':
        return {
          type,
          counterBidCr:
            typeof msg.counterBidCr === 'number' && Number.isFinite(msg.counterBidCr)
              ? msg.counterBidCr
              : null,
        };
      case 'auction:rtm_final':
        return { type, matchCounter: Boolean(msg.matchCounter) };
      case 'auction:pause':
        return { type };
      case 'auction:resume':
        return { type };
      case 'auction:nominate':
        if (typeof msg.playerId !== 'string' || !msg.playerId.trim()) return null;
        return { type, playerId: sanitizeText(msg.playerId, 80) };
      case 'auction:finish_now':
        return { type };
      default:
        return null;
    }
  }

  wss.on('connection', (ws, req) => {
    const socketId = `sock_${crypto.randomBytes(8).toString('hex')}`;
    const upgradeCookies = parseCookieHeader(req.headers.cookie);
    const cookieToken = upgradeCookies[SERVER_CONFIG.SESSION_COOKIE_NAME] || null;
    const upgradeAuth = req.headers.authorization;
    const headerToken =
      upgradeAuth && upgradeAuth.startsWith('Bearer ') ? upgradeAuth.slice(7).trim() : null;

    let joinedRoomCode: string | null = null;
    let joinedSession: AuthenticatedSession | null = null;
    let alive = true;

    ws.on('pong', () => {
      alive = true;
      if (joinedRoomCode && joinedSession) {
        const entry = localRoomSockets.get(joinedRoomCode)?.get(joinedSession.sessionId);
        if (entry && entry.socketId === socketId) {
          entry.isAlive = true;
        }
        void updateParticipantHeartbeat(joinedRoomCode, joinedSession.sessionId);
      }
    });

    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
        if (Buffer.byteLength(text, 'utf-8') > SERVER_CONFIG.WS_MAX_PAYLOAD_BYTES) {
          ws.send(JSON.stringify({ type: 'error', message: 'Message payload too large.' }));
          return;
        }
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Malformed WebSocket message.' }));
          return;
        }
        msg = parsed as Record<string, unknown>;
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON frame.' }));
        return;
      }

      const msgType = typeof msg.type === 'string' ? msg.type : '';
      if (!msgType) {
        ws.send(JSON.stringify({ type: 'error', message: 'Missing message type.' }));
        return;
      }

      if (msgType === 'ping') {
        alive = true;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
        }
        return;
      }

      if (msgType === 'room:join') {
        const code = sanitizeText(msg.roomCode, 12).toUpperCase();
        if (!code || code.length < 4) {
          ws.send(JSON.stringify({ type: 'error', message: 'Valid roomCode is required.' }));
          return;
        }

        // Authenticate strictly from server-issued session token (explicit token > upgrade header > HttpOnly cookie)
        const candidateToken =
          (typeof msg.token === 'string' && msg.token.length >= 16 ? msg.token : null) ||
          headerToken ||
          cookieToken;

        const session = await authenticateSessionToken(candidateToken, ['USER', 'GUEST']);
        if (!session) {
          ws.send(
            JSON.stringify({
              type: 'auth:error',
              code: 'UNAUTHORIZED',
              message: 'Authentication required. Please refresh your session and reconnect.',
            })
          );
          return;
        }

        const joinRl = await checkPersistentRateLimit(
          `ws:join:${session.sessionId}`,
          30,
          SERVER_CONFIG.RATE_LIMIT_WINDOW_MS
        );
        if (!joinRl.allowed) {
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Too many room join attempts. Please wait a moment.',
            })
          );
          return;
        }

        try {
          const joined = await joinOrReconnectRoom(code, session, {
            username: msg.username,
            desiredFranchiseId: msg.franchiseId,
          });

          // Remove from any previous room if socket switched rooms
          if (joinedRoomCode && joinedRoomCode !== joined.roomCode && joinedSession) {
            const prevMap = localRoomSockets.get(joinedRoomCode);
            const prevEntry = prevMap?.get(joinedSession.sessionId);
            if (prevEntry && prevEntry.socketId === socketId) {
              prevMap?.delete(joinedSession.sessionId);
            }
          }

          joinedRoomCode = joined.roomCode;
          joinedSession = session;

          let roomMap = localRoomSockets.get(joined.roomCode);
          if (!roomMap) {
            roomMap = new Map();
            localRoomSockets.set(joined.roomCode, roomMap);
          }

          // Replace any older local socket for the same session cleanly
          const existingSocket = roomMap.get(session.sessionId);
          if (existingSocket && existingSocket.socketId !== socketId) {
            try {
              existingSocket.ws.close(4001, 'Replaced by newer connection');
            } catch {
              // ignore
            }
          }

          roomMap.set(session.sessionId, {
            ws,
            socketId,
            session,
            franchiseId: joined.franchiseId!,
            isAlive: true,
          });

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'room:joined',
                roomCode: joined.roomCode,
                clientId: session.sessionId,
                sessionId: session.sessionId,
                franchiseId: joined.franchiseId,
                stateVersion: joined.stateVersion,
                serverTime: Date.now(),
                state: joined.state,
              })
            );
          }

          broadcastToLocalRoom(
            joined.roomCode,
            'state:sync',
            joined.state,
            joined.stateVersion
          );
        } catch (error) {
          const errMsg =
            error instanceof RoomError ? error.message : 'Could not join multiplayer room.';
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: errMsg }));
          }
        }
        return;
      }

      // All other messages require an authenticated joined room session
      if (!joinedRoomCode || !joinedSession) {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Join a room with a valid session before sending actions.',
          })
        );
        return;
      }

      const validatedAction = parseValidatedAction(msg);
      if (!validatedAction) {
        ws.send(JSON.stringify({ type: 'error', message: `Unsupported or invalid action: ${msgType}` }));
        return;
      }

      if (validatedAction.type === 'auction:bid') {
        const bidRl = await checkPersistentRateLimit(
          `ws:bid:${joinedSession.sessionId}`,
          25,
          5_000
        );
        if (!bidRl.allowed) {
          ws.send(
            JSON.stringify({
              type: 'bid:rejected',
              message: 'Bidding too quickly. Please wait a moment.',
              requestId: validatedAction.requestId,
            })
          );
          return;
        }
      }

      try {
        const mutation = await executeRoomAction(joinedRoomCode, joinedSession, validatedAction);

        if (mutation.rejected) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'bid:rejected',
                message: mutation.error || 'Action rejected.',
                requestId:
                  validatedAction.type === 'auction:bid' ? validatedAction.requestId : undefined,
              })
            );
          }
          return;
        }

        if (validatedAction.type === 'lobby:select_franchise' && mutation.franchiseId) {
          const entry = localRoomSockets.get(joinedRoomCode)?.get(joinedSession.sessionId);
          if (entry && entry.socketId === socketId) {
            entry.franchiseId = mutation.franchiseId;
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'franchise:assigned',
                franchiseId: mutation.franchiseId,
                stateVersion: mutation.stateVersion,
              })
            );
          }
        }

        if (mutation.idempotentReplay) {
          // Idempotent bid retry: return authoritative state to requesting client without re-broadcasting duplicate events
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'state:sync',
                idempotentReplay: true,
                stateVersion: mutation.stateVersion,
                serverTime: Date.now(),
                state: mutation.state,
              })
            );
          }
          return;
        }

        broadcastMutation(mutation);
      } catch (error) {
        const errMsg =
          error instanceof RoomError ? error.message : 'Room action could not be processed.';
        console.warn(
          `[WS] Action ${validatedAction.type} failed for room=${joinedRoomCode} session=${joinedSession.sessionId}: ${errMsg}`
        );
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: errMsg }));
        }
      }
    });

    ws.on('close', () => {
      if (!joinedRoomCode || !joinedSession) return;
      const code = joinedRoomCode;
      const sessionId = joinedSession.sessionId;
      const roomMap = localRoomSockets.get(code);
      const currentEntry = roomMap?.get(sessionId);

      // Only process disconnect if this exact socket is still the active one for that session
      if (!currentEntry || currentEntry.socketId !== socketId) {
        return;
      }

      roomMap?.delete(sessionId);
      if (roomMap && roomMap.size === 0) {
        localRoomSockets.delete(code);
      }

      void markParticipantDisconnected(code, sessionId).then((mutation) => {
        if (mutation) {
          broadcastMutation(mutation);
        }
      });
    });

    ws.on('error', (err) => {
      console.warn(`[WS] Socket error (${socketId}):`, err.message);
    });

    // Attach alive marker onto ws for heartbeat sweep
    (ws as WebSocket & { _checkAlive?: () => boolean; _markPendingPing?: () => void })._checkAlive =
      () => alive;
    (
      ws as WebSocket & { _checkAlive?: () => boolean; _markPendingPing?: () => void }
    )._markPendingPing = () => {
      alive = false;
    };
  });

  // Periodic WebSocket ping/pong heartbeat & dead connection cleanup
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      const ext = ws as WebSocket & { _checkAlive?: () => boolean; _markPendingPing?: () => void };
      if (ext._checkAlive && !ext._checkAlive()) {
        ws.terminate();
        continue;
      }
      ext._markPendingPing?.();
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, SERVER_CONFIG.WS_HEARTBEAT_INTERVAL_MS);

  // ---- Multi-Instance Scheduler & Cross-Instance PubSub ----
  const scheduler = new AuctionSchedulerWorker((mutation) => {
    broadcastMutation(mutation);
  });

  const pubsub = new RoomPubSubListener((notification) => {
    // Only pull from DB if THIS instance actually has local WS subscribers for that room
    if (!localRoomSockets.has(notification.roomCode)) return;
    void getRoomByCode(notification.roomCode)
      .then((room) => {
        if (!room) return;
        broadcastToLocalRoom(
          room.roomCode,
          notification.eventType,
          room.state,
          room.stateVersion
        );
      })
      .catch(() => {});
  });

  // ---- Vite Middleware (Dev) or Static Dist (Prod) ----
  if (enableVite) {
    if (!SERVER_CONFIG.IS_PROD) {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distDir = path.resolve(process.cwd(), 'dist');
      app.use(express.static(distDir));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  const startBackgroundWorkers = () => {
    scheduler.start();
    pubsub.start();
  };

  if (options.enableBackgroundWorkers) {
    startBackgroundWorkers();
  }

  const shutdown = async () => {
    clearInterval(heartbeatInterval);
    await scheduler.stop();
    await pubsub.stop();
    for (const client of wss.clients) {
      try {
        client.close(1001, 'Server shutting down');
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    if (httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  };

  return {
    app,
    httpServer,
    wss,
    scheduler,
    pubsub,
    startBackgroundWorkers,
    shutdown,
  };
}
