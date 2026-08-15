import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/ratelimit.js";

function setup(start = 1_000_000) {
  let now = start;
  return { limiter: new RateLimiter(() => now), advance: (ms: number) => (now += ms) };
}

describe("requests per minute", () => {
  it("allows up to the limit within the sliding window", () => {
    const { limiter } = setup();
    expect(limiter.checkRequests(1, 2)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.checkRequests(1, 2).allowed).toBe(true);
    const third = limiter.checkRequests(1, 2);
    expect(third.allowed).toBe(false);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("slides the window", () => {
    const { limiter, advance } = setup();
    limiter.checkRequests(1, 1);
    advance(30_000);
    expect(limiter.checkRequests(1, 1).allowed).toBe(false);
    advance(31_000);
    expect(limiter.checkRequests(1, 1).allowed).toBe(true);
  });

  it("tracks keys independently and treats null as unlimited", () => {
    const { limiter } = setup();
    limiter.checkRequests(1, 1);
    expect(limiter.checkRequests(2, 1).allowed).toBe(true);
    for (let i = 0; i < 100; i++) expect(limiter.checkRequests(1, null).allowed).toBe(true);
  });

  it("rejects everything when the limit is zero", () => {
    const { limiter } = setup();
    expect(limiter.checkRequests(1, 0)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });
});

describe("tokens per day", () => {
  it("blocks once the rolling 24 h budget is spent", () => {
    const { limiter } = setup();
    expect(limiter.checkTokens(1, 100).allowed).toBe(true);
    limiter.recordTokens(1, 60);
    expect(limiter.checkTokens(1, 100).allowed).toBe(true);
    limiter.recordTokens(1, 50);
    const verdict = limiter.checkTokens(1, 100);
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("rolls off usage older than 24 hours", () => {
    const { limiter, advance } = setup();
    limiter.recordTokens(1, 100);
    expect(limiter.checkTokens(1, 100).allowed).toBe(false);
    advance(24 * 60 * 60 * 1000 + 1);
    expect(limiter.checkTokens(1, 100).allowed).toBe(true);
  });

  it("treats null as unlimited", () => {
    const { limiter } = setup();
    limiter.recordTokens(1, 1_000_000);
    expect(limiter.checkTokens(1, null).allowed).toBe(true);
  });

  it("rejects everything when the daily limit is zero", () => {
    const { limiter } = setup();
    expect(limiter.checkTokens(1, 0)).toEqual({ allowed: false, retryAfterSeconds: 3600 });
  });
});
