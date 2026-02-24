import { describe, it, expect } from "vitest";
import {
  buildOutlinePrompt,
  buildDraftPrompt,
  buildSystemPrompt,
  validateNoDashes,
  runComplianceChecks,
  BlogBrief,
} from "../src/pythonPipelines";

const sampleBrief: BlogBrief = {
  topic: "SBA 7(a) Loans for small businesses",
  audience: "small business owners",
  primary_keyword: "SBA 7(a) loans",
  goal: "educate and convert",
  angle: "practical guide",
  word_count: 1200,
  sources: ["SBA.gov", "Forbes Small Business"],
};

// ---------------------------------------------------------------------------
// buildOutlinePrompt
// ---------------------------------------------------------------------------

describe("buildOutlinePrompt", () => {
  it("returns a non-empty string", () => {
    const prompt = buildOutlinePrompt(sampleBrief);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes the topic from the brief", () => {
    const prompt = buildOutlinePrompt(sampleBrief);
    expect(prompt).toContain(sampleBrief.topic);
  });

  it("includes the primary keyword", () => {
    const prompt = buildOutlinePrompt(sampleBrief);
    expect(prompt).toContain(sampleBrief.primary_keyword);
  });

  it("includes the word count", () => {
    const prompt = buildOutlinePrompt(sampleBrief);
    expect(prompt).toContain(String(sampleBrief.word_count));
  });

  it("includes instructions for title options, meta description and CTA", () => {
    const prompt = buildOutlinePrompt(sampleBrief);
    expect(prompt).toContain("Title options");
    expect(prompt).toContain("Meta description");
    expect(prompt).toContain("CTA");
  });

  it("includes source references", () => {
    const prompt = buildOutlinePrompt(sampleBrief);
    expect(prompt).toContain("SBA.gov");
  });
});

// ---------------------------------------------------------------------------
// buildDraftPrompt
// ---------------------------------------------------------------------------

describe("buildDraftPrompt", () => {
  const sampleOutline = "## Introduction\n## What is an SBA 7(a) loan?\n## How to apply";

  it("returns a non-empty string", () => {
    const prompt = buildDraftPrompt(sampleBrief, sampleOutline);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("includes the outline text", () => {
    const prompt = buildDraftPrompt(sampleBrief, sampleOutline);
    expect(prompt).toContain(sampleOutline);
  });

  it("includes the topic from the brief", () => {
    const prompt = buildDraftPrompt(sampleBrief, sampleOutline);
    expect(prompt).toContain(sampleBrief.topic);
  });

  it("includes writing requirements", () => {
    const prompt = buildDraftPrompt(sampleBrief, sampleOutline);
    expect(prompt).toContain("active voice");
    expect(prompt).toContain("CTA");
    expect(prompt).toContain("Markdown");
  });

  it("includes the target word count", () => {
    const prompt = buildDraftPrompt(sampleBrief, sampleOutline);
    expect(prompt).toContain(String(sampleBrief.word_count));
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  const styleGuide = { voice: "active", tone: "professional" };
  const brandKit = { name: "BITX Capital", colors: ["#000000", "#ffffff"] };

  it("returns a non-empty string", () => {
    const prompt = buildSystemPrompt(styleGuide, brandKit);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("embeds the style guide as JSON", () => {
    const prompt = buildSystemPrompt(styleGuide, brandKit);
    expect(prompt).toContain('"voice"');
    expect(prompt).toContain('"active"');
  });

  it("embeds the brand kit as JSON", () => {
    const prompt = buildSystemPrompt(styleGuide, brandKit);
    expect(prompt).toContain("BITX Capital");
  });

  it("instructs output in Markdown", () => {
    const prompt = buildSystemPrompt(styleGuide, brandKit);
    expect(prompt).toContain("Markdown");
  });

  it("includes non-negotiable rules", () => {
    const prompt = buildSystemPrompt(styleGuide, brandKit);
    expect(prompt).toContain("NON-NEGOTIABLE RULES");
    expect(prompt).toContain("active voice");
  });

  it("works with empty objects", () => {
    const prompt = buildSystemPrompt({}, {});
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// validateNoDashes
// ---------------------------------------------------------------------------

describe("validateNoDashes", () => {
  it("does not throw for content without forbidden dashes", () => {
    expect(() => validateNoDashes("Hello - world")).not.toThrow();
  });

  it("does not throw for an empty string", () => {
    expect(() => validateNoDashes("")).not.toThrow();
  });

  it("throws when an em-dash is present", () => {
    expect(() => validateNoDashes("Hello\u2014world")).toThrow(/forbidden dash/);
  });

  it("throws when an en-dash is present", () => {
    expect(() => validateNoDashes("2020\u20132021")).toThrow(/forbidden dash/);
  });
});

// ---------------------------------------------------------------------------
// runComplianceChecks
// ---------------------------------------------------------------------------

describe("runComplianceChecks", () => {
  it("returns an empty array for clean content", () => {
    const violations = runComplianceChecks("# SBA Loans\n\nSBA 7(a) loans are great.");
    expect(violations).toHaveLength(0);
  });

  it("flags em-dash as a violation", () => {
    const violations = runComplianceChecks("A great option\u2014truly.");
    const dashViolation = violations.find((v) => v.rule === "no_forbidden_dashes");
    expect(dashViolation).toBeDefined();
  });

  it("flags en-dash as a violation", () => {
    const violations = runComplianceChecks("Years 2020\u20132021 were tough.");
    const dashViolation = violations.find((v) => v.rule === "no_forbidden_dashes");
    expect(dashViolation).toBeDefined();
  });

  it("flags missing primary keyword when keyword is supplied", () => {
    const violations = runComplianceChecks("# Blog post\n\nSome content here.", "SBA 7(a) loans");
    const kwViolation = violations.find((v) => v.rule === "keyword_present");
    expect(kwViolation).toBeDefined();
    expect(kwViolation!.message).toContain("SBA 7(a) loans");
  });

  it("does not flag keyword when it is present (case-insensitive)", () => {
    const violations = runComplianceChecks("# Blog\n\nSBA 7(A) LOANS are helpful.", "SBA 7(a) loans");
    const kwViolation = violations.find((v) => v.rule === "keyword_present");
    expect(kwViolation).toBeUndefined();
  });

  it("skips keyword check when no keyword is supplied", () => {
    const violations = runComplianceChecks("# Blog\n\nSome content.");
    expect(violations.find((v) => v.rule === "keyword_present")).toBeUndefined();
  });

  it("flags empty content", () => {
    const violations = runComplianceChecks("   ");
    const emptyViolation = violations.find((v) => v.rule === "non_empty_content");
    expect(emptyViolation).toBeDefined();
  });

  it("returns multiple violations when several rules fail", () => {
    const violations = runComplianceChecks("A\u2014B", "missing-keyword");
    // em-dash violation + keyword missing = exactly 2 violations; content is not empty
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.rule === "no_forbidden_dashes")).toBe(true);
    expect(violations.some((v) => v.rule === "keyword_present")).toBe(true);
  });

  it("each violation has a non-empty rule and message", () => {
    const violations = runComplianceChecks("A\u2014B", "missing-keyword");
    for (const v of violations) {
      expect(typeof v.rule).toBe("string");
      expect(v.rule.length).toBeGreaterThan(0);
      expect(typeof v.message).toBe("string");
      expect(v.message.length).toBeGreaterThan(0);
    }
  });
});
