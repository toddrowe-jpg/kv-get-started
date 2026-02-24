import { describe, it, expect } from "vitest";
import {
  PHASE_MODEL_REGISTRY,
  PhaseModelMismatchError,
  assertPhaseModel,
  getPhaseModel,
  WorkflowPhase,
} from "../src/agentRegistry";

// ---------------------------------------------------------------------------
// PHASE_MODEL_REGISTRY – structure tests
// ---------------------------------------------------------------------------

describe("PHASE_MODEL_REGISTRY", () => {
  const expectedPhases: WorkflowPhase[] = [
    "research",
    "outline",
    "draft",
    "edit",
    "factcheck",
    "image",
    "summarize",
  ];

  it("contains an entry for every expected workflow phase", () => {
    for (const phase of expectedPhases) {
      expect(PHASE_MODEL_REGISTRY[phase]).toBeDefined();
    }
  });

  it("every entry has a non-empty model string", () => {
    for (const phase of expectedPhases) {
      expect(typeof PHASE_MODEL_REGISTRY[phase].model).toBe("string");
      expect(PHASE_MODEL_REGISTRY[phase].model.length).toBeGreaterThan(0);
    }
  });

  it("every entry has a non-empty description string", () => {
    for (const phase of expectedPhases) {
      expect(typeof PHASE_MODEL_REGISTRY[phase].description).toBe("string");
      expect(PHASE_MODEL_REGISTRY[phase].description.length).toBeGreaterThan(0);
    }
  });

  it("Gemini phases use gemini-1.5-flash-latest", () => {
    const geminiPhases: WorkflowPhase[] = ["research", "outline", "draft", "edit", "factcheck"];
    for (const phase of geminiPhases) {
      expect(PHASE_MODEL_REGISTRY[phase].model).toBe("gemini-1.5-flash-latest");
    }
  });

  it("image phase uses the Cloudflare flux model", () => {
    expect(PHASE_MODEL_REGISTRY["image"].model).toBe(
      "@cf/black-forest-labs/flux-1-schnell"
    );
  });

  it("summarize phase uses the Cloudflare BART model", () => {
    expect(PHASE_MODEL_REGISTRY["summarize"].model).toBe(
      "@cf/facebook/bart-large-cnn"
    );
  });
});

// ---------------------------------------------------------------------------
// getPhaseModel
// ---------------------------------------------------------------------------

describe("getPhaseModel", () => {
  it("returns the correct model for a known phase", () => {
    expect(getPhaseModel("research")).toBe("gemini-1.5-flash-latest");
    expect(getPhaseModel("image")).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(getPhaseModel("summarize")).toBe("@cf/facebook/bart-large-cnn");
  });
});

// ---------------------------------------------------------------------------
// assertPhaseModel
// ---------------------------------------------------------------------------

describe("assertPhaseModel", () => {
  it("does not throw when the correct model is supplied", () => {
    expect(() =>
      assertPhaseModel("research", "gemini-1.5-flash-latest")
    ).not.toThrow();
  });

  it("does not throw for image phase with correct model", () => {
    expect(() =>
      assertPhaseModel("image", "@cf/black-forest-labs/flux-1-schnell")
    ).not.toThrow();
  });

  it("throws PhaseModelMismatchError when the wrong model is supplied", () => {
    expect(() =>
      assertPhaseModel("research", "@cf/meta/llama-3.3-70b-instruct")
    ).toThrow(PhaseModelMismatchError);
  });

  it("error message identifies the phase and both models", () => {
    let caught: PhaseModelMismatchError | null = null;
    try {
      assertPhaseModel("draft", "wrong-model");
    } catch (err) {
      caught = err as PhaseModelMismatchError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.phase).toBe("draft");
    expect(caught!.expectedModel).toBe("gemini-1.5-flash-latest");
    expect(caught!.actualModel).toBe("wrong-model");
    expect(caught!.message).toContain("draft");
    expect(caught!.message).toContain("gemini-1.5-flash-latest");
    expect(caught!.message).toContain("wrong-model");
  });

  it("throws for each Gemini phase when wrong model is supplied", () => {
    const geminiPhases: WorkflowPhase[] = ["research", "outline", "draft", "edit", "factcheck"];
    for (const phase of geminiPhases) {
      expect(() => assertPhaseModel(phase, "wrong-model")).toThrow(
        PhaseModelMismatchError
      );
    }
  });
});

// ---------------------------------------------------------------------------
// PhaseModelMismatchError
// ---------------------------------------------------------------------------

describe("PhaseModelMismatchError", () => {
  it("is an instance of Error", () => {
    const err = new PhaseModelMismatchError(
      "research",
      "gemini-1.5-flash-latest",
      "gpt-4"
    );
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct name", () => {
    const err = new PhaseModelMismatchError("edit", "gemini-1.5-flash-latest", "gpt-4");
    expect(err.name).toBe("PhaseModelMismatchError");
  });

  it("exposes phase, expectedModel, and actualModel properties", () => {
    const err = new PhaseModelMismatchError(
      "image",
      "@cf/black-forest-labs/flux-1-schnell",
      "dall-e-3"
    );
    expect(err.phase).toBe("image");
    expect(err.expectedModel).toBe("@cf/black-forest-labs/flux-1-schnell");
    expect(err.actualModel).toBe("dall-e-3");
  });
});

// ---------------------------------------------------------------------------
// compliance phase
// ---------------------------------------------------------------------------

describe("compliance phase", () => {
  it("is present in PHASE_MODEL_REGISTRY", () => {
    expect(PHASE_MODEL_REGISTRY["compliance"]).toBeDefined();
  });

  it('uses the "rule-based" model designation (no AI model required)', () => {
    expect(PHASE_MODEL_REGISTRY["compliance"].model).toBe("rule-based");
  });

  it("assertPhaseModel passes for compliance with rule-based", () => {
    expect(() => assertPhaseModel("compliance", "rule-based")).not.toThrow();
  });

  it("assertPhaseModel throws for compliance when an AI model is supplied", () => {
    expect(() => assertPhaseModel("compliance", "gemini-1.5-flash-latest")).toThrow(
      PhaseModelMismatchError
    );
  });
});
