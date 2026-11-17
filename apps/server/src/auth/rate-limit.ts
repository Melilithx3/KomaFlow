/**
 * Login attempt limiter (docs/03-server-ops.md §3): at most 5 failures in 10 minutes per (IP, login),
 * plus a growing delay after each failure. In memory: a restart resets it, which is acceptable
 * because nginx `limit_req` is the outer guard.
 */
export class LoginLimiter {
  private failures = new Map<string, number[]>();
  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 10 * 60_000,
  ) {}

  private key(ip: string, login: string) {
    return `${ip}\u0000${login.toLowerCase()}`;
  }

  private recent(key: string, now: number): number[] {
    const list = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  isBlocked(ip: string, login: string, now = Date.now()): boolean {
    return this.recent(this.key(ip, login), now).length >= this.maxFailures;
  }

  /** Records a failure and returns the delay (ms) to apply before answering. */
  fail(ip: string, login: string, now = Date.now()): number {
    const k = this.key(ip, login);
    const list = this.recent(k, now);
    list.push(now);
    this.failures.set(k, list);
    return Math.min(250 * 2 ** (list.length - 1), 4000);
  }

  succeed(ip: string, login: string): void {
    this.failures.delete(this.key(ip, login));
  }
}
