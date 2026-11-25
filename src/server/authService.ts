import crypto from 'crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { FRANCHISE_MAP } from '../data/franchises.ts';
import { db } from '../db/index.ts';
import { guestSessions, userSessions, users } from '../db/schema.ts';
import type { FranchiseId, UserProfile } from '../engine/types.ts';
import { verifyFirebaseIdToken } from '../lib/firebase-admin.ts';
import {
  generateOpaqueToken,
  hashToken,
  isValidEmail,
  isValidFranchiseId,
  normalizeEmail,
  sanitizeText,
  SERVER_CONFIG,
} from './config.ts';

const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };
// Precomputed dummy salt/hash used to prevent user-enumeration timing leaks on login
const DUMMY_SALT = '00112233445566778899aabbccddeeff';
const DUMMY_HASH = crypto
  .scryptSync('dummy-timing-guard-password', DUMMY_SALT, SCRYPT_KEYLEN, SCRYPT_OPTIONS)
  .toString('hex');

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS).toString('hex');
  return { hash: derived, salt };
}

export function verifyPassword(password: string, expectedHash: string, salt: string): boolean {
  try {
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
    const expectedBuf = Buffer.from(expectedHash, 'hex');
    if (derived.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(derived, expectedBuf);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters long.';
  if (password.length > 128) return 'Password must be 128 characters or fewer.';
  if (password.trim().length < 8) return 'Password cannot be mostly whitespace.';
  return null;
}

export interface AuthenticatedSession {
  sessionId: string;
  sessionType: 'USER' | 'GUEST' | 'ADMIN';
  userId: string | null;
  guestSessionId: string | null;
  username: string;
  email?: string;
  isGuest: boolean;
  favoriteFranchise: FranchiseId;
  avatarColor: string;
  profile: UserProfile;
  expiresAt: Date;
}

export interface AuthResult {
  token: string;
  sessionId: string;
  expiresAt: Date;
  profile: UserProfile;
  isGuest: boolean;
}

function defaultStats(): UserProfile['stats'] {
  return {
    auctionsPlayed: 0,
    auctionsWon: 0,
    bestRating: 0,
    avgRating: 0,
    tournamentsWon: 0,
  };
}

function toUserProfile(row: typeof users.$inferSelect): UserProfile {
  const fav = isValidFranchiseId(row.favoriteFranchise) ? row.favoriteFranchise : 'CSK';
  return {
    id: row.id,
    username: row.username,
    email: row.normalizedEmail,
    isGuest: false,
    authProvider: row.firebaseUid ? 'google' : 'local',
    favoriteFranchise: fav,
    avatarColor: row.avatarColor || FRANCHISE_MAP[fav].primaryColor,
    stats: row.statsJson ?? defaultStats(),
  };
}

function toGuestProfile(guest: typeof guestSessions.$inferSelect): UserProfile {
  const fav = isValidFranchiseId(guest.favoriteFranchise) ? guest.favoriteFranchise : 'CSK';
  return {
    id: guest.guestIdentifier,
    username: guest.username,
    isGuest: true,
    authProvider: 'guest',
    favoriteFranchise: fav,
    avatarColor: FRANCHISE_MAP[fav].primaryColor,
    stats: defaultStats(),
  };
}

export class AuthError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export async function registerUser(params: {
  email: unknown;
  username: unknown;
  password: unknown;
  favoriteFranchise?: unknown;
  deviceInfo?: string;
}): Promise<AuthResult> {
  const email = normalizeEmail(params.email);
  const username = sanitizeText(params.username, 40);
  const password = typeof params.password === 'string' ? params.password : '';
  const favoriteFranchise: FranchiseId = isValidFranchiseId(params.favoriteFranchise)
    ? params.favoriteFranchise
    : 'CSK';

  if (!isValidEmail(email)) {
    throw new AuthError(400, 'Please enter a valid email address.');
  }
  if (username.length < 2) {
    throw new AuthError(400, 'Username must be at least 2 characters.');
  }
  const pwErr = validatePasswordStrength(password);
  if (pwErr) {
    throw new AuthError(400, pwErr);
  }

  const { hash, salt } = hashPassword(password);
  const userId = `usr_${crypto.randomBytes(10).toString('hex')}`;
  const sessionId = `ses_${crypto.randomBytes(12).toString('hex')}`;
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SERVER_CONFIG.SESSION_TTL_HOURS * 3_600_000);

  try {
    const createdUser = await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.normalizedEmail, email))
        .limit(1);

      if (existing.length > 0) {
        throw new AuthError(409, 'An account with this email already exists.');
      }

      const [inserted] = await tx
        .insert(users)
        .values({
          id: userId,
          username,
          normalizedEmail: email,
          passwordHash: hash,
          passwordSalt: salt,
          favoriteFranchise,
          avatarColor: FRANCHISE_MAP[favoriteFranchise].primaryColor,
          statsJson: defaultStats(),
          createdAt: now,
          updatedAt: now,
          isActive: true,
        })
        .returning();

      await tx.insert(userSessions).values({
        id: sessionId,
        userId: inserted.id,
        tokenHash,
        sessionType: 'USER',
        createdAt: now,
        expiresAt,
        lastUsedAt: now,
        deviceInfo: params.deviceInfo?.slice(0, 200) || null,
      });

      return inserted;
    });

    return {
      token: rawToken,
      sessionId,
      expiresAt,
      profile: toUserProfile(createdUser),
      isGuest: false,
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    const pgCode = (error as { code?: string; cause?: { code?: string } })?.code ||
      (error as { cause?: { code?: string } })?.cause?.code;
    if (pgCode === '23505') {
      throw new AuthError(409, 'An account with this email already exists.');
    }
    console.error('[Auth] registerUser failed:', error);
    throw new AuthError(500, 'Could not complete registration. Please try again.');
  }
}

export async function loginUser(params: {
  email: unknown;
  password: unknown;
  deviceInfo?: string;
}): Promise<AuthResult> {
  const email = normalizeEmail(params.email);
  const password = typeof params.password === 'string' ? params.password : '';

  if (!email || !password || password.length > 128) {
    // Timing-safe guard
    verifyPassword(password.slice(0, 64), DUMMY_HASH, DUMMY_SALT);
    throw new AuthError(401, 'Invalid email or password.');
  }

  try {
    const found = await db
      .select()
      .from(users)
      .where(and(eq(users.normalizedEmail, email), eq(users.isActive, true)))
      .limit(1);

    const user = found[0];
    if (!user || !user.passwordHash || !user.passwordSalt) {
      verifyPassword(password, DUMMY_HASH, DUMMY_SALT);
      throw new AuthError(401, 'Invalid email or password.');
    }

    const valid = verifyPassword(password, user.passwordHash, user.passwordSalt);
    if (!valid) {
      throw new AuthError(401, 'Invalid email or password.');
    }

    const sessionId = `ses_${crypto.randomBytes(12).toString('hex')}`;
    const rawToken = generateOpaqueToken();
    const tokenHash = hashToken(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SERVER_CONFIG.SESSION_TTL_HOURS * 3_600_000);

    await db.insert(userSessions).values({
      id: sessionId,
      userId: user.id,
      tokenHash,
      sessionType: 'USER',
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
      deviceInfo: params.deviceInfo?.slice(0, 200) || null,
    });

    return {
      token: rawToken,
      sessionId,
      expiresAt,
      profile: toUserProfile(user),
      isGuest: false,
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    console.error('[Auth] loginUser failed:', error);
    throw new AuthError(500, 'Authentication service unavailable. Please try again.');
  }
}

export async function createGuestSession(params: {
  username?: unknown;
  favoriteFranchise?: unknown;
  deviceInfo?: string;
}): Promise<AuthResult> {
  const username = sanitizeText(params.username, 40) || 'Franchise Owner';
  const favoriteFranchise: FranchiseId = isValidFranchiseId(params.favoriteFranchise)
    ? params.favoriteFranchise
    : 'CSK';

  const guestId = `gst_${crypto.randomBytes(10).toString('hex')}`;
  const guestIdentifier = `owner_${crypto.randomBytes(8).toString('hex')}`;
  const sessionId = `ses_${crypto.randomBytes(12).toString('hex')}`;
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SERVER_CONFIG.GUEST_SESSION_TTL_HOURS * 3_600_000);

  try {
    const guestRow = await db.transaction(async (tx) => {
      const [insertedGuest] = await tx
        .insert(guestSessions)
        .values({
          id: guestId,
          guestIdentifier,
          username,
          favoriteFranchise,
          tokenHash,
          createdAt: now,
          expiresAt,
        })
        .returning();

      await tx.insert(userSessions).values({
        id: sessionId,
        userId: null,
        guestSessionId: insertedGuest.id,
        tokenHash,
        sessionType: 'GUEST',
        createdAt: now,
        expiresAt,
        lastUsedAt: now,
        deviceInfo: params.deviceInfo?.slice(0, 200) || null,
      });

      return insertedGuest;
    });

    return {
      token: rawToken,
      sessionId,
      expiresAt,
      profile: toGuestProfile(guestRow),
      isGuest: true,
    };
  } catch (error) {
    console.error('[Auth] createGuestSession failed:', error);
    throw new AuthError(500, 'Could not initialize guest session. Please try again.');
  }
}

export async function exchangeFirebaseIdToken(params: {
  idToken: string;
  favoriteFranchise?: unknown;
  deviceInfo?: string;
}): Promise<AuthResult> {
  if (!params.idToken || typeof params.idToken !== 'string') {
    throw new AuthError(401, 'Missing Firebase ID token.');
  }

  let decoded;
  try {
    decoded = await verifyFirebaseIdToken(params.idToken);
  } catch {
    throw new AuthError(401, 'Invalid or expired Google sign-in token.');
  }

  const email = normalizeEmail(decoded.email || `${decoded.uid}@firebase.local`);
  const username = sanitizeText(decoded.name || email.split('@')[0], 40) || 'Franchise Owner';
  const favoriteFranchise: FranchiseId = isValidFranchiseId(params.favoriteFranchise)
    ? params.favoriteFranchise
    : 'CSK';

  const now = new Date();
  const sessionId = `ses_${crypto.randomBytes(12).toString('hex')}`;
  const rawToken = generateOpaqueToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(now.getTime() + SERVER_CONFIG.SESSION_TTL_HOURS * 3_600_000);

  try {
    const userRow = await db.transaction(async (tx) => {
      const existingByUid = await tx
        .select()
        .from(users)
        .where(eq(users.firebaseUid, decoded.uid))
        .limit(1);

      let activeUser = existingByUid[0];

      if (!activeUser) {
        const existingByEmail = await tx
          .select()
          .from(users)
          .where(eq(users.normalizedEmail, email))
          .limit(1);

        if (existingByEmail[0]) {
          const [updated] = await tx
            .update(users)
            .set({
              firebaseUid: decoded.uid,
              updatedAt: now,
            })
            .where(eq(users.id, existingByEmail[0].id))
            .returning();
          activeUser = updated;
        } else {
          const [inserted] = await tx
            .insert(users)
            .values({
              id: `usr_${crypto.randomBytes(10).toString('hex')}`,
              firebaseUid: decoded.uid,
              username,
              normalizedEmail: email,
              passwordHash: null,
              passwordSalt: null,
              favoriteFranchise,
              avatarColor: FRANCHISE_MAP[favoriteFranchise].primaryColor,
              statsJson: defaultStats(),
              createdAt: now,
              updatedAt: now,
              isActive: true,
            })
            .onConflictDoUpdate({
              target: users.normalizedEmail,
              set: { firebaseUid: decoded.uid, updatedAt: now },
            })
            .returning();
          activeUser = inserted;
        }
      }

      await tx.insert(userSessions).values({
        id: sessionId,
        userId: activeUser.id,
        tokenHash,
        sessionType: 'USER',
        createdAt: now,
        expiresAt,
        lastUsedAt: now,
        deviceInfo: params.deviceInfo?.slice(0, 200) || null,
      });

      return activeUser;
    });

    return {
      token: rawToken,
      sessionId,
      expiresAt,
      profile: {
        ...toUserProfile(userRow),
        photoURL: decoded.picture || undefined,
        authProvider: 'google',
      },
      isGuest: false,
    };
  } catch (error) {
    console.error('[Auth] exchangeFirebaseIdToken failed:', error);
    throw new AuthError(500, 'Could not sync Google session.');
  }
}

export async function authenticateSessionToken(
  rawToken: string | null | undefined,
  allowedTypes: Array<'USER' | 'GUEST' | 'ADMIN'> = ['USER', 'GUEST']
): Promise<AuthenticatedSession | null> {
  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 16) return null;
  const tokenHash = hashToken(rawToken);
  const now = new Date();

  try {
    const rows = await db
      .select()
      .from(userSessions)
      .where(
        and(
          eq(userSessions.tokenHash, tokenHash),
          isNull(userSessions.revokedAt),
          gt(userSessions.expiresAt, now)
        )
      )
      .limit(1);

    const session = rows[0];
    if (!session) return null;
    if (!allowedTypes.includes(session.sessionType as 'USER' | 'GUEST' | 'ADMIN')) return null;

    // Throttle last_used_at updates to once per minute to keep hot paths light
    if (now.getTime() - session.lastUsedAt.getTime() > 60_000) {
      void db
        .update(userSessions)
        .set({ lastUsedAt: now })
        .where(eq(userSessions.id, session.id))
        .catch(() => {});
    }

    if (session.sessionType === 'ADMIN') {
      return {
        sessionId: session.id,
        sessionType: 'ADMIN',
        userId: null,
        guestSessionId: null,
        username: 'Admin Studio',
        isGuest: false,
        favoriteFranchise: 'CSK',
        avatarColor: '#F59E0B',
        profile: {
          id: session.id,
          username: 'Admin Studio',
          isGuest: false,
          favoriteFranchise: 'CSK',
          avatarColor: '#F59E0B',
          stats: defaultStats(),
        },
        expiresAt: session.expiresAt,
      };
    }

    if (session.sessionType === 'USER' && session.userId) {
      const userRows = await db
        .select()
        .from(users)
        .where(and(eq(users.id, session.userId), eq(users.isActive, true)))
        .limit(1);
      const user = userRows[0];
      if (!user) return null;
      const profile = toUserProfile(user);
      return {
        sessionId: session.id,
        sessionType: 'USER',
        userId: user.id,
        guestSessionId: null,
        username: user.username,
        email: user.normalizedEmail,
        isGuest: false,
        favoriteFranchise: profile.favoriteFranchise,
        avatarColor: profile.avatarColor,
        profile,
        expiresAt: session.expiresAt,
      };
    }

    if (session.sessionType === 'GUEST' && session.guestSessionId) {
      const guestRows = await db
        .select()
        .from(guestSessions)
        .where(
          and(
            eq(guestSessions.id, session.guestSessionId),
            isNull(guestSessions.revokedAt),
            gt(guestSessions.expiresAt, now)
          )
        )
        .limit(1);
      const guest = guestRows[0];
      if (!guest) return null;
      const profile = toGuestProfile(guest);
      return {
        sessionId: session.id,
        sessionType: 'GUEST',
        userId: null,
        guestSessionId: guest.id,
        username: guest.username,
        isGuest: true,
        favoriteFranchise: profile.favoriteFranchise,
        avatarColor: profile.avatarColor,
        profile,
        expiresAt: session.expiresAt,
      };
    }

    return null;
  } catch (error) {
    console.error('[Auth] authenticateSessionToken failed:', error);
    return null;
  }
}

/**
 * Rotates the bearer token on the SAME session row ID so any active multiplayer
 * room participation (`room_participants.session_id`) stays intact seamlessly.
 */
export async function refreshSessionToken(rawToken: string): Promise<AuthResult | null> {
  const existing = await authenticateSessionToken(rawToken, ['USER', 'GUEST']);
  if (!existing) return null;

  const newToken = generateOpaqueToken();
  const newTokenHash = hashToken(newToken);
  const now = new Date();
  const ttlHours =
    existing.sessionType === 'GUEST'
      ? SERVER_CONFIG.GUEST_SESSION_TTL_HOURS
      : SERVER_CONFIG.SESSION_TTL_HOURS;
  const newExpiresAt = new Date(now.getTime() + ttlHours * 3_600_000);

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(userSessions)
        .set({
          tokenHash: newTokenHash,
          expiresAt: newExpiresAt,
          lastUsedAt: now,
        })
        .where(eq(userSessions.id, existing.sessionId));

      if (existing.guestSessionId) {
        await tx
          .update(guestSessions)
          .set({
            tokenHash: newTokenHash,
            expiresAt: newExpiresAt,
          })
          .where(eq(guestSessions.id, existing.guestSessionId));
      }
    });

    return {
      token: newToken,
      sessionId: existing.sessionId,
      expiresAt: newExpiresAt,
      profile: existing.profile,
      isGuest: existing.isGuest,
    };
  } catch (error) {
    console.error('[Auth] refreshSessionToken failed:', error);
    throw new AuthError(500, 'Could not refresh session.');
  }
}

export async function revokeSessionToken(rawToken: string | null | undefined): Promise<boolean> {
  if (!rawToken || rawToken.length < 16) return false;
  const tokenHash = hashToken(rawToken);
  const now = new Date();
  try {
    const updated = await db
      .update(userSessions)
      .set({ revokedAt: now })
      .where(and(eq(userSessions.tokenHash, tokenHash), isNull(userSessions.revokedAt)))
      .returning({ id: userSessions.id, guestSessionId: userSessions.guestSessionId });

    if (updated[0]?.guestSessionId) {
      await db
        .update(guestSessions)
        .set({ revokedAt: now })
        .where(eq(guestSessions.id, updated[0].guestSessionId));
    }
    return updated.length > 0;
  } catch (error) {
    console.error('[Auth] revokeSessionToken failed:', error);
    return false;
  }
}

export async function updateSessionProfile(
  session: AuthenticatedSession,
  patch: { username?: unknown; favoriteFranchise?: unknown }
): Promise<UserProfile> {
  const nextUsername =
    patch.username !== undefined ? sanitizeText(patch.username, 40) : session.username;
  const nextFav: FranchiseId = isValidFranchiseId(patch.favoriteFranchise)
    ? patch.favoriteFranchise
    : session.favoriteFranchise;

  if (nextUsername.length < 2) {
    throw new AuthError(400, 'Username must be at least 2 characters.');
  }

  const now = new Date();
  try {
    if (session.userId) {
      const [updated] = await db
        .update(users)
        .set({
          username: nextUsername,
          favoriteFranchise: nextFav,
          avatarColor: FRANCHISE_MAP[nextFav].primaryColor,
          updatedAt: now,
        })
        .where(eq(users.id, session.userId))
        .returning();
      return updated ? toUserProfile(updated) : session.profile;
    }

    if (session.guestSessionId) {
      const [updated] = await db
        .update(guestSessions)
        .set({
          username: nextUsername,
          favoriteFranchise: nextFav,
        })
        .where(eq(guestSessions.id, session.guestSessionId))
        .returning();
      return updated ? toGuestProfile(updated) : session.profile;
    }

    return session.profile;
  } catch (error) {
    console.error('[Auth] updateSessionProfile failed:', error);
    throw new AuthError(500, 'Could not update profile.');
  }
}

export async function pruneExpiredSessions(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - 24 * 3_600_000);
    const deleted = await db
      .delete(userSessions)
      .where(lt(userSessions.expiresAt, cutoff))
      .returning({ id: userSessions.id });
    return deleted.length;
  } catch (error) {
    console.error('[Auth] pruneExpiredSessions failed:', error);
    return 0;
  }
}
