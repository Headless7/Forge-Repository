import { rawSql } from "./db";
import { rateLimited } from "./errors";

/**
 * Fixed-window rate limiter kept in process memory. The interface is small on
 * purpose so it can be backed by Redis/Upstash when running multiple instances.
 */
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number };
  /** Checks the budget without spending it (used to count only failed attempts). */
  check(key: string, limit: number): { ok: boolean; retryAfterMs: number };
}

class MemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = Date.now();

  check(key: string, limit: number) {
    const bucket = this.buckets.get(key);
    const t = Date.now();
    if (!bucket || bucket.resetAt <= t) return { ok: true, retryAfterMs: 0 };
    return { ok: bucket.count < limit, retryAfterMs: bucket.resetAt - t };
  }

  consume(key: string, limit: number, windowMs: number) {
    const t = Date.now();
    if (t - this.lastSweep > 60_000) this.sweep(t);
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      this.buckets.set(key, { count: 1, resetAt: t + windowMs });
      return { ok: true, retryAfterMs: 0 };
    }
    bucket.count += 1;
    if (bucket.count > limit) return { ok: false, retryAfterMs: bucket.resetAt - t };
    return { ok: true, retryAfterMs: 0 };
  }

  private sweep(t: number) {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= t) this.buckets.delete(key);
    this.lastSweep = t;
  }
}

const g = globalThis as unknown as { __forgeRateLimiter?: RateLimiter };
// Re-create after hot reloads that changed the limiter's shape (development only).
if (typeof g.__forgeRateLimiter?.check !== "function") g.__forgeRateLimiter = new MemoryRateLimiter();
export const rateLimiter: RateLimiter = g.__forgeRateLimiter!;

/** Throws a user-facing RATE_LIMITED error when the budget is exhausted. */
export function enforceRateLimit(key: string, limit: number, windowMs: number) {
  const result = rateLimiter.consume(key, limit, windowMs);
  if (!result.ok) throw rateLimited(result.retryAfterMs);
}

// ── Shared budgets (all instances) ──────────────────────────────────────────

/**
 * Budgets kept in PostgreSQL, so several app instances share them. Used for the actions an
 * attacker would spread over instances (sign-in, sign-up, resets, invitations); per-user API
 * throttles stay in memory.
 */
export const sharedRateLimiter = {
  async consume(key: string, limit: number, windowMs: number) {
    const [row] = await rawSql()<Array<{ count: number; reset_at: Date | string }>>`
      insert into rate_limits (key, count, reset_at) values (${key}, 1, now() + ${`${windowMs} milliseconds`}::interval)
      on conflict (key) do update set
        count = case when rate_limits.reset_at <= now() then 1 else rate_limits.count + 1 end,
        reset_at = case when rate_limits.reset_at <= now() then excluded.reset_at else rate_limits.reset_at end
      returning count, reset_at`;
    const retryAfterMs = Math.max(0, new Date(row!.reset_at).getTime() - Date.now());
    return { ok: row!.count <= limit, retryAfterMs };
  },
  async check(key: string, limit: number) {
    const [row] = await rawSql()<Array<{ count: number; reset_at: Date | string }>>`select count, reset_at from rate_limits where key = ${key} and reset_at > now()`;
    return { ok: !row || row.count < limit, retryAfterMs: row ? Math.max(0, new Date(row.reset_at).getTime() - Date.now()) : 0 };
  },
  /** Deletes expired budgets (hourly). */
  async sweep() {
    await rawSql()`delete from rate_limits where reset_at <= now()`;
  },
};

export async function enforceSharedRateLimit(key: string, limit: number, windowMs: number) {
  const result = await sharedRateLimiter.consume(key, limit, windowMs);
  if (!result.ok) throw rateLimited(result.retryAfterMs);
}
