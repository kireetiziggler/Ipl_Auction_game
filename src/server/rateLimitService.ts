import { lt, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { rateLimitBuckets } from '../db/schema.ts';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAtMs: number;
}

/**
 * Shared PostgreSQL-backed rate limiter safe across multiple server instances.
 * Uses an atomic INSERT ... ON CONFLICT DO UPDATE upsert that resets expired windows cleanly.
 */
export async function checkPersistentRateLimit(
  bucketKey: string,
  maxRequests: number,
  windowMs: number,
  options?: { failClosed?: boolean }
): Promise<RateLimitDecision> {
  const now = new Date();
  const nextExpiry = new Date(now.getTime() + windowMs);

  try {
    const result = await db
      .insert(rateLimitBuckets)
      .values({
        bucketKey,
        windowStartedAt: now,
        expiresAt: nextExpiry,
        requestCount: 1,
      })
      .onConflictDoUpdate({
        target: rateLimitBuckets.bucketKey,
        set: {
          windowStartedAt: sql`CASE WHEN ${rateLimitBuckets.expiresAt} <= ${now} THEN ${now} ELSE ${rateLimitBuckets.windowStartedAt} END`,
          expiresAt: sql`CASE WHEN ${rateLimitBuckets.expiresAt} <= ${now} THEN ${nextExpiry} ELSE ${rateLimitBuckets.expiresAt} END`,
          requestCount: sql`CASE WHEN ${rateLimitBuckets.expiresAt} <= ${now} THEN 1 ELSE ${rateLimitBuckets.requestCount} + 1 END`,
        },
      })
      .returning({
        requestCount: rateLimitBuckets.requestCount,
        expiresAt: rateLimitBuckets.expiresAt,
      });

    const row = result[0];
    if (!row) {
      return { allowed: true, remaining: Math.max(0, maxRequests - 1), resetAtMs: nextExpiry.getTime() };
    }
    const allowed = row.requestCount <= maxRequests;
    return {
      allowed,
      remaining: Math.max(0, maxRequests - row.requestCount),
      resetAtMs: row.expiresAt.getTime(),
    };
  } catch (error) {
    console.error('[RateLimit] PostgreSQL rate limit query failed:', error);
    if (options?.failClosed) {
      return { allowed: false, remaining: 0, resetAtMs: nextExpiry.getTime() };
    }
    return { allowed: true, remaining: 1, resetAtMs: nextExpiry.getTime() };
  }
}

export async function pruneExpiredRateLimitBuckets(): Promise<number> {
  try {
    const deleted = await db
      .delete(rateLimitBuckets)
      .where(lt(rateLimitBuckets.expiresAt, new Date()))
      .returning({ bucketKey: rateLimitBuckets.bucketKey });
    return deleted.length;
  } catch (error) {
    console.error('[RateLimit] Failed to prune expired buckets:', error);
    return 0;
  }
}
