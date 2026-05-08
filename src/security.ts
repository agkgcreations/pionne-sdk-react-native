// Client-side security guards. Cheap and unconditional — runs at init().
//
//  - validateEndpoint: refuse non-HTTPS endpoints in production builds. A
//    plaintext crash payload in transit can leak PII the SDK couldn't
//    foresee (random `console.log("user.email = …")` from your code).
//  - validateToken: stricter than the original startsWith check — also
//    enforces a minimum entropy (avoids accidental commits of `pio_live_x`
//    test placeholders making it to prod).
//  - rateLimiter: token-bucket per-process limit on outgoing events. Caps
//    the worst case of a runaway loop (`while(true) throw`) flooding the
//    backend AND blowing up your monthly quota. Default 10/sec, opt-out
//    via `maxEventsPerSecond: 0`.

const TOKEN_PREFIX = 'pio_live_';
const MIN_TOKEN_LENGTH = TOKEN_PREFIX.length + 16; // 16 chars of secret minimum

export function validateEndpoint(endpoint: string, isDev: boolean): boolean {
  try {
    const u = new URL(endpoint);
    if (u.protocol === 'https:') return true;
    if (u.protocol !== 'http:') return false;
    // http:// only allowed in dev mode AND for localhost / loopback /
    // *.local — never to a real domain.
    if (!isDev) return false;
    return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export function validateToken(token: string): boolean {
  if (typeof token !== 'string') return false;
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  if (token.length < MIN_TOKEN_LENGTH) return false;
  // Reject obvious placeholders devs sometimes commit.
  const lower = token.toLowerCase();
  for (const bad of ['xxx', 'yyy', 'todo', 'fixme', 'replace', 'changeme']) {
    if (lower.includes(bad)) return false;
  }
  return true;
}

// Token bucket — capacity = burst, refilled at rate per second.
// Default capacity / refill = 10 events/sec (tunable via init option).
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  constructor(
    private capacity: number,
    private refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }
  /** Returns true if the action is allowed; consumes one token. */
  allow(): boolean {
    if (this.refillPerSecond <= 0) return true; // disabled
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs > 0) {
      const refill = (elapsedMs / 1000) * this.refillPerSecond;
      this.tokens = Math.min(this.capacity, this.tokens + refill);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
