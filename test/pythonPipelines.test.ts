import { describe, it, expect } from "vitest";
import {
  buildOutlinePrompt,
  buildDraftPrompt,
  buildSystemPrompt,
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
