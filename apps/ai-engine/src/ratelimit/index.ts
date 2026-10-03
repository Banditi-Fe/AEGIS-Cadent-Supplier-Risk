/**
 * Fixed-window, in-memory rate limiter keyed by caller (here: organizationId).
 * Single-instance protection. With several AI Engine replicas the effective limit is per replica;
 * a shared limiter (Redis / API gateway) is the production answer and is documented in docs/operations.md.
 */
export interface RateDecision {
  allowed: boolean;
  /** Seconds until the window resets (only meaningful when not allowed). */
  retryAfterSec: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limitPerWindow: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys: number = 10_000,
  ) {}

  get enabled(): boolean {
    return this.limitPerWindow > 0;
  }

  check(key: string): RateDecision {
    if (!this.enabled) return { allowed: true, retryAfterSec: 0 };
    const t = this.now();
    this.sweep(t);
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return { allowed: true, retryAfterSec: 0 };
    }
    if (w.count >= this.limitPerWindow) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000)) };
    }
    w.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs && this.windows.size < this.maxKeys) return;
    this.lastSweep = t;
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
    // Hard bound against key-flooding: drop everything rather than grow without limit.
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}
