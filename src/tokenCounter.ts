import { InputValidator } from './security';
import { SecurityLogger } from './security';
import { QuotaStore, QuotaExceededError } from './quotaStore';

export { QuotaExceededError };

/**
 * Tracks per-blog token usage and enforces daily quota via KV-backed
 * {@link QuotaStore}.  Each call to {@link processTokens} validates its
 * inputs, delegates the arithmetic to {@link SafeTokenMath}, persists the
 * consumption in KV, and throws {@link QuotaExceededError} when the daily
 * limit is breached.
 */
export class TokenCounter {
    private readonly quotaStore: QuotaStore;

    constructor(kv: KVNamespace, dailyLimit: number) {
        this.quotaStore = new QuotaStore(kv, dailyLimit);
    }

    /**
     * Consumes `tokensUsed` tokens for `blogId` / `description`, persisting
     * the updated daily total in KV.
     *
     * @throws {@link QuotaExceededError} when the daily limit would be exceeded.
     */
    public async processTokens(blogId: string, tokensUsed: number, description: string): Promise<{ used: number; remaining: number }> {
        // Validate inputs
        const v = new InputValidator();
        if (!v.validate(blogId) || typeof blogId !== 'string' || blogId.length > 50) {
            SecurityLogger.error('TokenCounter', 'Invalid blogId');
            throw new Error('Invalid blogId');
        }
        if (typeof tokensUsed !== 'number' || !isFinite(tokensUsed) || tokensUsed < 0) {
            SecurityLogger.error('TokenCounter', 'Invalid tokensUsed');
            throw new Error('Invalid tokensUsed');
        }
        if (!v.validate(description) || typeof description !== 'string' || description.length > 255) {
            SecurityLogger.error('TokenCounter', 'Invalid description');
            throw new Error('Invalid description');
        }

        SecurityLogger.log('INFO', 'TokenCounter', { blogId, tokensUsed, description });

        return this.quotaStore.consumeTokens(tokensUsed, `${blogId}:${description}`);
    }

    /** Returns the number of tokens consumed today. */
    public async getDailyUsage(): Promise<number> {
        return this.quotaStore.getDailyUsage();
    }

    /** Returns the number of tokens remaining for today. */
    public async getRemainingTokens(): Promise<number> {
        return this.quotaStore.getRemainingTokens();
    }
}