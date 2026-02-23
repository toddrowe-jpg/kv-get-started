/**
 * agentRegistry.ts
 *
 * Programmatic role-separation enforcement for the blog workflow.
 * Each workflow phase is assigned exactly one designated model/agent.
 * The worker MUST call assertPhaseModel before invoking any AI model to
 * ensure only the correct model is used for each phase.
 */

/** All named workflow phases recognised by the system. */
export type WorkflowPhase =
  | "research"
  | "outline"
  | "draft"
  | "edit"
  | "factcheck"
  | "image"
  | "summarize";

/** Configuration entry for a single workflow phase. */
export interface PhaseConfig {
  /** The phase identifier. */
  phase: WorkflowPhase;
  /** The designated model/agent for this phase. */
  model: string;
  /** Human-readable description of the phase purpose. */
  description: string;
}

/**
 * Registry mapping each workflow phase to its designated model/agent.
 * This is the single source of truth for phase–model assignments.
 * Update this registry (not individual endpoint code) to change assignments.
 */
export const PHASE_MODEL_REGISTRY: Readonly<Record<WorkflowPhase, PhaseConfig>> = {
  research: {
    phase: "research",
    model: "gemini-1.5-flash-latest",
    description: "Blog topic research via Google Gemini",
  },
  outline: {
    phase: "outline",
    model: "gemini-1.5-flash-latest",
    description: "Blog outline generation via Google Gemini",
  },
  draft: {
    phase: "draft",
    model: "gemini-1.5-flash-latest",
    description: "Full blog draft writing via Google Gemini",
  },
  edit: {
    phase: "edit",
    model: "gemini-1.5-flash-latest",
    description: "Blog draft editing via Google Gemini",
  },
  factcheck: {
    phase: "factcheck",
    model: "gemini-1.5-flash-latest",
    description: "Fact-checking against sources via Google Gemini",
  },
  image: {
    phase: "image",
    model: "@cf/black-forest-labs/flux-1-schnell",
    description: "Image generation via Cloudflare Workers AI",
  },
  summarize: {
    phase: "summarize",
    model: "@cf/facebook/bart-large-cnn",
    description: "Text summarization via Cloudflare Workers AI",
  },
};

/**
 * Thrown when a caller attempts to use a model other than the one designated
 * for a workflow phase. This enforces programmatic role separation.
 */
export class PhaseModelMismatchError extends Error {
  /** The workflow phase that was violated. */
  readonly phase: WorkflowPhase;
  /** The model that is required for this phase. */
  readonly expectedModel: string;
  /** The model that was actually supplied. */
  readonly actualModel: string;

  constructor(phase: WorkflowPhase, expectedModel: string, actualModel: string) {
    super(
      `Phase "${phase}" must use model "${expectedModel}" but "${actualModel}" was supplied`,
    );
    this.name = "PhaseModelMismatchError";
    this.phase = phase;
    this.expectedModel = expectedModel;
    this.actualModel = actualModel;
  }
}

/**
 * Returns the model/agent designated for `phase`.
 *
 * @throws {Error} if the phase is not found in the registry.
 */
export function getPhaseModel(phase: WorkflowPhase): string {
  return PHASE_MODEL_REGISTRY[phase].model;
}

/**
 * Asserts that `model` is the designated model for `phase`.
 * Call this before every AI invocation in the workflow to enforce role separation.
 *
 * @param phase - The workflow phase about to be executed.
 * @param model - The model/agent the caller intends to use.
 * @throws {PhaseModelMismatchError} if `model` does not match the registry entry.
 */
export function assertPhaseModel(phase: WorkflowPhase, model: string): void {
  const expected = PHASE_MODEL_REGISTRY[phase].model;
  if (model !== expected) {
    throw new PhaseModelMismatchError(phase, expected, model);
  }
}
