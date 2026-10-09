import { Request, Response, NextFunction } from 'express';
import config from '../config/env.js';
import { AppError, Errors } from './errorHandler.js';
import { MAX_BATCH_FILES } from '../utils/validators.js';

/**
 * Per-user rate limit for API requests that start AI work (CV classification,
 * CV batches, sentiment analysis).
 *
 * - Keyed ONLY by req.user.id, which authenticateToken resolved from the
 *   server-side session: query strings, headers, bodies and a second login
 *   cannot change the key or reset the budget.
 * - Counts AI runs, not requests: a batch costs one unit per file, so a batch
 *   cannot be used to get around the limit.
 * - Sliding window: a unit frees up exactly `windowMs` after it was used.
 * - A request the API rejects with a 4xx (validation, ownership, not found)
 *   started no AI work, so its units are given back when the response ends.
 *   Provider failures (5xx) keep theirs: the provider was called.
 * - In memory and per process: it resets when the backend restarts and is not
 *   shared between processes.
 */

type Consumed = { ok: true; remaining: number; release: () => void };
type Refused = { ok: false; retryAfterMs: number | null };

interface Entry {
  at: number;
  units: number;
}

export class AiRateLimiter {
  private readonly used = new Map<number, Entry[]>();

  constructor(
    readonly maxUnits: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Reserves `units` for `userId` if they fit in the current window.
   * `retryAfterMs` is null when the request can never fit (units > maxUnits).
   */
  tryConsume(userId: number, units: number): Consumed | Refused {
    const now = this.now();
    const live = this.prune(userId, now);
    if (units > this.maxUnits) return { ok: false, retryAfterMs: null };

    const inUse = live.reduce((sum, e) => sum + e.units, 0);
    if (inUse + units > this.maxUnits) {
      // The earliest moment enough of the oldest units have expired.
      let freed = 0;
      for (const entry of live) {
        freed += entry.units;
        if (inUse - freed + units <= this.maxUnits) {
          return { ok: false, retryAfterMs: Math.max(1, entry.at + this.windowMs - now) };
        }
      }
      return { ok: false, retryAfterMs: this.windowMs };
    }

    const entry: Entry = { at: now, units };
    live.push(entry);
    this.used.set(userId, live);
    let released = false;
    return {
      ok: true,
      remaining: this.maxUnits - inUse - units,
      release: () => {
        if (released) return;
        released = true;
        const list = this.used.get(userId);
        const index = list?.indexOf(entry) ?? -1;
        if (list && index >= 0) list.splice(index, 1);
      },
    };
  }

  /** Drops expired entries for one user (and, occasionally, for everyone). */
  private prune(userId: number, now: number): Entry[] {
    const cutoff = now - this.windowMs;
    const live = (this.used.get(userId) ?? []).filter(e => e.at > cutoff);
    if (live.length > 0) this.used.set(userId, live);
    else this.used.delete(userId);
    if (this.used.size > 10_000) {
      for (const [id, list] of this.used) {
        if (!list.some(e => e.at > cutoff)) this.used.delete(id);
      }
    }
    return live;
  }
}

let limiter = new AiRateLimiter(config.AI_RATE_LIMIT_MAX_RUNS, config.AI_RATE_LIMIT_WINDOW_SECONDS * 1000);

/** Tests only: swap in a limiter with a small budget and a controllable clock; pass nothing to reset. */
export function __setAiRateLimiterForTesting(next?: AiRateLimiter): void {
  limiter = next ?? new AiRateLimiter(config.AI_RATE_LIMIT_MAX_RUNS, config.AI_RATE_LIMIT_WINDOW_SECONDS * 1000);
}

function describeWindow(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? 'minute' : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/** One AI run per request. */
export const oneRun = (): number => 1;

/**
 * One AI run per submitted file. Capped at MAX_BATCH_FILES: a larger request
 * is rejected by validation (400) and refunded, so it must not turn into a 429.
 */
export const runsPerBatchFile = (req: Request): number => {
  const files = (req.body as { files?: unknown } | undefined)?.files;
  return Array.isArray(files) ? Math.min(Math.max(files.length, 1), MAX_BATCH_FILES) : 1;
};

/** Must run after authenticateToken: the key is the session user, never request data. */
export function aiRateLimit(unitsFor: (req: Request) => number = oneRun) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) throw Errors.unauthorized();

    const units = unitsFor(req);
    const decision = limiter.tryConsume(req.user.id, units);
    if (!decision.ok) {
      const limit = `${limiter.maxUnits} AI runs per ${describeWindow(limiter.windowMs)}`;
      if (decision.retryAfterMs === null) {
        throw new AppError(429, `This request would start ${units} AI runs, more than the limit of ${limit}.`, 'TOO_MANY_REQUESTS');
      }
      const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      throw new AppError(
        429,
        `Too many AI requests: the limit is ${limit}. Try again in ${retryAfterSeconds} seconds.`,
        'TOO_MANY_REQUESTS',
        { retryAfterSeconds }
      );
    }

    // Rejected before any AI work started: give the units back.
    res.on('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500) decision.release();
    });
    next();
  };
}
