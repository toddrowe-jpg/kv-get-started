/**
 * dailyAutomation.ts
 *
 * Autonomous daily blog-draft generation.
 *
 * - Stores a brand config once under KV key "brand:default".
 * - Maintains a title backlog under KV keys "queue:titles" and "queue:cursor".
 * - On each scheduled weekday 6 AM ET run:
 *   1. Loads brand config from KV.
 *   2. Pops the next title from the queue.
 *   3. Generates a complete draft (body, summary, pull quote, FAQ, related links,
 *      Yoast meta) via Gemini in a single call.
 *   4. Generates a photorealistic hero image via Cloudflare AI.
 *   5. Uploads the hero image to WordPress Media and attaches it as the
 *      featured image of the new draft post.
 *   6. Creates the WordPress draft via wpPublishPost.
 *   7. Sends a WhatsApp admin notification using the "new_draft_created" template.
 */

import { geminiGenerate } from "./gemini";
import {
  wpPublishPost,
  wpUploadMedia,
  type WpPublishInput,
  type FaqItem,
  type RelatedLink,
  type YoastMeta,
} from "./wpPublish";

// ---------------------------------------------------------------------------
// KV key constants
// ---------------------------------------------------------------------------

export const BRAND_CONFIG_KEY = "brand:default";
export const QUEUE_TITLES_KEY = "queue:titles";
export const QUEUE_CURSOR_KEY = "queue:cursor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Brand configuration stored once in KV and reused for every draft. */
export interface BrandConfig {
  /** Human-readable brand/company name, e.g. "BITX Capital". */
  brand_name: string;
  /** Full URL to the brand logo image already hosted online. */
  logo_url: string;
  /** Primary brand colour as a CSS hex string, e.g. "#1A2E5A". */
  primary_color: string;
  /** Secondary brand colour as a CSS hex string, e.g. "#E87722". */
  secondary_color: string;
  /** Brief voice/style description used as a prompt prefix. */
  voice_style: string;
  /** Standard disclaimer appended to every post. */
  disclaimer: string;
  /**
   * Image-generation style prefix injected into the Cloudflare AI prompt,
   * e.g. "photorealistic, professional business setting, south african small
   * business owner".
   */
  image_style: string;
}

/** A single item in the title backlog queue. */
export interface QueueTitle {
  /** Blog post title. */
  title: string;
  /** Optional WordPress category name. */
  category?: string;
  /** Optional WordPress tag names. */
  tags?: string[];
  /** Optional primary SEO keyword. */
  primary_keyword?: string;
  /** Optional loan type context for BITX Capital posts. */
  loan_type?: string;
  /** Optional extra directions for the content-generation prompt. */
  directions?: string;
}

/** Shape of the JSON object Gemini is asked to return for daily drafts. */
interface GeneratedContent {
  /** Full post body as HTML (preferred) or Markdown. */
  bodyHtml?: string;
  /** Full post body as Markdown (fallback when bodyHtml absent). */
  bodyMarkdown?: string;
  /** One-sentence TL;DR placed near the top. */
  tldr?: string;
  /** Pull-quote sentence drawn from the body. */
  pullQuote?: string;
  /** Short summary / excerpt (1–2 sentences). */
  summary?: string;
  /** Yoast SEO meta fields. */
  yoast?: YoastMeta;
  /** Related links (max 20). */
  relatedLinks?: RelatedLink[];
  /** FAQ items (max 30). */
  faq?: FaqItem[];
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

/** Retrieve the brand config from KV, or null if not set. */
export async function getBrandConfig(kv: KVNamespace): Promise<BrandConfig | null> {
  const raw = await kv.get(BRAND_CONFIG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BrandConfig;
  } catch {
    return null;
  }
}

/** Persist brand config to KV. */
export async function setBrandConfig(kv: KVNamespace, config: BrandConfig): Promise<void> {
  await kv.put(BRAND_CONFIG_KEY, JSON.stringify(config));
}

/** Retrieve the full title queue from KV. */
export async function getTitleQueue(kv: KVNamespace): Promise<QueueTitle[]> {
  const raw = await kv.get(QUEUE_TITLES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as QueueTitle[];
  } catch {
    return [];
  }
}

/** Persist the title queue to KV. */
export async function setTitleQueue(kv: KVNamespace, titles: QueueTitle[]): Promise<void> {
  await kv.put(QUEUE_TITLES_KEY, JSON.stringify(titles));
}

/** Retrieve the current queue cursor (zero-based index). */
export async function getQueueCursor(kv: KVNamespace): Promise<number> {
  const raw = await kv.get(QUEUE_CURSOR_KEY);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return isNaN(n) ? 0 : n;
}

/** Persist the queue cursor. */
export async function setQueueCursor(kv: KVNamespace, cursor: number): Promise<void> {
  await kv.put(QUEUE_CURSOR_KEY, String(cursor));
}

/**
 * Read-then-advance: returns the next QueueTitle together with the cursor
 * value that should be written after a successful publish.  Caller is
 * responsible for calling setQueueCursor(newCursor) on success.
 *
 * Returns null when the queue is exhausted.
 */
export async function getNextQueueItem(
  kv: KVNamespace,
): Promise<{ item: QueueTitle; newCursor: number } | null> {
  const [titles, cursor] = await Promise.all([getTitleQueue(kv), getQueueCursor(kv)]);
  if (cursor >= titles.length) return null;
  return { item: titles[cursor], newCursor: cursor + 1 };
}

// ---------------------------------------------------------------------------
// Time gate
// ---------------------------------------------------------------------------

/**
 * Returns true if `date` falls on a Monday–Friday when the clock in the
 * America/New_York timezone shows hour 6 (06:00–06:59).
 *
 * Used by the scheduled handler to no-op when the Worker fires at the
 * "wrong" UTC time (needed because a single cron expression cannot express
 * DST-aware ET times).
 */
export function isWeekday6amET(date: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "99", 10);
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  return weekdays.includes(weekday) && hour === 6;
}

// ---------------------------------------------------------------------------
// Content building helpers
// ---------------------------------------------------------------------------

/**
 * Build a Gutenberg HTML block containing the brand logo + brand colours.
 * Injected as a branded header at the top of every auto-generated post body.
 */
export function buildBrandHeaderHtml(brand: BrandConfig): string {
  return (
    `<!-- wp:html -->\n` +
    `<div class="brand-header" style="background-color:${brand.primary_color};padding:16px 24px;display:flex;align-items:center;gap:16px;">\n` +
    `  <img src="${brand.logo_url}" alt="${brand.brand_name} logo" style="height:48px;width:auto;" loading="lazy" />\n` +
    `  <span style="color:#ffffff;font-size:1.1em;font-weight:600;">${brand.brand_name}</span>\n` +
    `</div>\n` +
    `<!-- /wp:html -->`
  );
}

/**
 * Build the Gemini prompt that generates the entire draft in a single call.
 * Returns a JSON-schema prompt instructing the model to output a valid JSON
 * object matching GeneratedContent.
 */
export function buildDailyDraftPrompt(item: QueueTitle, brand: BrandConfig): string {
  const keyword = item.primary_keyword ?? item.title;
  const directions = item.directions ? `\nExtra directions: ${item.directions}` : "";
  const loanContext = item.loan_type ? `\nLoan type context: ${item.loan_type}` : "";

  return (
    `You are a professional financial blog writer for ${brand.brand_name}.\n` +
    `Voice/style: ${brand.voice_style}\n` +
    `Target audience: South African small business owners and individuals seeking finance.\n` +
    `\n` +
    `Write a complete, SEO-optimised blog draft for the following title:\n` +
    `"${item.title}"${loanContext}${directions}\n` +
    `\n` +
    `Return ONLY a valid JSON object (no markdown fences, no extra commentary) with these exact keys:\n` +
    `{\n` +
    `  "bodyHtml": "<full post body as semantic HTML with h2/h3 headings, paragraphs, and an internal Table of Contents anchor list at the top>",\n` +
    `  "tldr": "<one sentence summary>",\n` +
    `  "pullQuote": "<one compelling pull-quote sentence from the body>",\n` +
    `  "summary": "<1-2 sentence excerpt suitable for the post meta description>",\n` +
    `  "yoast": {\n` +
    `    "title": "<SEO title ≤ 60 chars>",\n` +
    `    "description": "<meta description ≤ 155 chars>",\n` +
    `    "focuskw": "<primary focus keyphrase>"\n` +
    `  },\n` +
    `  "relatedLinks": [\n` +
    `    { "title": "<link title>", "url": "<absolute URL>" }\n` +
    `    // up to 20 items relevant to South African finance / ${brand.brand_name}\n` +
    `  ],\n` +
    `  "faq": [\n` +
    `    { "question": "<question>", "answerText": "<plain-text answer>" }\n` +
    `    // 8-12 FAQ items optimised for FAQPage schema\n` +
    `  ]\n` +
    `}\n` +
    `\n` +
    `Primary keyword to target: "${keyword}"\n` +
    `Word count target: ~1 200 words for bodyHtml.\n` +
    `Include the following disclaimer verbatim as the last paragraph inside bodyHtml:\n` +
    `"${brand.disclaimer}"`
  );
}

// ---------------------------------------------------------------------------
// WhatsApp notification helper (self-contained to avoid circular imports)
// ---------------------------------------------------------------------------

const WHATSAPP_GRAPH_API_VERSION = "v25.0";

async function sendDraftNotification(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  blogTitle: string,
  wpLink: string,
): Promise<void> {
  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}/${phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: "new_draft_created",
          language: { code: "en_US" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", parameter_name: "blog_title", text: blogTitle },
                { type: "text", parameter_name: "wp_link", text: wpLink },
              ],
            },
          ],
        },
      }),
    });
    if (res.ok) {
      console.log("[daily-automation] WhatsApp notification sent", res.status);
    } else {
      console.error("[daily-automation] WhatsApp notification failed", res.status);
    }
  } catch (err) {
    console.error("[daily-automation] WhatsApp notification error", String(err));
  }
}

// ---------------------------------------------------------------------------
// Minimal Env interface used by runDailyAutomation
// ---------------------------------------------------------------------------

export interface DailyAutomationEnv {
  GEMINI_API_KEY?: string;
  AI?: { run(model: string, input: unknown): Promise<unknown> };
  BLOG_WORKFLOW_STATE: KVNamespace;
  WP_SITE_URL?: string;
  WP_USER?: string;
  WP_APP_PASSWORD?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_ADMIN_NUMBER?: string;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export interface DailyAutomationResult {
  status: "published" | "skipped" | "exhausted" | "error";
  message: string;
  postId?: number;
  wpLink?: string;
}

/**
 * Run one iteration of the daily blog-draft automation.
 *
 * Intended to be called from the Worker's `scheduled` handler (and also
 * exposed via `POST /queue/run-next` for manual testing).
 *
 * @param env - Worker environment bindings (WP creds, KV, AI, Gemini key)
 */
export async function runDailyAutomation(
  env: DailyAutomationEnv,
): Promise<DailyAutomationResult> {
  // ── 1. Load brand config ─────────────────────────────────────────────────
  const brandConfig = await getBrandConfig(env.BLOG_WORKFLOW_STATE);
  if (!brandConfig) {
    console.log("[daily-automation] no brand config found, skipping");
    return { status: "skipped", message: "No brand config found. Set it via PUT /brand." };
  }

  // ── 2. Pop next title from queue ─────────────────────────────────────────
  const next = await getNextQueueItem(env.BLOG_WORKFLOW_STATE);
  if (!next) {
    console.log("[daily-automation] title queue exhausted");
    return { status: "exhausted", message: "Title queue is exhausted." };
  }
  const { item, newCursor } = next;
  console.log(`[daily-automation] processing title: "${item.title}" (cursor → ${newCursor})`);

  // ── 3. Guard: require Gemini key ─────────────────────────────────────────
  if (!env.GEMINI_API_KEY) {
    return { status: "error", message: "GEMINI_API_KEY not configured." };
  }

  // ── 4. Generate content via Gemini ───────────────────────────────────────
  const contentPrompt = buildDailyDraftPrompt(item, brandConfig);
  let generated: GeneratedContent;
  try {
    const rawJson = await geminiGenerate(env.GEMINI_API_KEY, contentPrompt, "daily-automation");
    // Strip optional markdown code fences
    const cleaned = rawJson.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    generated = JSON.parse(cleaned) as GeneratedContent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[daily-automation] content generation failed:", msg);
    return { status: "error", message: `Content generation failed: ${msg}` };
  }

  // ── 5. Generate hero image via Cloudflare AI ─────────────────────────────
  let featuredMediaId: number | undefined;
  if (env.AI && env.WP_SITE_URL && env.WP_USER && env.WP_APP_PASSWORD) {
    try {
      const imagePrompt = `${brandConfig.image_style}, ${item.title}`;
      const raw = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
        prompt: imagePrompt,
        num_steps: 8,
      });

      // Decode response — Flux returns base64 in { image: string } or raw ArrayBuffer
      let imageBytes: Uint8Array | null = null;
      if (raw instanceof ArrayBuffer) {
        imageBytes = new Uint8Array(raw);
      } else if (
        raw &&
        typeof raw === "object" &&
        "image" in (raw as object) &&
        typeof (raw as Record<string, unknown>).image === "string"
      ) {
        const b64 = (raw as { image: string }).image;
        imageBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      }

      if (imageBytes && imageBytes.length > 0) {
        const mediaId = await wpUploadMedia(
          env.WP_SITE_URL,
          env.WP_USER,
          env.WP_APP_PASSWORD,
          imageBytes,
          "hero-image.png",
          "image/png",
        );
        featuredMediaId = mediaId;
        console.log(`[daily-automation] hero image uploaded, media ID: ${mediaId}`);
      }
    } catch (err) {
      // Non-fatal: log and continue without a featured image
      console.error("[daily-automation] hero image generation/upload failed:", String(err));
    }
  }

  // ── 6. Build post content ────────────────────────────────────────────────
  const brandHeaderBlock = buildBrandHeaderHtml(brandConfig);

  const tldrBlock = generated.tldr
    ? `<div class="tldr-section" style="background:#f5f5f5;border-left:4px solid ${brandConfig.primary_color};padding:12px 16px;margin-bottom:1em;"><strong>TL;DR:</strong> ${generated.tldr}</div>`
    : "";

  const summaryBlock = generated.summary
    ? `<p class="post-excerpt"><em>${generated.summary}</em></p>`
    : "";

  const pullQuoteBlock = generated.pullQuote
    ? `<!-- wp:pullquote -->\n<figure class="wp-block-pullquote"><blockquote><p>${generated.pullQuote}</p></blockquote></figure>\n<!-- /wp:pullquote -->`
    : "";

  const bodyHtml =
    generated.bodyHtml ??
    (generated.bodyMarkdown ? `<p>${generated.bodyMarkdown}</p>` : `<p>${item.title}</p>`);

  // Concatenate all visible sections; buildContentBlocks will wrap the whole
  // thing in a wp:html block and append CTA + Related Links + FAQ.
  const combinedContentHtml = [brandHeaderBlock, summaryBlock, tldrBlock, bodyHtml, pullQuoteBlock]
    .filter(Boolean)
    .join("\n\n");

  // ── 7. Publish WordPress draft ───────────────────────────────────────────
  if (!env.WP_SITE_URL || !env.WP_USER || !env.WP_APP_PASSWORD) {
    return { status: "error", message: "WordPress credentials (WP_SITE_URL, WP_USER, WP_APP_PASSWORD) not configured." };
  }

  const wpInput: WpPublishInput = {
    title: item.title,
    contentHtml: combinedContentHtml,
    status: "draft",
    categories: item.category ? [item.category] : [],
    tags: item.tags ?? [],
    yoast: generated.yoast,
    relatedLinks: generated.relatedLinks?.slice(0, 20),
    faq: generated.faq?.slice(0, 30),
    includeApplyNowButton: true,
    featuredMediaId,
  };

  const result = await wpPublishPost(
    env.WP_SITE_URL,
    env.WP_USER,
    env.WP_APP_PASSWORD,
    wpInput,
  );

  console.log(`[daily-automation] draft created: postId=${result.postId}, link=${result.wpLink}`);

  // ── 8. Advance queue cursor (only after successful publish) ──────────────
  await setQueueCursor(env.BLOG_WORKFLOW_STATE, newCursor);

  // ── 9. WhatsApp admin notification (fire-and-forget) ────────────────────
  if (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ADMIN_NUMBER) {
    void sendDraftNotification(
      env.WHATSAPP_PHONE_NUMBER_ID,
      env.WHATSAPP_ACCESS_TOKEN,
      env.WHATSAPP_ADMIN_NUMBER,
      item.title,
      result.wpLink,
    );
  }

  return {
    status: "published",
    message: `Draft created: ${result.wpLink}`,
    postId: result.postId,
    wpLink: result.wpLink,
  };
}
