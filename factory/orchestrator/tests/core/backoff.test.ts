import { describe, expect, it } from "vitest";
import { backoffDelayMs, isRetryableApiError } from "../../src/core/backoff";
import type { AgentResult } from "../../src/runner";

const res = (over: Partial<AgentResult>): AgentResult => ({
  instance_id: "i", end_reason: "error", usage: { tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, cost_usd: 0 },
  num_turns: 0, duration_ms: 0, permission_denials: 0, exit_code: 1, ...over,
});

describe("backoff", () => {
  it("exponentiel borné : 1 s, 2 s, 4 s ... plafonné", () => {
    expect([0, 1, 2, 3].map((n) => backoffDelayMs(n))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelayMs(20)).toBe(60_000);
    expect(backoffDelayMs(1, { baseMs: 500 })).toBe(1000);
  });
  it("reconnaît 429 et 5xx seulement", () => {
    expect(isRetryableApiError(res({ error: "API error 429 rate limited" }))).toBe(true);
    expect(isRetryableApiError(res({ error: "HTTP 503" }))).toBe(true);
    expect(isRetryableApiError(res({ error: "HTTP 400 bad request" }))).toBe(false);
    expect(isRetryableApiError(res({ error: "tokens 5000 used" }))).toBe(false);
    expect(isRetryableApiError(res({ end_reason: "completed", error: "429" }))).toBe(false);
    expect(isRetryableApiError(res({}))).toBe(false);
  });
});
