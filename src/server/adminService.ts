import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { INITIAL_PLAYERS } from '../data/players.ts';
import { db } from '../db/index.ts';
import { adminAccounts, customPlayers, userSessions } from '../db/schema.ts';
import type { AuctionCategory, Player, PrimaryRole, RoleSpecialty } from '../engine/types.ts';
import { hashPassword, verifyPassword } from './authService.ts';
import { generateOpaqueToken, hashToken, sanitizeText, SERVER_CONFIG } from './config.ts';

const VALID_PRIMARY_ROLES = new Set<PrimaryRole>([
  'Batter',
  'Wicketkeeper',
  'All-rounder',
  'Fast Bowler',
  'Spinner',
]);

const VALID_CATEGORIES = new Set<AuctionCategory>([
  'Marquee Set 1',
  'Marquee Set 2',
  'Capped Batters',
  'Capped All-Rounders',
  'Capped Wicketkeepers',
  'Capped Fast Bowlers',
  'Capped Spinners',
  'Uncapped Batters',
  'Uncapped All-Rounders',
  'Uncapped Wicketkeepers',
  'Uncapped Fast Bowlers',
  'Uncapped Spinners',
  'Marquee',
  'Batters',
  'All-Rounders',
  'Wicketkeepers',
  'Fast Bowlers',
  'Spinners',
  'Emerging Stars',
]);

const VALID_SECONDARY_ROLES = new Set<RoleSpecialty>([
  'Top-order Batter',
  'Middle-order Batter',
  'Finisher',
  'Wicketkeeper-Batter',
  'Pace All-rounder',
  'Spin All-rounder',
  'Fast Bowler',
  'Swing Bowler',
  'Death-over Specialist',
  'Powerplay Specialist',
  'Leg Spinner',
  'Off Spinner',
  'Left-arm Spinner',
]);

function verifyEnvAdminPasscode(candidate: string): boolean {
  const envPass = process.env.ADMIN_PASSCODE?.trim();
  if (!envPass) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(envPass);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function getAdminStatus(): Promise<{
  isClaimed: boolean;
  usingEnvPasscode: boolean;
}> {
  const hasEnv = Boolean(process.env.ADMIN_PASSCODE?.trim());
  if (hasEnv) {
    return { isClaimed: true, usingEnvPasscode: true };
  }
  try {
    const rows = await db
      .select({ id: adminAccounts.id })
      .from(adminAccounts)
      .where(eq(adminAccounts.isActive, true))
      .limit(1);
    return { isClaimed: rows.length > 0, usingEnvPasscode: false };
  } catch (error) {
    console.error('[Admin] getAdminStatus failed:', error);
    throw new Error('Could not check admin status.', { cause: error });
  }
}

export async function claimFirstRunAdmin(
  password: string,
  deviceInfo?: string
): Promise<{ token: string; expiresAt: Date }> {
  if (process.env.ADMIN_PASSCODE?.trim()) {
    throw Object.assign(new Error('Admin password is already configured.'), { statusCode: 409 });
  }
  const trimmed = typeof password === 'string' ? password.trim() : '';
  if (trimmed.length < 8 || trimmed.length > 128) {
    throw Object.assign(new Error('Admin password must be between 8 and 128 characters.'), {
      statusCode: 400,
    });
  }

  const { hash, salt } = hashPassword(trimmed);
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SERVER_CONFIG.ADMIN_SESSION_TTL_HOURS * 3_600_000);

  try {
    await db.transaction(async (tx) => {
      const existing = await tx.select({ id: adminAccounts.id }).from(adminAccounts).limit(1);
      if (existing.length > 0) {
        throw Object.assign(new Error('Admin password is already configured.'), { statusCode: 409 });
      }

      await tx.insert(adminAccounts).values({
        id: `adm_${crypto.randomBytes(8).toString('hex')}`,
        username: 'admin',
        passwordHash: hash,
        passwordSalt: salt,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });

      await tx.insert(userSessions).values({
        id: `ses_${crypto.randomBytes(12).toString('hex')}`,
        userId: null,
        tokenHash,
        sessionType: 'ADMIN',
        createdAt: now,
        expiresAt,
        lastUsedAt: now,
        deviceInfo: deviceInfo?.slice(0, 200) || null,
      });
    });

    return { token: rawToken, expiresAt };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode) throw error;
    const pgCode = (error as { code?: string; cause?: { code?: string } })?.code ||
      (error as { cause?: { code?: string } })?.cause?.code;
    if (pgCode === '23505') {
      throw Object.assign(new Error('Admin password is already configured.'), { statusCode: 409 });
    }
    console.error('[Admin] claimFirstRunAdmin failed:', error);
    throw Object.assign(new Error('Could not initialize admin account.'), { statusCode: 500 });
  }
}

export async function loginAdmin(
  password: string,
  deviceInfo?: string
): Promise<{ token: string; expiresAt: Date }> {
  const trimmed = typeof password === 'string' ? password.trim() : '';
  if (!trimmed || trimmed.length > 128) {
    throw Object.assign(new Error('Invalid admin password.'), { statusCode: 401 });
  }

  let ok = false;
  try {
    if (process.env.ADMIN_PASSCODE?.trim()) {
      ok = verifyEnvAdminPasscode(trimmed);
    } else {
      const rows = await db
        .select()
        .from(adminAccounts)
        .where(eq(adminAccounts.isActive, true))
        .limit(1);
      const acct = rows[0];
      if (acct) {
        ok = verifyPassword(trimmed, acct.passwordHash, acct.passwordSalt);
      }
    }
  } catch (error) {
    console.error('[Admin] loginAdmin DB error:', error);
    throw Object.assign(new Error('Admin authentication failed.'), { statusCode: 500 });
  }

  if (!ok) {
    throw Object.assign(new Error('Invalid admin password.'), { statusCode: 401 });
  }

  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SERVER_CONFIG.ADMIN_SESSION_TTL_HOURS * 3_600_000);

  try {
    await db.insert(userSessions).values({
      id: `ses_${crypto.randomBytes(12).toString('hex')}`,
      userId: null,
      tokenHash,
      sessionType: 'ADMIN',
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
      deviceInfo: deviceInfo?.slice(0, 200) || null,
    });
    return { token: rawToken, expiresAt };
  } catch (error) {
    console.error('[Admin] Failed to create admin session:', error);
    throw Object.assign(new Error('Could not start admin session.'), { statusCode: 500 });
  }
}

export function sanitizeAndValidatePlayer(
  raw: Record<string, unknown>,
  defaultSource = 'Admin Studio Custom Entry'
): Player | null {
  const name = sanitizeText(raw.name, 64);
  if (name.length < 2) return null;

  const country = sanitizeText(raw.country || 'India', 40) || 'India';
  const primaryRole = VALID_PRIMARY_ROLES.has(raw.primaryRole as PrimaryRole)
    ? (raw.primaryRole as PrimaryRole)
    : 'Batter';
  const secondaryRole = VALID_SECONDARY_ROLES.has(raw.secondaryRole as RoleSpecialty)
    ? (raw.secondaryRole as RoleSpecialty)
    : 'Top-order Batter';
  const category = VALID_CATEGORIES.has(raw.category as AuctionCategory)
    ? (raw.category as AuctionCategory)
    : 'Emerging Stars';

  const rawId = sanitizeText(raw.id, 60)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '');
  const slugId =
    rawId ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  if (!slugId) return null;

  const statsInput = (raw.stats && typeof raw.stats === 'object' ? raw.stats : {}) as Record<
    string,
    unknown
  >;
  const ratingsInput = (raw.ratings && typeof raw.ratings === 'object'
    ? raw.ratings
    : {}) as Record<string, unknown>;

  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return {
    id: slugId,
    name,
    country,
    countryCode:
      sanitizeText(raw.countryCode || (country === 'India' ? 'IN' : 'AU'), 4).toUpperCase() || 'IN',
    isOverseas: Boolean(raw.isOverseas ?? country.toLowerCase() !== 'india'),
    isCapped: Boolean(raw.isCapped ?? true),
    age: Math.max(16, Math.min(50, Math.round(num(raw.age, 25)))),
    battingStyle: raw.battingStyle === 'Left-hand bat' ? 'Left-hand bat' : 'Right-hand bat',
    bowlingStyle: sanitizeText(raw.bowlingStyle || 'Right-arm medium', 40) || 'Right-arm medium',
    primaryRole,
    secondaryRole,
    specialtyTags: Array.isArray(raw.specialtyTags)
      ? raw.specialtyTags.map((t) => sanitizeText(t, 28)).filter(Boolean).slice(0, 5)
      : ['Custom Entry'],
    previousFranchises: Array.isArray(raw.previousFranchises)
      ? raw.previousFranchises.map((f) => sanitizeText(f, 12)).filter(Boolean).slice(0, 10)
      : [],
    category,
    basePriceCr: Math.max(0.2, Math.min(5, num(raw.basePriceCr, 0.5))),
    jerseyNumber: Math.max(1, Math.min(999, Math.round(num(raw.jerseyNumber, 10)))),
    stats: {
      matches: Math.max(0, Math.round(num(raw.matches ?? statsInput.matches, 0))),
      runs: Math.max(0, Math.round(num(raw.runs ?? statsInput.runs, 0))),
      battingAvg: Math.max(0, num(raw.battingAvg ?? statsInput.battingAvg, 0)),
      strikeRate: Math.max(0, num(raw.strikeRate ?? statsInput.strikeRate, 0)),
      highestScore: sanitizeText(raw.highestScore ?? statsInput.highestScore ?? '0', 10) || '0',
      fifties: Math.max(0, Math.round(num(raw.fifties ?? statsInput.fifties, 0))),
      hundreds: Math.max(0, Math.round(num(raw.hundreds ?? statsInput.hundreds, 0))),
      wickets: Math.max(0, Math.round(num(raw.wickets ?? statsInput.wickets, 0))),
      bowlingAvg: Math.max(0, num(raw.bowlingAvg ?? statsInput.bowlingAvg, 0)),
      economy: Math.max(0, num(raw.economy ?? statsInput.economy, 0)),
      bowlingStrikeRate: Math.max(0, num(raw.bowlingStrikeRate ?? statsInput.bowlingStrikeRate, 0)),
      bestBowling: sanitizeText(raw.bestBowling ?? statsInput.bestBowling ?? '-', 10) || '-',
      catches: Math.max(0, Math.round(num(raw.catches ?? statsInput.catches, 0))),
    },
    recentSeasons: Array.isArray(raw.recentSeasons) ? (raw.recentSeasons as Player['recentSeasons']).slice(0, 6) : [],
    strengths: Array.isArray(raw.strengths)
      ? raw.strengths.map((s) => sanitizeText(s, 100)).filter(Boolean).slice(0, 5)
      : ['Custom scouted player'],
    weaknesses: Array.isArray(raw.weaknesses)
      ? raw.weaknesses.map((s) => sanitizeText(s, 100)).filter(Boolean).slice(0, 5)
      : ['Limited sample size'],
    ratings: {
      overall: Math.max(40, Math.min(99, Math.round(num(raw.overall ?? ratingsInput.overall, 78)))),
      batting: Math.max(10, Math.min(99, Math.round(num(raw.batting ?? ratingsInput.batting, 75)))),
      bowling: Math.max(10, Math.min(99, Math.round(num(raw.bowling ?? ratingsInput.bowling, 50)))),
      fielding: Math.max(10, Math.min(99, Math.round(num(raw.fielding ?? ratingsInput.fielding, 78)))),
      form: Math.max(10, Math.min(99, Math.round(num(raw.form ?? ratingsInput.form, 78)))),
      potential: Math.max(10, Math.min(99, Math.round(num(raw.potential ?? ratingsInput.potential, 82)))),
      captaincy: Math.max(10, Math.min(99, Math.round(num(raw.captaincy ?? ratingsInput.captaincy, 65)))),
      estimatedValueCr: Math.max(
        0.3,
        Math.min(25, num(raw.estimatedValueCr ?? ratingsInput.estimatedValueCr, 3.5))
      ),
    },
    dataSource: sanitizeText(raw.dataSource || defaultSource, 80) || defaultSource,
    lastUpdated: new Date().toISOString().slice(0, 10),
  };
}

let cachedCustomPlayers: { players: Player[]; fetchedAt: number } | null = null;
const CUSTOM_PLAYER_CACHE_TTL_MS = 10_000;

export function invalidateCustomPlayersCache(): void {
  cachedCustomPlayers = null;
}

export async function listCustomPlayers(bypassCache = false): Promise<Player[]> {
  if (
    !bypassCache &&
    cachedCustomPlayers &&
    Date.now() - cachedCustomPlayers.fetchedAt < CUSTOM_PLAYER_CACHE_TTL_MS
  ) {
    return cachedCustomPlayers.players;
  }
  try {
    const rows = await db.select({ playerJson: customPlayers.playerJson }).from(customPlayers);
    const list = rows.map((r) => r.playerJson);
    cachedCustomPlayers = { players: list, fetchedAt: Date.now() };
    return list;
  } catch (error) {
    console.error('[Players] listCustomPlayers failed:', error);
    return cachedCustomPlayers?.players ?? [];
  }
}

export async function getMergedPlayers(bypassCache = false): Promise<Player[]> {
  const custom = await listCustomPlayers(bypassCache);
  const byId = new Map<string, Player>();
  for (const p of INITIAL_PLAYERS) byId.set(p.id, p);
  for (const p of custom) byId.set(p.id, p);
  return Array.from(byId.values());
}

export async function getMergedPlayerMap(bypassCache = false): Promise<Record<string, Player>> {
  const all = await getMergedPlayers(bypassCache);
  const map: Record<string, Player> = {};
  for (const p of all) map[p.id] = p;
  return map;
}

export async function upsertCustomPlayer(
  raw: Record<string, unknown>,
  createdBy: string
): Promise<{ player: Player; players: Player[] }> {
  const safePlayer = sanitizeAndValidatePlayer(raw, 'Admin Studio Custom Entry');
  if (!safePlayer) {
    throw Object.assign(new Error('Player name, country, and valid primaryRole are required.'), {
      statusCode: 400,
    });
  }

  const now = new Date();
  try {
    await db
      .insert(customPlayers)
      .values({
        id: safePlayer.id,
        playerJson: safePlayer,
        createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: customPlayers.id,
        set: {
          playerJson: safePlayer,
          updatedAt: now,
        },
      });
    invalidateCustomPlayersCache();
    const players = await getMergedPlayers(true);
    return { player: safePlayer, players };
  } catch (error) {
    console.error('[Admin] upsertCustomPlayer failed:', error);
    throw Object.assign(new Error('Could not save custom player.'), { statusCode: 500 });
  }
}

export async function bulkImportCustomPlayers(
  incoming: unknown[],
  createdBy: string
): Promise<{ imported: number; skippedDuplicates: number; invalidCount: number; players: Player[] }> {
  if (!Array.isArray(incoming) || incoming.length === 0 || incoming.length > 200) {
    throw Object.assign(new Error('Provide an array of 1 to 200 player records.'), {
      statusCode: 400,
    });
  }

  const existingIds = new Set(INITIAL_PLAYERS.map((p) => p.id));
  const now = new Date();

  try {
    const counts = await db.transaction(async (tx) => {
      const existingCustom = await tx.select({ id: customPlayers.id }).from(customPlayers);
      for (const row of existingCustom) existingIds.add(row.id);

      let imported = 0;
      let skippedDuplicates = 0;
      let invalidCount = 0;
      const toInsert: Array<{
        id: string;
        playerJson: Player;
        createdBy: string;
        createdAt: Date;
        updatedAt: Date;
      }> = [];

      for (const item of incoming) {
        if (!item || typeof item !== 'object') {
          invalidCount += 1;
          continue;
        }
        const safePlayer = sanitizeAndValidatePlayer(
          item as Record<string, unknown>,
          'Admin Bulk Import'
        );
        if (!safePlayer) {
          invalidCount += 1;
          continue;
        }
        if (existingIds.has(safePlayer.id)) {
          skippedDuplicates += 1;
          continue;
        }
        existingIds.add(safePlayer.id);
        toInsert.push({
          id: safePlayer.id,
          playerJson: safePlayer,
          createdBy,
          createdAt: now,
          updatedAt: now,
        });
        imported += 1;
      }

      if (toInsert.length > 0) {
        await tx.insert(customPlayers).values(toInsert).onConflictDoNothing();
      }
      return { imported, skippedDuplicates, invalidCount };
    });

    invalidateCustomPlayersCache();
    const players = await getMergedPlayers(true);
    return { ...counts, players };
  } catch (error) {
    console.error('[Admin] bulkImportCustomPlayers failed:', error);
    throw Object.assign(new Error('Bulk player import failed.'), { statusCode: 500 });
  }
}
