/**
 * quotaStore.ts
 *
 * KV-backed daily token quota enforcement for LLM/AI API usage.
 * Tracks tokens consumed per UTC calendar day and enforces a configurable
 * daily limit so quota survives Worker restarts and redeploys.
 *
 * Keys stored in KV: `quota:daily:YYYY-MM-DD` → raw token count as a string.
 * TTL is set to 26 hours so stale counters are cleaned up automatically even
 * accounting for clock skew and timezone boundary edge cases.
 */

/** Thrown when an AI/LLM call would breach the daily token quota. */
export class QuotaExceededError extends Error {
  /** Total tokens already consumed today when the error was raised. */
  readonly used: number;
  /** Configured daily token limit. */
  readonly limit: number;

  constructor(used: number, limit: number) {
    super(`Daily token quota exceeded: ${used} tokens used of ${limit} daily limit`);
    this.name = "QuotaExceededError";
    this.used = used;
    this.limit = limit;
  }
}

/**
 * KV-backed store that counts AI/LLM token usage per day and enforces a
 * configurable daily limit.
 */
export class QuotaStore {
  /** TTL in seconds for KV quota keys — 26 h to survive timezone/clock-skew edge cases. */
  private static readonly KV_TTL_SECONDS = 93_600;

  constructor(
    private readonly kv: KVNamespace,
    private readonly dailyLimit: number,
  ) {}

  /** Returns the KV key for the given date string (YYYY-MM-DD). */
  private dateKey(date: string): string {
    return `quota:daily:${date}`;
  }

  /** Returns today's UTC date as YYYY-MM-DD. */
  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Returns the number of tokens consumed on `date` (defaults to today).
   */
  async getDailyUsage(date?: string): Promise<number> {
    const key = this.dateKey(date ?? this.today());
    const raw = await this.kv.get(key);
    return raw ? parseInt(raw, 10) : 0;
  }

  /**
   * Returns the number of tokens remaining for today.
   */
  async getRemainingTokens(): Promise<number> {
    const used = await this.getDailyUsage();
    return Math.max(0, this.dailyLimit - used);
  }

  /**
   * Attempts to consume `tokens` tokens for today.
   *
   * If adding `tokens` to the current daily total would exceed `dailyLimit`,
   * a {@link QuotaExceededError} is thrown and nothing is persisted.
   *
   * @param tokens  - Number of tokens to consume.
   * @param context - Optional label describing the caller (used in logs).
   * @returns The updated `used` and `remaining` counts.
   * @throws {@link QuotaExceededError} when the daily limit would be breached.
   */
  async consumeTokens(
    tokens: number,
    context?: string,
  ): Promise<{ used: number; remaining: number }> {
    const date = this.today();
    const key = this.dateKey(date);
    const current = await this.getDailyUsage(date);
    const newTotal = current + tokens;

    if (newTotal > this.dailyLimit) {
      console.error(
        `Token quota exceeded${context ? ` [${context}]` : ""}: ` +
          `${current} used + ${tokens} requested > ${this.dailyLimit} daily limit`,
      );
      throw new QuotaExceededError(current, this.dailyLimit);
    }

    await this.kv.put(key, String(newTotal), { expirationTtl: QuotaStore.KV_TTL_SECONDS });

    const remaining = this.dailyLimit - newTotal;
    console.log(
      `Token quota${context ? ` [${context}]` : ""}: ` +
        `consumed ${tokens}, total today ${newTotal}/${this.dailyLimit}, remaining ${remaining}`,
    );
    return { used: newTotal, remaining };
  }

  /**
   * Records token usage without enforcing the limit.
   * Use this for post-hoc accounting where over-limit behaviour is already
   * handled externally (e.g. the Gemini API itself returns a 429).
   *
   * @returns The updated `used` and `remaining` counts.
   */
  async recordTokens(
    tokens: number,
    context?: string,
  ): Promise<{ used: number; remaining: number }> {
    const date = this.today();
    const key = this.dateKey(date);
    const current = await this.getDailyUsage(date);
    const newTotal = current + tokens;

    await this.kv.put(key, String(newTotal), { expirationTtl: QuotaStore.KV_TTL_SECONDS });

    const remaining = Math.max(0, this.dailyLimit - newTotal);
    console.log(
      `Token quota recorded${context ? ` [${context}]` : ""}: ` +
        `+${tokens}, total today ${newTotal}/${this.dailyLimit}, remaining ${remaining}`,
    );
    return { used: newTotal, remaining };
  }
}
