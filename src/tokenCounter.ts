/**
 * Token Counter & Cap System for Daily Blog Workflow
 * Tracks token usage across: research, writing, image generation, reviewing, posting
 * Hard cap: 30,000 tokens per blog
 */

export interface TokenUsage {
  research: number;
  writing: number;
  imageGeneration: number;
  reviewing: number;
  posting: number;
  total: number;
}

export interface TokenLog {
  blogId: string;
  date: string;
  usage: TokenUsage;
  status: 'in-progress' | 'completed' | 'exceeded';
  operations: TokenOperation[];
}

export interface TokenOperation {
  phase: 'research' | 'writing' | 'imageGeneration' | 'reviewing' | 'posting';
  timestamp: string;
  tokensUsed: number;
  description: string;
  success: boolean;
}

// Configuration
export const TOKEN_CONFIG = {
  MAX_TOKENS_PER_BLOG: 30000,
  PHASE_ALLOCATIONS: {
    research: 5000,      // ~20% - research, source gathering
    writing: 12000,      // ~40% - outline, draft, initial writing
    imageGeneration: 3000, // ~10% - image prompts and descriptions
    reviewing: 8000,     // ~25% - editing, refinement, compliance check
    posting: 2000,       // ~5% - final copy, metadata, scheduling
  },
  DAILY_LIMIT: 30000,    // Single blog per day
};

/**
 * Initialize token tracking for a new blog
 */
export function initializeTokenLog(blogId: string): TokenLog {
  return {
    blogId,
    date: new Date().toISOString().split('T')[0],
    usage: {
      research: 0,
      writing: 0,
      imageGeneration: 0,
      reviewing: 0,
      posting: 0,
      total: 0,
    },
    status: 'in-progress',
    operations: [],
  };
}

/**
 * Record token usage for a specific phase
 */
export function recordTokenUsage(
  log: TokenLog,
  phase: TokenOperation['phase'],
  tokensUsed: number,
  description: string
): { success: boolean; remainingTokens: number; message: string } {
  
  const newTotal = log.usage.total + tokensUsed;
  
  if (newTotal > TOKEN_CONFIG.MAX_TOKENS_PER_BLOG) {
    const overage = newTotal - TOKEN_CONFIG.MAX_TOKENS_PER_BLOG;
    const operation: TokenOperation = {
      phase,
      timestamp: new Date().toISOString(),
      tokensUsed,
      description,
      success: false,
    };
    
    log.operations.push(operation);
    log.status = 'exceeded';
    
    return {
      success: false,
      remainingTokens: 0,
      message: `❌ TOKEN CAP EXCEEDED: +${overage} tokens over 30K limit. Phase: ${phase}, Requested: ${tokensUsed}, Total would be: ${newTotal}`,
    };
  }
  
  // Record successful operation
  log.usage[phase] += tokensUsed;
  log.usage.total = newTotal;
  
  const operation: TokenOperation = {
    phase,
    timestamp: new Date().toISOString(),
    tokensUsed,
    description,
    success: true,
  };
  
  log.operations.push(operation);
  
  const remainingTokens = TOKEN_CONFIG.MAX_TOKENS_PER_BLOG - newTotal;
  const percentageUsed = (newTotal / TOKEN_CONFIG.MAX_TOKENS_PER_BLOG * 100).toFixed(1);
  
  return {
    success: true,
    remainingTokens,
    message: `✅ ${phase.toUpperCase()}: +${tokensUsed} tokens | Total: ${newTotal}/${TOKEN_CONFIG.MAX_TOKENS_PER_BLOG} (${percentageUsed}%) | Remaining: ${remainingTokens}`,
  };
}

/**
 * Check if we can allocate tokens for a phase
 */
export function canAllocateTokens(log: TokenLog, phase: TokenOperation['phase'], tokensNeeded: number): boolean {
  return (log.usage.total + tokensNeeded) <= TOKEN_CONFIG.MAX_TOKENS_PER_BLOG;
}

/**
 * Get remaining budget for a phase
 */
export function getRemainingBudget(log: TokenLog): {
  total: number;
  byPhase: Record<string, number>;
} {
  const totalRemaining = TOKEN_CONFIG.MAX_TOKENS_PER_BLOG - log.usage.total;
  
  return {
    total: totalRemaining,
    byPhase: {
      research: Math.max(0, TOKEN_CONFIG.PHASE_ALLOCATIONS.research - log.usage.research),
      writing: Math.max(0, TOKEN_CONFIG.PHASE_ALLOCATIONS.writing - log.usage.writing),
      imageGeneration: Math.max(0, TOKEN_CONFIG.PHASE_ALLOCATIONS.imageGeneration - log.usage.imageGeneration),
      reviewing: Math.max(0, TOKEN_CONFIG.PHASE_ALLOCATIONS.reviewing - log.usage.reviewing),
      posting: Math.max(0, TOKEN_CONFIG.PHASE_ALLOCATIONS.posting - log.usage.posting),
    },
  };
}

/**
 * Generate token usage report
 */
export function generateTokenReport(log: TokenLog): string {
  const report = `
╔════════════════════════════════════════════════════════════════╗
║           TOKEN USAGE REPORT - Blog: ${log.blogId}
║           Date: ${log.date}
╚════════════════════════════════════════════════════════════════╝

SUMMARY:
├─ Total Used: ${log.usage.total} / ${TOKEN_CONFIG.MAX_TOKENS_PER_BLOG} tokens
├─ Status: ${log.status === 'exceeded' ? '❌ EXCEEDED' : log.status === 'completed' ? '✅ COMPLETED' : '⏳ IN PROGRESS'}
├─ Remaining: ${TOKEN_CONFIG.MAX_TOKENS_PER_BLOG - log.usage.total} tokens
└─ Usage: ${(log.usage.total / TOKEN_CONFIG.MAX_TOKENS_PER_BLOG * 100).toFixed(1)}%

BREAKDOWN BY PHASE:
├─ Research:          ${log.usage.research.toString().padStart(5)} / ${TOKEN_CONFIG.PHASE_ALLOCATIONS.research.toString().padStart(5)} (${(log.usage.research / TOKEN_CONFIG.PHASE_ALLOCATIONS.research * 100).toFixed(0)}%)
├─ Writing:           ${log.usage.writing.toString().padStart(5)} / ${TOKEN_CONFIG.PHASE_ALLOCATIONS.writing.toString().padStart(5)} (${(log.usage.writing / TOKEN_CONFIG.PHASE_ALLOCATIONS.writing * 100).toFixed(0)}%)
├─ Image Generation:  ${log.usage.imageGeneration.toString().padStart(5)} / ${TOKEN_CONFIG.PHASE_ALLOCATIONS.imageGeneration.toString().padStart(5)} (${(log.usage.imageGeneration / TOKEN_CONFIG.PHASE_ALLOCATIONS.imageGeneration * 100).toFixed(0)}%)
├─ Reviewing:         ${log.usage.reviewing.toString().padStart(5)} / ${TOKEN_CONFIG.PHASE_ALLOCATIONS.reviewing.toString().padStart(5)} (${(log.usage.reviewing / TOKEN_CONFIG.PHASE_ALLOCATIONS.reviewing * 100).toFixed(0)}%)
└─ Posting:           ${log.usage.posting.toString().padStart(5)} / ${TOKEN_CONFIG.PHASE_ALLOCATIONS.posting.toString().padStart(5)} (${(log.usage.posting / TOKEN_CONFIG.PHASE_ALLOCATIONS.posting * 100).toFixed(0)}%)

OPERATION LOG (Last 10):
${log.operations.slice(-10).map((op, idx) => 
  `${idx + 1}. [${op.phase}] ${op.tokensUsed} tokens - ${op.description} ${op.success ? '✅' : '❌'}`
).join('\n')}

═══════════════════════════════════════════════════════════════════
  `.trim();
  
  return report;
}

/**
 * Estimate tokens needed for a task (simplified approximation)
 * Rough estimate: 1 token ≈ 4 characters (varies by model)
 */
export function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Reset daily limits (call at midnight UTC)
 */
export function resetDailyLimits(): TokenLog {
  return initializeTokenLog(`blog-${new Date().toISOString().split('T')[0]}`);
}

/**
 * Export logs to KV storage key for persistence
 */
export function generateStorageKey(blogId: string): string {
  return `token-log:${blogId}`;
}

/**
 * Validate if blog workflow can complete within token budget
 */
export function validateWorkflowFeasibility(
  estimatedResearch: number,
  estimatedWriting: number,
  estimatedReview: number
): { feasible: boolean; feedback: string } {
  const total = estimatedResearch + estimatedWriting + estimatedReview;
  
  if (total > TOKEN_CONFIG.MAX_TOKENS_PER_BLOG) {
    return {
      feasible: false,
      feedback: `❌ Workflow exceeds 30K token budget. Estimated: ${total} tokens. Reduce scope or split into multiple blogs.`,
    };
  }
  
  const buffer = TOKEN_CONFIG.MAX_TOKENS_PER_BLOG - total;
  
  return {
    feasible: true,
    feedback: `✅ Workflow feasible with ${buffer} tokens buffer (${(buffer / TOKEN_CONFIG.MAX_TOKENS_PER_BLOG * 100).toFixed(1)}% headroom)`,
  };
}