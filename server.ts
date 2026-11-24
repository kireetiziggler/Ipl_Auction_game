import crypto from 'crypto';
import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import http from 'http';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { ALL_FRANCHISE_IDS, FRANCHISE_MAP } from './src/data/franchises.ts';
import { INITIAL_PLAYERS } from './src/data/players.ts';
import { formatSpokenPrice, getRulesetById, SEASON_RULESETS } from './src/data/rulesets.ts';
import {
  decideAIRTMCounterBid,
  decideAIRTMFinalMatch,
  decideAIRTMOffer,
  selectNextAIBidder,
} from './src/engine/aiEngine.ts';
import {
  applyRetentions,
  closeCurrentLot,
  completeAuction,
  createInitialAuctionState,
  enterRetentionPhase,
  nominateNextPlayer,
  passOnCurrentPlayer,
  pauseAuction,
  placeBid,
  respondToRtmFinalMatch,
  respondToRtmOffer,
  resumeAuction,
  startAuction,
  submitRtmCounter,
} from './src/engine/auctionStateMachine.ts';
import type {
  AIDifficulty,
  AuctionState,
  FranchiseId,
  GameMode,
  NominationMode,
  Player,
  SeasonRuleset,
  UserProfile,
} from './src/engine/types.ts';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'arena-store.json');

// ==================== PERSISTENT SERVER STORE ====================

interface StoredUser {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  passwordSalt: string;
  favoriteFranchise: FranchiseId;
  avatarColor: string;
  stats: UserProfile['stats'];
}

interface PersistedStore {
  users: StoredUser[];
  customPlayers: Player[];
  adminHash?: string;
  adminSalt?: string;
}

function loadStore(): PersistedStore {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedStore;
      return {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        customPlayers: Array.isArray(parsed.customPlayers) ? parsed.customPlayers : [],
        adminHash: parsed.adminHash,
        adminSalt: parsed.adminSalt,
      };
    }
  } catch {
    // Fallback cleanly to empty store
  }
  return { users: [], customPlayers: [] };
}

function saveStore(store: PersistedStore): void {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const tmp = `${STORE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    console.error('Failed to persist store:', err);
  }
}

const store = loadStore();

function getMergedPlayers(): Player[] {
  const byId = new Map<string, Player>();
  for (const p of INITIAL_PLAYERS) byId.set(p.id, p);
  for (const p of store.customPlayers) byId.set(p.id, p);
  return Array.from(byId.values());
}

function getMergedPlayerMap(): Record<string, Player> {
  const map: Record<string, Player> = {};
  for (const p of getMergedPlayers()) map[p.id] = p;
  return map;
}

// ==================== SECURITY & AUTH HELPERS ====================

const activeUserTokens = new Map<string, string>(); // token -> userId
const activeAdminTokens = new Set<string>();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateBuckets.get(key);
  if (!entry || entry.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count += 1;
  return true;
}

function hashSecret(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash: derived, salt };
}

function verifySecret(password: string, expectedHash: string, salt: string): boolean {
  const derived = crypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  if (derived.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(derived, expectedBuf);
}

function verifyEnvAdminPasscode(candidate: string): boolean {
  const envPass = process.env.ADMIN_PASSCODE?.trim();
  if (!envPass) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(envPass);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractBearer(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

function sanitizeText(input: unknown, maxLen = 64): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[<>]/g, '').trim().slice(0, maxLen);
}

function isValidFranchiseId(id: unknown): id is FranchiseId {
  return typeof id === 'string' && (ALL_FRANCHISE_IDS as string[]).includes(id);
}

// ==================== AUTHORITATIVE MULTIPLAYER ROOM ENGINE ====================

interface ConnectedClient {
  ws: WebSocket;
  clientId: string;
  username: string;
  franchiseId: FranchiseId;
}

interface LiveRoom {
  state: AuctionState;
  clients: Map<string, ConnectedClient>; // clientId -> client
  goingOnceSent: boolean;
  goingTwiceSent: boolean;
  lastAIBidAt: number;
  lotTransitionAt: number | null;
}

const rooms = new Map<string, LiveRoom>(); // roomCode -> LiveRoom

function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function broadcastRoom(room: LiveRoom, eventType = 'state:sync', extra?: Record<string, unknown>) {
  const payload = JSON.stringify({
    type: eventType,
    serverTime: Date.now(),
    state: room.state,
    ...extra,
  });
  for (const client of room.clients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
    }
  }
}

function findAvailableFranchise(state: AuctionState): FranchiseId | null {
  for (const fid of ALL_FRANCHISE_IDS) {
    if (state.teams[fid].controllerType === 'AI') {
      return fid;
    }
  }
  return null;
}

function assignFranchiseToHuman(
  room: LiveRoom,
  clientId: string,
  username: string,
  desiredFranchiseId?: FranchiseId
): FranchiseId | null {
  const teams = { ...room.state.teams };
  // Check if client already owns a franchise (reconnection!)
  for (const fid of ALL_FRANCHISE_IDS) {
    if (teams[fid].ownerId === clientId) {
      teams[fid] = { ...teams[fid], isConnected: true, ownerName: username || teams[fid].ownerName };
      room.state = { ...room.state, teams, updatedAt: Date.now() };
      return fid;
    }
  }

  let target: FranchiseId | null = null;
  if (desiredFranchiseId && teams[desiredFranchiseId]?.controllerType === 'AI') {
    target = desiredFranchiseId;
  } else {
    target = findAvailableFranchise(room.state);
  }
  if (!target) return null;

  teams[target] = {
    ...teams[target],
    controllerType: 'HUMAN',
    ownerId: clientId,
    ownerName: username || 'Franchise Owner',
    isConnected: true,
    isReady: false,
  };
  room.state = { ...room.state, teams, updatedAt: Date.now() };
  return target;
}

// Authoritative 500ms server tick driving countdowns, Going Once/Twice, AI bids, and lot closings
setInterval(() => {
  const now = Date.now();
  const playerMap = getMergedPlayerMap();

  for (const [code, room] of rooms.entries()) {
    // Cleanup abandoned rooms older than 4 hours with 0 connected clients
    if (room.clients.size === 0 && now - room.state.updatedAt > 4 * 60 * 60 * 1000) {
      rooms.delete(code);
      continue;
    }

    const { phase } = room.state;

    // Handle post-SOLD / post-UNSOLD transition pause (2.6s display before next lot)
    if ((phase === 'SOLD' || phase === 'UNSOLD') && room.lotTransitionAt && now >= room.lotTransitionAt) {
      room.lotTransitionAt = null;
      room.goingOnceSent = false;
      room.goingTwiceSent = false;
      room.lastAIBidAt = now;
      room.state = nominateNextPlayer(room.state, playerMap, now);
      broadcastRoom(room, 'lot:next');
      continue;
    }

    // Handle automated AI decisions and timeouts during 3-stage RTM phases
    if (
      (phase === 'RTM_OFFER' || phase === 'RTM_COUNTER' || phase === 'RTM_FINAL_MATCH') &&
      room.state.rtmState
    ) {
      const rtm = room.state.rtmState;
      const player = playerMap[rtm.playerId];
      const remainingMs = room.state.countdownEndsAt ? room.state.countdownEndsAt - now : 0;
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

      if (player) {
        if (phase === 'RTM_OFFER') {
          const rtmTeam = room.state.teams[rtm.rtmFranchiseId];
          if (rtmTeam.controllerType === 'AI' && now - room.state.updatedAt >= 1200) {
            const useRtm = decideAIRTMOffer(room.state, rtm.rtmFranchiseId, player, rtm.initialBidCr, playerMap);
            room.state = respondToRtmOffer(room.state, useRtm, playerMap, now);
            if (room.state.phase === 'SOLD') {
              room.lotTransitionAt = now + 4800;
              broadcastRoom(room, 'lot:sold');
            } else {
              broadcastRoom(room, 'rtm:update');
            }
            continue;
          } else if (remainingSec <= 0) {
            room.state = respondToRtmOffer(room.state, false, playerMap, now);
            room.lotTransitionAt = now + 4800;
            broadcastRoom(room, 'lot:sold');
            continue;
          }
        } else if (phase === 'RTM_COUNTER') {
          const winTeam = room.state.teams[rtm.winningFranchiseId];
          if (winTeam.controllerType === 'AI' && now - room.state.updatedAt >= 1200) {
            const counterCr = decideAIRTMCounterBid(
              room.state,
              rtm.winningFranchiseId,
              player,
              rtm.initialBidCr,
              playerMap
            );
            room.state = submitRtmCounter(room.state, counterCr, playerMap, now);
            if (room.state.phase === 'SOLD') {
              room.lotTransitionAt = now + 4800;
              broadcastRoom(room, 'lot:sold');
            } else {
              broadcastRoom(room, 'rtm:update');
            }
            continue;
          } else if (remainingSec <= 0) {
            room.state = submitRtmCounter(room.state, null, playerMap, now);
            room.lotTransitionAt = now + 4800;
            broadcastRoom(room, 'lot:sold');
            continue;
          }
        } else if (phase === 'RTM_FINAL_MATCH') {
          const rtmTeam = room.state.teams[rtm.rtmFranchiseId];
          const counterCr = rtm.counterBidCr ?? rtm.initialBidCr;
          if (rtmTeam.controllerType === 'AI' && now - room.state.updatedAt >= 1200) {
            const match = decideAIRTMFinalMatch(room.state, rtm.rtmFranchiseId, player, counterCr, playerMap);
            room.state = respondToRtmFinalMatch(room.state, match, playerMap, now);
            room.lotTransitionAt = now + 4800;
            broadcastRoom(room, 'lot:sold');
            continue;
          } else if (remainingSec <= 0) {
            room.state = respondToRtmFinalMatch(room.state, false, playerMap, now);
            room.lotTransitionAt = now + 4800;
            broadcastRoom(room, 'lot:sold');
            continue;
          }
        }
      }

      if (remainingSec !== room.state.countdownRemainingSec) {
        room.state = { ...room.state, countdownRemainingSec: remainingSec };
        broadcastRoom(room, 'timer:tick');
      }
      continue;
    }

    if (phase !== 'OPENING_BID' && phase !== 'BIDDING' && phase !== 'COUNTDOWN') {
      continue;
    }

    if (!room.state.countdownEndsAt) continue;

    // Hold countdown and AI bidding while auctioneer is introducing "The next player is..."
    if (room.state.biddingOpensAt && now < room.state.biddingOpensAt) {
      continue;
    }

    const remainingMs = room.state.countdownEndsAt - now;
    const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

    // AI bidding evaluation cadence (realistic human-like reaction pacing)
    const aiCooldownMs =
      room.state.auctionSpeed === 'BLITZ' ? 750 : room.state.auctionSpeed === 'FAST' ? 1050 : 1400;

    if (remainingMs > 800 && now - room.lastAIBidAt >= aiCooldownMs) {
      const decision = selectNextAIBidder(room.state, playerMap);
      if (decision && room.state.currentPlayerId) {
        const player = playerMap[room.state.currentPlayerId];
        if (player) {
          const result = placeBid(room.state, decision.franchiseId, player, {
            proposedAmountCr: decision.bidAmountCr,
            isAI: true,
            aiReason: decision.reason,
            now,
          });
          if (result.accepted) {
            room.state = result.state;
            room.lastAIBidAt = now;
            room.goingOnceSent = false;
            room.goingTwiceSent = false;
            broadcastRoom(room, 'bid:placed');
            continue;
          }
        }
      }
      room.lastAIBidAt = now;
    }

    // Countdown alerts & expiration
    if (remainingSec <= 0) {
      room.state = closeCurrentLot(room.state, playerMap, now);
      if (room.state.phase === 'RTM_OFFER') {
        broadcastRoom(room, 'rtm:offer');
      } else {
        // Hold long enough for the full "Sold! <Player> to <Franchise> for <Price>" sentence to finish cleanly
        const delayMs = room.state.auctionSpeed === 'BLITZ' ? 3800 : 5400;
        room.lotTransitionAt = now + delayMs;
        broadcastRoom(room, room.state.phase === 'SOLD' ? 'lot:sold' : 'lot:unsold');
      }
      continue;
    }

    let changed = false;
    if (remainingSec !== room.state.countdownRemainingSec) {
      room.state = {
        ...room.state,
        countdownRemainingSec: remainingSec,
        phase: remainingSec <= room.state.ruleset.goingOnceAtSeconds ? 'COUNTDOWN' : room.state.phase,
      };
      changed = true;
    }

    if (
      room.state.hasOpeningBid &&
      remainingSec <= room.state.ruleset.goingOnceAtSeconds &&
      remainingSec > room.state.ruleset.goingTwiceAtSeconds &&
      !room.goingOnceSent
    ) {
      room.goingOnceSent = true;
      const leader = room.state.currentBidderId
        ? FRANCHISE_MAP[room.state.currentBidderId].shortName
        : 'Current bidder';
      room.state = {
        ...room.state,
        lastAnnouncement: `${leader} is with ${formatSpokenPrice(room.state.currentBidCr)}, going once!`,
      };
      broadcastRoom(room, 'call:going_once');
      continue;
    } else if (
      room.state.hasOpeningBid &&
      remainingSec <= room.state.ruleset.goingTwiceAtSeconds &&
      !room.goingTwiceSent
    ) {
      room.goingTwiceSent = true;
      room.state = {
        ...room.state,
        lastAnnouncement: `Going twice!`,
      };
      broadcastRoom(room, 'call:going_twice');
      continue;
    }

    if (changed) {
      broadcastRoom(room, 'timer:tick');
    }
  }
}, 500);

// ==================== EXPRESS APP & REST ROUTES ====================

async function bootstrap() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, roomsActive: rooms.size, playersCount: getMergedPlayers().length });
  });

  app.get('/api/players', (_req, res) => {
    res.json({ players: getMergedPlayers(), rulesets: SEASON_RULESETS });
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

  async function synthesizeElevenLabs(text: string): Promise<{ audioBase64: string; mimeType: string } | null> {
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
    const ip = req.ip || 'local';
    if (!checkRateLimit(`tts:${ip}`, 120, 60_000)) {
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
  const inflightPhotos = new Map<string, Promise<{ filePath: string; contentType: string; isCutout: boolean } | null>>();

  // Verified exact-slug aliases for players whose official iplt20.com URL uses full/alternate spelling
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
        console.warn('[Photo] Could not load official IPL sitemap:', err instanceof Error ? err.message : err);
      }
      if (map.size > 0) {
        iplPlayerSitemapMap = map;
      }
      iplSitemapLoadPromise = null;
      return map;
    })();

    return iplSitemapLoadPromise;
  }

  // Reject non-portrait Wikimedia images (politicians, flags, stadiums, crests, logos)
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

    const task = (async (): Promise<{ filePath: string; contentType: string; isCutout: boolean } | null> => {
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
        // TIER 1: Official IPL Transparent Cutout PNG (exact slug match from iplt20.com)
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
                  const imgRes = await fetch(assetUrl, { headers, signal: AbortSignal.timeout(7000) });
                  const ct = (imgRes.headers.get('content-type') || '').toLowerCase();
                  // Strictly accept raster PNG/JPEG/WEBP; reject SVG placeholder silhouettes
                  if (
                    imgRes.ok &&
                    (ct.startsWith('image/png') || ct.startsWith('image/jpeg') || ct.startsWith('image/webp'))
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

        // TIER 2: Strict Exact-Title Wikipedia Cricket Portrait ONLY (zero fuzzy search, zero mismatches!)
        const wikiHeaders = { 'User-Agent': 'IPLAuctionArena/2.0 (https://github.com/ipl-auction-arena)' };
        const expectedNorm = normalizeTitle(player.name);
        const exactTitles = [player.name, `${player.name} (cricketer)`];
        let thumbUrl: string | null = null;

        for (const title of exactTitles) {
          const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
            title.replace(/ /g, '_')
          )}`;
          const sumRes = await fetch(summaryUrl, { headers: wikiHeaders, signal: AbortSignal.timeout(4500) });
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

          // Exact player name match + verified cricketer + reject non-portrait images
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

        // Strict SSRF host allowlist check: ONLY official Wikimedia image CDNs
        const ALLOWED_WIKI_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
        const parsed = new URL(thumbUrl);
        if (parsed.protocol !== 'https:' || !ALLOWED_WIKI_HOSTS.has(parsed.hostname)) {
          missingPhotoCache.add(safeId);
          return null;
        }

        const imgRes = await fetch(parsed.toString(), { headers: wikiHeaders, signal: AbortSignal.timeout(5000) });
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
    const player = getMergedPlayerMap()[id];
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

  // ---- User Auth (Optional; Guest Mode always works without login) ----
  app.post('/api/auth/register', (req, res) => {
    const ip = req.ip || 'local';
    if (!checkRateLimit(`auth:${ip}`, 15, 60_000)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    }
    const email = sanitizeText(req.body?.email, 120).toLowerCase();
    const username = sanitizeText(req.body?.username, 40);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const favoriteFranchise: FranchiseId = isValidFranchiseId(req.body?.favoriteFranchise)
      ? req.body.favoriteFranchise
      : 'CSK';

    if (!email || !email.includes('@') || username.length < 2 || password.length < 6) {
      return res.status(400).json({ error: 'Valid email, username (2+ chars), and password (6+ chars) required.' });
    }
    if (store.users.some((u) => u.email === email)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const { hash, salt } = hashSecret(password);
    const user: StoredUser = {
      id: `usr_${crypto.randomBytes(8).toString('hex')}`,
      username,
      email,
      passwordHash: hash,
      passwordSalt: salt,
      favoriteFranchise,
      avatarColor: FRANCHISE_MAP[favoriteFranchise].primaryColor,
      stats: { auctionsPlayed: 0, auctionsWon: 0, bestRating: 0, avgRating: 0, tournamentsWon: 0 },
    };
    store.users.push(user);
    saveStore(store);

    const token = crypto.randomBytes(32).toString('hex');
    activeUserTokens.set(token, user.id);

    const profile: UserProfile = {
      id: user.id,
      username: user.username,
      email: user.email,
      isGuest: false,
      favoriteFranchise: user.favoriteFranchise,
      avatarColor: user.avatarColor,
      stats: user.stats,
    };
    return res.status(201).json({ token, profile });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.ip || 'local';
    if (!checkRateLimit(`auth:${ip}`, 20, 60_000)) {
      return res.status(429).json({ error: 'Too many login attempts. Please wait a minute.' });
    }
    const email = sanitizeText(req.body?.email, 120).toLowerCase();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = store.users.find((u) => u.email === email);
    if (!user || !verifySecret(password, user.passwordHash, user.passwordSalt)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    activeUserTokens.set(token, user.id);
    const profile: UserProfile = {
      id: user.id,
      username: user.username,
      email: user.email,
      isGuest: false,
      favoriteFranchise: user.favoriteFranchise,
      avatarColor: user.avatarColor,
      stats: user.stats,
    };
    return res.json({ token, profile });
  });

  app.get('/api/auth/me', (req, res) => {
    const token = extractBearer(req);
    if (!token) return res.status(401).json({ error: 'Not authenticated.' });
    const userId = activeUserTokens.get(token);
    const user = store.users.find((u) => u.id === userId);
    if (!user) return res.status(401).json({ error: 'Session expired.' });
    return res.json({
      profile: {
        id: user.id,
        username: user.username,
        email: user.email,
        isGuest: false,
        favoriteFranchise: user.favoriteFranchise,
        avatarColor: user.avatarColor,
        stats: user.stats,
      },
    });
  });

  // ---- Admin Auth (Env passcode OR atomic first-run claim setup) ----
  app.get('/api/admin/status', (req, res) => {
    const hasEnv = Boolean(process.env.ADMIN_PASSCODE?.trim());
    const isClaimed = hasEnv || Boolean(store.adminHash && store.adminSalt);
    const token = extractBearer(req);
    const authenticated = Boolean(token && activeAdminTokens.has(token));
    res.json({ isClaimed, authenticated, usingEnvPasscode: hasEnv });
  });

  app.post('/api/admin/claim', (req, res) => {
    if (process.env.ADMIN_PASSCODE?.trim() || (store.adminHash && store.adminSalt)) {
      return res.status(409).json({ error: 'Admin password is already configured.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    if (password.length < 8) {
      return res.status(400).json({ error: 'Admin password must be at least 8 characters.' });
    }
    const { hash, salt } = hashSecret(password);
    store.adminHash = hash;
    store.adminSalt = salt;
    saveStore(store);

    const token = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(token);
    return res.status(201).json({ token });
  });

  app.post('/api/admin/login', (req, res) => {
    const ip = req.ip || 'local';
    if (!checkRateLimit(`admin:${ip}`, 15, 60_000)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a minute.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    let ok = false;
    if (process.env.ADMIN_PASSCODE?.trim()) {
      ok = verifyEnvAdminPasscode(password);
    } else if (store.adminHash && store.adminSalt) {
      ok = verifySecret(password, store.adminHash, store.adminSalt);
    }
    if (!ok) {
      return res.status(401).json({ error: 'Invalid admin password.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    activeAdminTokens.add(token);
    return res.json({ token });
  });

  const requireAdmin: express.RequestHandler = (req, res, next) => {
    const token = extractBearer(req);
    if (!token || !activeAdminTokens.has(token)) {
      return res.status(401).json({ error: 'Admin authorization required.' });
    }
    next();
  };

  app.post('/api/admin/players', requireAdmin, (req, res) => {
    const p = req.body?.player as Partial<Player> | undefined;
    if (!p || !p.name || !p.primaryRole || !p.country) {
      return res.status(400).json({ error: 'Player name, country, and primaryRole are required.' });
    }
    const id =
      sanitizeText(p.id, 60) ||
      sanitizeText(p.name, 60)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');

    const safePlayer: Player = {
      id,
      name: sanitizeText(p.name, 64),
      country: sanitizeText(p.country, 40),
      countryCode: sanitizeText(p.countryCode || (p.country === 'India' ? 'IN' : 'AU'), 4).toUpperCase(),
      isOverseas: Boolean(p.isOverseas ?? p.country !== 'India'),
      isCapped: Boolean(p.isCapped ?? true),
      age: Math.max(16, Math.min(50, Number(p.age) || 25)),
      battingStyle: p.battingStyle === 'Left-hand bat' ? 'Left-hand bat' : 'Right-hand bat',
      bowlingStyle: sanitizeText(p.bowlingStyle || 'Right-arm medium', 40),
      primaryRole: p.primaryRole,
      secondaryRole: p.secondaryRole || 'Top-order Batter',
      specialtyTags: Array.isArray(p.specialtyTags)
        ? p.specialtyTags.map((t) => sanitizeText(t, 28)).filter(Boolean).slice(0, 5)
        : ['Custom Entry'],
      previousFranchises: Array.isArray(p.previousFranchises)
        ? p.previousFranchises.map((f) => sanitizeText(f, 12)).filter(Boolean)
        : [],
      category: p.category || 'Emerging Stars',
      basePriceCr: Math.max(0.2, Math.min(5, Number(p.basePriceCr) || 0.5)),
      jerseyNumber: Math.max(1, Math.min(999, Number(p.jerseyNumber) || 10)),
      stats: {
        matches: Math.max(0, Number(p.stats?.matches) || 0),
        runs: Math.max(0, Number(p.stats?.runs) || 0),
        battingAvg: Math.max(0, Number(p.stats?.battingAvg) || 0),
        strikeRate: Math.max(0, Number(p.stats?.strikeRate) || 0),
        highestScore: sanitizeText(p.stats?.highestScore || '0', 10),
        fifties: Math.max(0, Number(p.stats?.fifties) || 0),
        hundreds: Math.max(0, Number(p.stats?.hundreds) || 0),
        wickets: Math.max(0, Number(p.stats?.wickets) || 0),
        bowlingAvg: Math.max(0, Number(p.stats?.bowlingAvg) || 0),
        economy: Math.max(0, Number(p.stats?.economy) || 0),
        bowlingStrikeRate: Math.max(0, Number(p.stats?.bowlingStrikeRate) || 0),
        bestBowling: sanitizeText(p.stats?.bestBowling || '-', 10),
        catches: Math.max(0, Number(p.stats?.catches) || 0),
      },
      recentSeasons: Array.isArray(p.recentSeasons) ? p.recentSeasons : [],
      strengths: Array.isArray(p.strengths) ? p.strengths.map((s) => sanitizeText(s, 100)) : ['Custom scouted player'],
      weaknesses: Array.isArray(p.weaknesses) ? p.weaknesses.map((s) => sanitizeText(s, 100)) : ['Limited sample size'],
      ratings: {
        overall: Math.max(40, Math.min(99, Number(p.ratings?.overall) || 78)),
        batting: Math.max(10, Math.min(99, Number(p.ratings?.batting) || 75)),
        bowling: Math.max(10, Math.min(99, Number(p.ratings?.bowling) || 50)),
        fielding: Math.max(10, Math.min(99, Number(p.ratings?.fielding) || 78)),
        form: Math.max(10, Math.min(99, Number(p.ratings?.form) || 78)),
        potential: Math.max(10, Math.min(99, Number(p.ratings?.potential) || 82)),
        captaincy: Math.max(10, Math.min(99, Number(p.ratings?.captaincy) || 65)),
        estimatedValueCr: Math.max(0.3, Math.min(25, Number(p.ratings?.estimatedValueCr) || 3.5)),
      },
      dataSource: sanitizeText(p.dataSource || 'Admin Studio Custom Entry', 80),
      lastUpdated: new Date().toISOString().slice(0, 10),
    };

    const existingIdx = store.customPlayers.findIndex((x) => x.id === safePlayer.id);
    if (existingIdx >= 0) {
      store.customPlayers[existingIdx] = safePlayer;
    } else {
      store.customPlayers.push(safePlayer);
    }
    saveStore(store);
    return res.status(201).json({ player: safePlayer, players: getMergedPlayers() });
  });

  app.post('/api/admin/players/import', requireAdmin, (req, res) => {
    const incoming = req.body?.players;
    if (!Array.isArray(incoming) || incoming.length === 0 || incoming.length > 200) {
      return res.status(400).json({ error: 'Provide an array of 1 to 200 player records.' });
    }
    const existingIds = new Set(getMergedPlayers().map((p) => p.id));
    let imported = 0;
    let skippedDuplicates = 0;

    for (const raw of incoming) {
      if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
      const id =
        sanitizeText(raw.id, 60) ||
        sanitizeText(raw.name, 60)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-');
      if (existingIds.has(id)) {
        skippedDuplicates += 1;
        continue;
      }
      existingIds.add(id);
      store.customPlayers.push({
        id,
        name: sanitizeText(raw.name, 64),
        country: sanitizeText(raw.country || 'India', 40),
        countryCode: sanitizeText(raw.countryCode || (raw.country === 'India' ? 'IN' : 'AU'), 4).toUpperCase(),
        isOverseas: Boolean(raw.isOverseas ?? (raw.country && raw.country !== 'India')),
        isCapped: Boolean(raw.isCapped ?? true),
        age: Math.max(16, Math.min(50, Number(raw.age) || 25)),
        battingStyle: raw.battingStyle === 'Left-hand bat' ? 'Left-hand bat' : 'Right-hand bat',
        bowlingStyle: sanitizeText(raw.bowlingStyle || 'Right-arm medium', 40),
        primaryRole: raw.primaryRole || 'Batter',
        secondaryRole: raw.secondaryRole || 'Top-order Batter',
        specialtyTags: ['Imported'],
        previousFranchises: [],
        category: raw.category || 'Emerging Stars',
        basePriceCr: Math.max(0.2, Math.min(5, Number(raw.basePriceCr) || 0.5)),
        jerseyNumber: Math.max(1, Math.min(999, Number(raw.jerseyNumber) || 7)),
        stats: {
          matches: Math.max(0, Number(raw.matches ?? raw.stats?.matches) || 0),
          runs: Math.max(0, Number(raw.runs ?? raw.stats?.runs) || 0),
          battingAvg: Math.max(0, Number(raw.battingAvg ?? raw.stats?.battingAvg) || 0),
          strikeRate: Math.max(0, Number(raw.strikeRate ?? raw.stats?.strikeRate) || 0),
          highestScore: sanitizeText(raw.highestScore ?? raw.stats?.highestScore ?? '0', 10),
          fifties: Math.max(0, Number(raw.fifties ?? raw.stats?.fifties) || 0),
          hundreds: Math.max(0, Number(raw.hundreds ?? raw.stats?.hundreds) || 0),
          wickets: Math.max(0, Number(raw.wickets ?? raw.stats?.wickets) || 0),
          bowlingAvg: Math.max(0, Number(raw.bowlingAvg ?? raw.stats?.bowlingAvg) || 0),
          economy: Math.max(0, Number(raw.economy ?? raw.stats?.economy) || 0),
          bowlingStrikeRate: Math.max(0, Number(raw.bowlingStrikeRate ?? raw.stats?.bowlingStrikeRate) || 0),
          bestBowling: sanitizeText(raw.bestBowling ?? raw.stats?.bestBowling ?? '-', 10),
          catches: Math.max(0, Number(raw.catches ?? raw.stats?.catches) || 0),
        },
        recentSeasons: [],
        strengths: ['Imported player record'],
        weaknesses: ['Review scouting data'],
        ratings: {
          overall: Math.max(40, Math.min(99, Number(raw.overall ?? raw.ratings?.overall) || 76)),
          batting: Math.max(10, Math.min(99, Number(raw.batting ?? raw.ratings?.batting) || 74)),
          bowling: Math.max(10, Math.min(99, Number(raw.bowling ?? raw.ratings?.bowling) || 45)),
          fielding: Math.max(10, Math.min(99, Number(raw.fielding ?? raw.ratings?.fielding) || 76)),
          form: Math.max(10, Math.min(99, Number(raw.form ?? raw.ratings?.form) || 76)),
          potential: Math.max(10, Math.min(99, Number(raw.potential ?? raw.ratings?.potential) || 80)),
          captaincy: Math.max(10, Math.min(99, Number(raw.captaincy ?? raw.ratings?.captaincy) || 60)),
          estimatedValueCr: Math.max(0.3, Math.min(25, Number(raw.estimatedValueCr ?? raw.ratings?.estimatedValueCr) || 3.0)),
        },
        dataSource: sanitizeText(raw.dataSource || 'Admin Bulk Import', 80),
        lastUpdated: new Date().toISOString().slice(0, 10),
      });
      imported += 1;
    }

    saveStore(store);
    return res.json({ imported, skippedDuplicates, players: getMergedPlayers() });
  });

  // ---- Multiplayer Room REST Endpoints ----
  app.post('/api/rooms', (req, res) => {
    const hostId = sanitizeText(req.body?.clientId, 64) || `cli_${crypto.randomBytes(6).toString('hex')}`;
    const hostName = sanitizeText(req.body?.username, 40) || 'Franchise Owner';
    const franchiseId: FranchiseId = isValidFranchiseId(req.body?.franchiseId)
      ? req.body.franchiseId
      : 'CSK';
    const mode: GameMode =
      ['SOLO', 'MULTIPLAYER', 'QUICK', 'FULL', 'PRACTICE', 'TOURNAMENT'].includes(req.body?.mode)
        ? req.body.mode
        : 'MULTIPLAYER';
    const ruleset: SeasonRuleset = req.body?.customRuleset
      ? { ...getRulesetById(req.body?.rulesetId || 'sim-2026-mega'), ...req.body.customRuleset }
      : getRulesetById(req.body?.rulesetId || 'sim-2026-mega');
    const aiDifficulty: AIDifficulty =
      ['EASY', 'NORMAL', 'HARD', 'EXPERT'].includes(req.body?.aiDifficulty)
        ? req.body.aiDifficulty
        : 'NORMAL';
    const nominationMode: NominationMode =
      req.body?.nominationMode === 'MANAGER_NOMINATION' ? 'MANAGER_NOMINATION' : 'SET_ORDER';
    const auctionSpeed: 'NORMAL' | 'FAST' | 'BLITZ' =
      ['NORMAL', 'FAST', 'BLITZ'].includes(req.body?.auctionSpeed) ? req.body.auctionSpeed : 'NORMAL';

    const roomCode = generateRoomCode();
    const state = createInitialAuctionState({
      roomId: `room_${crypto.randomBytes(6).toString('hex')}`,
      roomCode,
      hostId,
      hostName,
      hostFranchiseId: franchiseId,
      mode,
      ruleset,
      aiDifficulty,
      nominationMode,
      auctionSpeed,
      players: getMergedPlayers(),
    });

    const liveRoom: LiveRoom = {
      state,
      clients: new Map(),
      goingOnceSent: false,
      goingTwiceSent: false,
      lastAIBidAt: Date.now(),
      lotTransitionAt: null,
    };
    rooms.set(roomCode, liveRoom);
    return res.status(201).json({ roomCode, state });
  });

  app.get('/api/rooms/:code', (req, res) => {
    const code = sanitizeText(req.params.code, 12).toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      return res.status(404).json({ error: 'Room not found or expired.' });
    }
    return res.json({ roomCode: code, state: room.state });
  });

  // ---- HTTP & WebSocket Server on Port 3000 ----
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/auction' });

  wss.on('connection', (ws) => {
    let joinedRoomCode: string | null = null;
    let joinedClientId: string | null = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          roomCode?: string;
          clientId?: string;
          username?: string;
          franchiseId?: FranchiseId;
          amountCr?: number;
          requestId?: string;
          ready?: boolean;
          playerId?: string;
          useRtm?: boolean;
          counterBidCr?: number | null;
          matchCounter?: boolean;
          selections?: Partial<Record<FranchiseId, string[]>>;
          settings?: {
            aiDifficulty?: AIDifficulty;
            auctionSpeed?: 'NORMAL' | 'FAST' | 'BLITZ';
            rulesetId?: string;
            nominationMode?: NominationMode;
          };
        };

        if (msg.type === 'room:join') {
          const code = sanitizeText(msg.roomCode, 12).toUpperCase();
          const room = rooms.get(code);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: `Room ${code} was not found.` }));
            return;
          }
          const clientId = sanitizeText(msg.clientId, 64) || `cli_${crypto.randomBytes(6).toString('hex')}`;
          const username = sanitizeText(msg.username, 40) || 'Franchise Owner';
          const desired = isValidFranchiseId(msg.franchiseId) ? msg.franchiseId : undefined;
          const assigned = assignFranchiseToHuman(room, clientId, username, desired);
          if (!assigned) {
            ws.send(JSON.stringify({ type: 'error', message: 'All 10 franchises are already taken in this room.' }));
            return;
          }

          joinedRoomCode = code;
          joinedClientId = clientId;
          room.clients.set(clientId, { ws, clientId, username, franchiseId: assigned });

          ws.send(
            JSON.stringify({
              type: 'room:joined',
              roomCode: code,
              clientId,
              franchiseId: assigned,
              serverTime: Date.now(),
              state: room.state,
            })
          );
          broadcastRoom(room, 'state:sync');
          return;
        }

        if (!joinedRoomCode || !joinedClientId) return;
        const room = rooms.get(joinedRoomCode);
        if (!room) return;
        const client = room.clients.get(joinedClientId);
        if (!client) return;

        const playerMap = getMergedPlayerMap();
        const now = Date.now();

        switch (msg.type) {
          case 'lobby:select_franchise': {
            if (room.state.phase !== 'LOBBY') return;
            if (!isValidFranchiseId(msg.franchiseId)) return;
            const targetTeam = room.state.teams[msg.franchiseId];
            if (targetTeam.controllerType !== 'AI') {
              ws.send(JSON.stringify({ type: 'error', message: 'Franchise already claimed by another player.' }));
              return;
            }
            const oldFid = client.franchiseId;
            const oldCfg = FRANCHISE_MAP[oldFid];
            const teams = { ...room.state.teams };
            teams[oldFid] = {
              ...teams[oldFid],
              controllerType: 'AI',
              ownerId: undefined,
              ownerName: `${oldCfg.ownerPersona} (AI)`,
              isReady: true,
              isConnected: true,
            };
            teams[msg.franchiseId] = {
              ...teams[msg.franchiseId],
              controllerType: 'HUMAN',
              ownerId: client.clientId,
              ownerName: client.username,
              isReady: false,
              isConnected: true,
            };
            client.franchiseId = msg.franchiseId;
            room.state = { ...room.state, teams, updatedAt: now };
            ws.send(JSON.stringify({ type: 'franchise:assigned', franchiseId: msg.franchiseId }));
            broadcastRoom(room, 'state:sync');
            break;
          }

          case 'lobby:toggle_ready': {
            if (room.state.phase !== 'LOBBY') return;
            const t = room.state.teams[client.franchiseId];
            room.state = {
              ...room.state,
              teams: {
                ...room.state.teams,
                [client.franchiseId]: { ...t, isReady: msg.ready ?? !t.isReady },
              },
              updatedAt: now,
            };
            broadcastRoom(room, 'state:sync');
            break;
          }

          case 'lobby:update_settings': {
            if (room.state.phase !== 'LOBBY' || room.state.hostId !== client.clientId) return;
            const s = msg.settings || {};
            const nextRuleset = s.rulesetId ? getRulesetById(s.rulesetId) : room.state.ruleset;
            const teams = { ...room.state.teams };
            if (s.rulesetId) {
              for (const fid of ALL_FRANCHISE_IDS) {
                teams[fid] = {
                  ...teams[fid],
                  purseRemainingCr: nextRuleset.initialPurseCr,
                  rtmRemaining: nextRuleset.allowRTM ? nextRuleset.rtmCardsPerTeam : 0,
                };
              }
            }
            room.state = {
              ...room.state,
              ruleset: nextRuleset,
              teams,
              aiDifficulty: s.aiDifficulty ?? room.state.aiDifficulty,
              auctionSpeed: s.auctionSpeed ?? room.state.auctionSpeed,
              nominationMode: s.nominationMode ?? room.state.nominationMode,
              updatedAt: now,
            };
            broadcastRoom(room, 'state:sync');
            break;
          }

          case 'lobby:enter_retention': {
            if (room.state.phase !== 'LOBBY' || room.state.hostId !== client.clientId) return;
            room.state = enterRetentionPhase(room.state, now);
            broadcastRoom(room, 'retention:opened');
            break;
          }

          case 'retention:confirm': {
            if (room.state.hostId !== client.clientId) return;
            const withRetentions = applyRetentions(room.state, msg.selections || {}, playerMap, now);
            room.state = startAuction(withRetentions, playerMap, now);
            room.lastAIBidAt = now + 800;
            room.goingOnceSent = false;
            room.goingTwiceSent = false;
            broadcastRoom(room, 'auction:started');
            break;
          }

          case 'auction:start': {
            if (
              (room.state.phase !== 'LOBBY' && room.state.phase !== 'RETENTION' && room.state.phase !== 'READY') ||
              room.state.hostId !== client.clientId
            )
              return;
            const prepared = room.state.retentionsApplied
              ? room.state
              : applyRetentions(room.state, {}, playerMap, now);
            room.state = startAuction(prepared, playerMap, now);
            room.lastAIBidAt = now + 800;
            room.goingOnceSent = false;
            room.goingTwiceSent = false;
            broadcastRoom(room, 'auction:started');
            break;
          }

          case 'auction:bid': {
            if (!checkRateLimit(`bid:${client.clientId}`, 25, 5_000)) return;
            if (!room.state.currentPlayerId) return;
            const player = playerMap[room.state.currentPlayerId];
            if (!player) return;
            const result = placeBid(room.state, client.franchiseId, player, {
              proposedAmountCr: typeof msg.amountCr === 'number' ? msg.amountCr : undefined,
              requestId: sanitizeText(msg.requestId, 64) || undefined,
              isAI: false,
              now,
            });
            if (!result.accepted) {
              ws.send(JSON.stringify({ type: 'bid:rejected', message: result.error }));
              return;
            }
            room.state = result.state;
            room.goingOnceSent = false;
            room.goingTwiceSent = false;
            room.lastAIBidAt = now;
            broadcastRoom(room, 'bid:placed');
            break;
          }

          case 'auction:pass': {
            room.state = passOnCurrentPlayer(room.state, client.franchiseId, now);
            broadcastRoom(room, 'state:sync');
            break;
          }

          case 'auction:rtm_offer': {
            if (
              room.state.phase !== 'RTM_OFFER' ||
              !room.state.rtmState ||
              room.state.rtmState.rtmFranchiseId !== client.franchiseId
            ) {
              return;
            }
            room.state = respondToRtmOffer(room.state, Boolean(msg.useRtm), playerMap, now);
            if (room.state.phase === 'SOLD') {
              room.lotTransitionAt = now + 4800;
              broadcastRoom(room, 'lot:sold');
            } else {
              broadcastRoom(room, 'rtm:update');
            }
            break;
          }

          case 'auction:rtm_counter': {
            if (
              room.state.phase !== 'RTM_COUNTER' ||
              !room.state.rtmState ||
              room.state.rtmState.winningFranchiseId !== client.franchiseId
            ) {
              return;
            }
            const counterVal = typeof msg.counterBidCr === 'number' ? msg.counterBidCr : null;
            room.state = submitRtmCounter(room.state, counterVal, playerMap, now);
            if (room.state.phase === 'SOLD') {
              room.lotTransitionAt = now + 4800;
              broadcastRoom(room, 'lot:sold');
            } else {
              broadcastRoom(room, 'rtm:update');
            }
            break;
          }

          case 'auction:rtm_final': {
            if (
              room.state.phase !== 'RTM_FINAL_MATCH' ||
              !room.state.rtmState ||
              room.state.rtmState.rtmFranchiseId !== client.franchiseId
            ) {
              return;
            }
            room.state = respondToRtmFinalMatch(room.state, Boolean(msg.matchCounter), playerMap, now);
            room.lotTransitionAt = now + 4800;
            broadcastRoom(room, 'lot:sold');
            break;
          }

          case 'auction:pause': {
            if (room.state.hostId !== client.clientId) return;
            room.state = pauseAuction(room.state, now);
            broadcastRoom(room, 'state:sync');
            break;
          }

          case 'auction:resume': {
            if (room.state.hostId !== client.clientId) return;
            room.state = resumeAuction(room.state, now);
            room.lastAIBidAt = now;
            broadcastRoom(room, 'state:sync');
            break;
          }

          case 'auction:nominate': {
            if (room.state.hostId !== client.clientId || !msg.playerId) return;
            if (room.state.phase === 'SOLD' || room.state.phase === 'UNSOLD' || room.state.phase === 'NOMINATION') {
              room.lotTransitionAt = null;
              room.state = nominateNextPlayer(room.state, playerMap, now, msg.playerId);
              room.lastAIBidAt = now + 500;
              broadcastRoom(room, 'lot:next');
            }
            break;
          }

          case 'auction:finish_now': {
            if (room.state.hostId !== client.clientId) return;
            room.state = completeAuction(room.state, now);
            broadcastRoom(room, 'auction:completed');
            break;
          }
        }
      } catch {
        // Ignore malformed socket frames
      }
    });

    ws.on('close', () => {
      if (!joinedRoomCode || !joinedClientId) return;
      const room = rooms.get(joinedRoomCode);
      if (!room) return;
      const client = room.clients.get(joinedClientId);
      room.clients.delete(joinedClientId);

      if (client) {
        const fid = client.franchiseId;
        const team = room.state.teams[fid];
        if (team && team.ownerId === joinedClientId) {
          room.state = {
            ...room.state,
            teams: {
              ...room.state.teams,
              [fid]: { ...team, isConnected: false },
            },
            updatedAt: Date.now(),
          };
        }

        // Reassign host safely if host disconnected while other humans remain
        if (room.state.hostId === joinedClientId && room.clients.size > 0) {
          const nextHost = room.clients.values().next().value as ConnectedClient | undefined;
          if (nextHost) {
            room.state = { ...room.state, hostId: nextHost.clientId };
          }
        }
        broadcastRoom(room, 'state:sync');
      }
    });
  });

  // ---- Vite Middleware (Dev) or Static Dist (Prod) ----
  if (!IS_PROD) {
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

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`IPL Auction Arena server running on http://0.0.0.0:${PORT}`);
  });
}

bootstrap();
