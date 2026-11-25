import crypto from 'crypto';
import type express from 'express';
import { ALL_FRANCHISE_IDS } from '../data/franchises.ts';
import type { FranchiseId } from '../engine/types.ts';

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export const SERVER_CONFIG = {
  PORT: envInt('PORT', 3000, 1, 65535),
  IS_PROD: process.env.NODE_ENV === 'production',
  TRUST_PROXY_HOPS: envInt('TRUST_PROXY_HOPS', 1, 0, 10),
  SESSION_TTL_HOURS: envInt('SESSION_TTL_HOURS', 168, 1, 24 * 90),
  GUEST_SESSION_TTL_HOURS: envInt('GUEST_SESSION_TTL_HOURS', 72, 1, 24 * 30),
  ADMIN_SESSION_TTL_HOURS: envInt('ADMIN_SESSION_TTL_HOURS', 12, 1, 24 * 7),
  ROOM_RECONNECT_GRACE_SECONDS: envInt('ROOM_RECONNECT_GRACE_SECONDS', 90, 5, 3600),
  ROOM_RETENTION_HOURS: envInt('ROOM_RETENTION_HOURS', 24, 1, 24 * 14),
  RATE_LIMIT_WINDOW_MS: envInt('RATE_LIMIT_WINDOW_MS', 60_000, 1000, 3_600_000),
  RATE_LIMIT_MAX_REQUESTS: envInt('RATE_LIMIT_MAX_REQUESTS', 60, 5, 10_000),
  WS_MAX_PAYLOAD_BYTES: envInt('WS_MAX_PAYLOAD_BYTES', 32_768, 2048, 262_144),
  WS_HEARTBEAT_INTERVAL_MS: envInt('WS_HEARTBEAT_INTERVAL_MS', 25_000, 5_000, 120_000),
  SCHEDULER_TICK_MS: 500,
  SCHEDULER_LEASE_MS: 4_000,
  INSTANCE_ID: `inst_${crypto.randomBytes(6).toString('hex')}`,
  SESSION_COOKIE_NAME: 'ipl_arena_session',
  ADMIN_COOKIE_NAME: 'ipl_arena_admin',
} as const;

export function sanitizeText(input: unknown, maxLen = 64): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[<>]/g, '').trim().slice(0, maxLen);
}

export function isValidFranchiseId(id: unknown): id is FranchiseId {
  return typeof id === 'string' && (ALL_FRANCHISE_IDS as string[]).includes(id);
}

export function normalizeEmail(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.trim().toLowerCase().slice(0, 160);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return email.length >= 5 && email.length <= 160 && EMAIL_REGEX.test(email);
}

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export function extractBearerToken(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length >= 16 ? token : null;
}

export function extractSessionToken(req: express.Request): string | null {
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;
  const cookies = parseCookieHeader(req.headers.cookie);
  const cookieToken = cookies[SERVER_CONFIG.SESSION_COOKIE_NAME];
  return cookieToken && cookieToken.length >= 16 ? cookieToken : null;
}

export function extractAdminToken(req: express.Request): string | null {
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;
  const cookies = parseCookieHeader(req.headers.cookie);
  const cookieToken = cookies[SERVER_CONFIG.ADMIN_COOKIE_NAME];
  return cookieToken && cookieToken.length >= 16 ? cookieToken : null;
}

function isSecureRequest(req: express.Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  return SERVER_CONFIG.IS_PROD;
}

export function setSessionCookie(
  req: express.Request,
  res: express.Response,
  cookieName: string,
  token: string,
  expiresAt: Date
): void {
  const secure = isSecureRequest(req);
  const parts = [
    `${cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}`,
  ];
  if (secure) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  const existing = res.getHeader('Set-Cookie');
  const nextCookie = parts.join('; ');
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, nextCookie]);
  } else if (typeof existing === 'string') {
    res.setHeader('Set-Cookie', [existing, nextCookie]);
  } else {
    res.setHeader('Set-Cookie', nextCookie);
  }
}

export function clearSessionCookie(
  req: express.Request,
  res: express.Response,
  cookieName: string
): void {
  const secure = isSecureRequest(req);
  const parts = [
    `${cookieName}=`,
    'Path=/',
    'HttpOnly',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ];
  if (secure) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function getClientIp(req: express.Request): string {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return ip.slice(0, 64);
}

/**
 * Lightweight CSRF protection for cookie-authenticated state-changing endpoints:
 * - Requests carrying an explicit Authorization: Bearer header are immune to CSRF.
 * - Cookie-only mutations must include either X-Requested-With header or matching Origin/Host.
 */
export function passesCsrfCheck(req: express.Request): boolean {
  if (extractBearerToken(req)) return true;
  if (req.headers['x-requested-with']) return true;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host) {
    try {
      const parsed = new URL(origin);
      if (parsed.host === host) return true;
    } catch {
      return false;
    }
  }
  // Allow non-browser / test clients without cookies
  if (!req.headers.cookie) return true;
  return false;
}
