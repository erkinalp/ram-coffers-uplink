export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
function ok(): RateLimitVerdict {
  return { allowed: true, retryAfterSeconds: 0 };
}

export class RateLimiter {
  private readonly requests = new Map<number, number[]>();
  private readonly tokens = new Map<number, Array<{ ts: number; tokens: number }>>();

  constructor(private readonly now: () => number = Date.now) {}

  checkRequests(keyId: number, rpmLimit: number | null): RateLimitVerdict {
    if (rpmLimit === null) return ok();
    if (rpmLimit < 1) return { allowed: false, retryAfterSeconds: 60 };
    const windowStart = this.now() - MINUTE_MS;
    const recent = (this.requests.get(keyId) ?? []).filter((ts) => ts > windowStart);
    if (recent.length < rpmLimit) {
      recent.push(this.now());
      this.requests.set(keyId, recent);
      return ok();
    }
    this.requests.set(keyId, recent);
    const oldest = recent[0] as number;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + MINUTE_MS - this.now()) / 1000)),
    };
  }

  checkTokens(keyId: number, tokensPerDay: number | null): RateLimitVerdict {
    if (tokensPerDay === null) return ok();
    if (tokensPerDay < 1) return { allowed: false, retryAfterSeconds: 3600 };
    const windowStart = this.now() - DAY_MS;
    const recent = (this.tokens.get(keyId) ?? []).filter((e) => e.ts > windowStart);
    this.tokens.set(keyId, recent);
    const used = recent.reduce((sum, e) => sum + e.tokens, 0);
    if (used < tokensPerDay) return ok();
    const oldest = recent[0];
    if (!oldest) return ok();
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest.ts + DAY_MS - this.now()) / 1000)),
    };
  }

  recordTokens(keyId: number, tokens: number): void {
    const events = this.tokens.get(keyId) ?? [];
    events.push({ ts: this.now(), tokens });
    this.tokens.set(keyId, events);
  }

  reset(): void {
    this.requests.clear();
    this.tokens.clear();
  }
}
