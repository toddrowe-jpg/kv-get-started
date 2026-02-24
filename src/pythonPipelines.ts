/**
 * pythonPipelines.ts
 *
 * TypeScript ports of the prompt-builder pipeline defined in
 * path/to/blog_writing_worker_direction.py.
 *
 * Each function mirrors the corresponding Python function and produces
 * the same prompt structure so the TS Worker can execute the same
 * pipelines that the Python script describes.
 */

/** Input model for blog brief data (mirrors Python BlogBrief dataclass). */
export interface BlogBrief {
  /** The blog topic. */
  topic: string;
  /** Target audience for the post. */
  audience: string;
  /** Primary SEO keyword. */
  primary_keyword: string;
  /** Goal/purpose of the post. */
  goal: string;
  /** Unique angle or perspective. */
  angle: string;
  /** Approximate target word count. */
  word_count: number;
  /** List of reference source titles or URLs. */
  sources: string[];
}

/**
 * Builds the system prompt that configures the LLM's persona and constraints.
 * Mirrors Python `system_prompt(style_guide, brand_kit)`.
 *
 * @param styleGuide - Style guide configuration object.
 * @param brandKit   - Brand kit configuration object.
 */
export function buildSystemPrompt(
  styleGuide: Record<string, unknown>,
  brandKit: Record<string, unknown>,
): string {
  return `You are a professional blog writing worker.

NON-NEGOTIABLE RULES:
- Follow the STYLE GUIDE and BRAND KIT exactly.
- Use active voice whenever possible.
- Use transitions to improve flow (per style guide).
- Maintain consistent brand tone and terminology.
- Avoid forbidden phrases.
- Output in Markdown.

STYLE GUIDE (authoritative):
${JSON.stringify(styleGuide, null, 2)}

BRAND KIT (authoritative):
${JSON.stringify(brandKit, null, 2)}`.trim();
}

/**
 * Builds the outline prompt for the outline/research phase.
 * Mirrors Python `outline_prompt(brief)`.
 *
 * @param brief - Blog brief configuration.
 */
export function buildOutlinePrompt(brief: BlogBrief): string {
  return `Create a detailed blog outline for this brief.

BRIEF:
- Topic: ${brief.topic}
- Audience: ${brief.audience}
- Primary keyword: ${brief.primary_keyword}
- Goal: ${brief.goal}
- Angle: ${brief.angle}
- Word count: ~${brief.word_count}
- Sources to reference: ${JSON.stringify(brief.sources)}

Return:
1) High CTR Title options (5)
2) One chosen title
3) Meta description (<= 155 chars)
4) Outline with H2/H3s and bullet notes under each
5) Suggested CTA`.trim();
}

/**
 * Builds the draft prompt for the draft/write phase.
 * Mirrors Python `draft_prompt(brief, outline)`.
 *
 * @param brief   - Blog brief configuration.
 * @param outline - The outline produced by the outline phase.
 */
export function buildDraftPrompt(brief: BlogBrief, outline: string): string {
  return `Write the full blog post based on the outline.

BRIEF:
- Topic: ${brief.topic}
- Audience: ${brief.audience}
- Primary keyword: ${brief.primary_keyword}
- Goal: ${brief.goal}
- Angle: ${brief.angle}
- Target length: ~${brief.word_count} words

OUTLINE:
${outline}

Requirements:
- Use short paragraphs.
- Include transitions between major sections.
- Prefer active voice.
- Include a clear CTA near the end.
- Naturally include the primary keyword (no stuffing).
Return only the Markdown blog post.`.trim();
}

// ---------------------------------------------------------------------------
// Compliance validators (ported from path/to/blog_writing_worker_direction.py)
// ---------------------------------------------------------------------------

/** Forbidden dash characters mirroring Python's DASH_FORBIDDEN constant. */
const DASH_FORBIDDEN = ["\u2014", "\u2013"] as const; // em-dash, en-dash

/** A single compliance or validation violation found in a blog draft. */
export interface ComplianceViolation {
  /** Short identifier for the rule that was violated. */
  rule: string;
  /** Human-readable description of the violation. */
  message: string;
}

/**
 * Validates that `md` contains no em-dash (—) or en-dash (–) characters.
 * Mirrors Python `validate_no_dashes(md)`.
 *
 * @throws {Error} if a forbidden dash character is found.
 */
export function validateNoDashes(md: string): void {
  for (const ch of DASH_FORBIDDEN) {
    if (md.includes(ch)) {
      throw new Error("Found forbidden dash character (\u2014 or \u2013).");
    }
  }
}

/**
 * Runs all compliance checks on `md` and returns an array of violations.
 * Violations are collected (not thrown) so all issues can be reported at once.
 * Mirrors the suite of validators in `path/to/blog_writing_worker_direction.py`.
 *
 * Checks performed:
 *  1. No forbidden dash characters (em-dash or en-dash).
 *  2. Primary keyword present at least once (when `primaryKeyword` is supplied).
 *  3. Content is not empty.
 *
 * @param md             - The Markdown content to validate.
 * @param primaryKeyword - Optional primary SEO keyword that must appear in `md`.
 */
export function runComplianceChecks(
  md: string,
  primaryKeyword?: string,
): ComplianceViolation[] {
  const violations: ComplianceViolation[] = [];

  // Rule 1: no forbidden dash characters
  for (const ch of DASH_FORBIDDEN) {
    if (md.includes(ch)) {
      violations.push({
        rule: "no_forbidden_dashes",
        message: `Forbidden dash character found: "${ch}" (em-dash or en-dash is not allowed).`,
      });
      break; // one violation per rule is enough
    }
  }

  // Rule 2: primary keyword must appear in the content
  if (primaryKeyword && primaryKeyword.trim().length > 0) {
    if (!md.toLowerCase().includes(primaryKeyword.toLowerCase())) {
      violations.push({
        rule: "keyword_present",
        message: `Primary keyword "${primaryKeyword}" not found in the draft.`,
      });
    }
  }

  // Rule 3: content must not be empty
  if (md.trim().length === 0) {
    violations.push({
      rule: "non_empty_content",
      message: "Draft content is empty.",
    });
  }

  return violations;
}
