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
