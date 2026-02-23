import { describe, it, expect, beforeEach } from "vitest";
import { QuotaStore, QuotaExceededError } from "../src/quotaStore";

// ---------------------------------------------------------------------------
// Minimal in-memory KVNamespace mock (same pattern as workflowStore.test.ts)
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: [],
      list_complete: true,
      cursor: "",
      cacheStatus: null,
    }),
    getWithMetadata: async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// QuotaExceededError – unit tests
// ---------------------------------------------------------------------------

describe("QuotaExceededError", () => {
  it("is an instance of Error with correct properties", () => {
    const err = new QuotaExceededError(28000, 30000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("QuotaExceededError");
    expect(err.used).toBe(28000);
    expect(err.limit).toBe(30000);
    expect(err.message).toContain("28000");
    expect(err.message).toContain("30000");
  });
});

// ---------------------------------------------------------------------------
// QuotaStore – unit tests
// ---------------------------------------------------------------------------

describe("QuotaStore", () => {
  let quota: QuotaStore;

  beforeEach(() => {
    quota = new QuotaStore(createMockKV(), 30_000);
  });

  it("getDailyUsage returns 0 when no tokens have been consumed", async () => {
    const usage = await quota.getDailyUsage();
    expect(usage).toBe(0);
  });

  it("getRemainingTokens returns the full limit before any consumption", async () => {
    const remaining = await quota.getRemainingTokens();
    expect(remaining).toBe(30_000);
  });

  it("consumeTokens persists usage and returns correct totals", async () => {
    const result = await quota.consumeTokens(500, "test");
    expect(result.used).toBe(500);
    expect(result.remaining).toBe(29_500);
  });

  it("consumeTokens accumulates across multiple calls", async () => {
    await quota.consumeTokens(1000, "call1");
    await quota.consumeTokens(2000, "call2");
    const usage = await quota.getDailyUsage();
    expect(usage).toBe(3000);
  });

  it("getDailyUsage reflects consumed tokens", async () => {
    await quota.consumeTokens(5000, "test");
    const usage = await quota.getDailyUsage();
    expect(usage).toBe(5000);
  });

  it("getRemainingTokens decreases after consumption", async () => {
    await quota.consumeTokens(10_000, "test");
    const remaining = await quota.getRemainingTokens();
    expect(remaining).toBe(20_000);
  });

  it("consumeTokens allows consumption exactly at the limit", async () => {
    const result = await quota.consumeTokens(30_000, "exact");
    expect(result.used).toBe(30_000);
    expect(result.remaining).toBe(0);
  });

  it("consumeTokens throws QuotaExceededError when limit would be exceeded", async () => {
    await quota.consumeTokens(28_000, "setup");
    await expect(quota.consumeTokens(3_000, "over-limit")).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("does not persist usage when QuotaExceededError is thrown", async () => {
    await quota.consumeTokens(28_000, "setup");
    try {
      await quota.consumeTokens(3_000, "over-limit");
    } catch {
      // expected
    }
    const usage = await quota.getDailyUsage();
    expect(usage).toBe(28_000); // unchanged
  });

  it("QuotaExceededError carries correct used and limit values", async () => {
    await quota.consumeTokens(29_000, "setup");
    try {
      await quota.consumeTokens(2_000, "over-limit");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QuotaExceededError);
      const qErr = err as QuotaExceededError;
      expect(qErr.used).toBe(29_000);
      expect(qErr.limit).toBe(30_000);
    }
  });

  it("recordTokens persists usage without enforcing the limit", async () => {
    const result = await quota.recordTokens(35_000, "over-limit");
    expect(result.used).toBe(35_000);
    expect(result.remaining).toBe(0); // clamped to 0
    const usage = await quota.getDailyUsage();
    expect(usage).toBe(35_000);
  });

  it("recordTokens does not throw when over limit", async () => {
    await expect(quota.recordTokens(50_000, "post-hoc")).resolves.not.toThrow();
  });

  it("consumeTokens without context label does not throw", async () => {
    const result = await quota.consumeTokens(100);
    expect(result.used).toBe(100);
  });
});
