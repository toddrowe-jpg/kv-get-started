/**
 * WordPress REST API client for publishing posts.
 *
 * Uses Basic Auth with an Application Password (spaces stripped)
 * to create posts and resolve category/tag names to IDs.
 */

/** Yoast SEO meta fields (requires the bitx-yoast-rest plugin). */
export interface YoastMeta {
  /** Yoast SEO title (_yoast_wpseo_title) */
  title?: string;
  /** Yoast SEO meta description (_yoast_wpseo_metadesc) */
  description?: string;
  /** Yoast SEO focus keyphrase (_yoast_wpseo_focuskw) */
  focuskw?: string;
}

/** A single related-link item appended to the post footer. */
export interface RelatedLink {
  title: string;
  url: string;
}

/** A single FAQ item.  Provide answerHtml for rich markup or answerText for plain text. */
export interface FaqItem {
  question: string;
  answerHtml?: string;
  answerText?: string;
}

export interface WpPublishInput {
  title: string;
  /** HTML content for the post body */
  contentHtml: string;
  /** WordPress post status (default: "draft") */
  status?: "draft" | "publish" | "pending" | "private";
  /** Array of category names to assign */
  categories?: string[];
  /** Array of tag names to assign */
  tags?: string[];
  /** Yoast SEO meta fields (optional) */
  yoast?: YoastMeta;
  /** Related links appended at the bottom of the post (max 20) */
  relatedLinks?: RelatedLink[];
  /** FAQ items appended at the bottom of the post (max 30) */
  faq?: FaqItem[];
  /**
   * Whether to append an "Apply Now" CTA button linking to
   * https://bitxcapital.com/application-journey/ (default: true).
   */
  includeApplyNowButton?: boolean;
}

export interface WpPublishResult {
  postId: number;
  wpLink: string;
  status: string;
  categoryIds: number[];
  tagIds: number[];
}

/** URL that the "Apply Now" button always links to. */
export const APPLY_NOW_URL = "https://bitxcapital.com/application-journey/";

/** Escape text so it is safe to embed inside HTML element content. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Compose the final HTML body from the input fields.
 *
 * Order of appended sections:
 *   1. Optional leading H1 (prepended when the content has no <h1>)
 *   2. Caller-supplied contentHtml
 *   3. "Apply Now" CTA button (unless includeApplyNowButton === false)
 *   4. Related Links section (when relatedLinks provided)
 *   5. FAQ section (when faq provided)
 *
 * NOTE on Yoast FAQ schema: Yoast's structured FAQ schema (HowTo/FAQ block)
 * requires the Gutenberg block editor and the Yoast SEO FAQ block. This
 * implementation renders FAQ content as semantic HTML which works as a visual
 * fallback.  To enable Yoast FAQ rich results, replace the HTML below with
 * Gutenberg-serialised FAQ blocks or use the Yoast SEO FAQ block in the WP
 * editor after importing the post.
 */
export function buildContentHtml(input: WpPublishInput): string {
  let html = input.contentHtml;

  // Ensure a single H1: prepend one using the post title when none exists
  if (!/<h1[\s>]/i.test(html)) {
    html = `<h1>${escapeHtml(input.title)}</h1>\n${html}`;
  }

  // "Apply Now" CTA button
  if (input.includeApplyNowButton !== false) {
    html +=
      `\n<p><a class="apply-now-button" href="${APPLY_NOW_URL}">Apply Now</a></p>`;
  }

  // Related Links section
  if (input.relatedLinks && input.relatedLinks.length > 0) {
    const items = input.relatedLinks
      .map(
        (l) =>
          `<li><a href="${escapeHtml(l.url)}">${escapeHtml(l.title)}</a></li>`,
      )
      .join("\n");
    html +=
      `\n<section class="related-links"><h2>Related Links</h2><ul>\n${items}\n</ul></section>`;
  }

  // FAQ section
  if (input.faq && input.faq.length > 0) {
    const items = input.faq
      .map((f) => {
        const answer = f.answerHtml
          ? f.answerHtml
          : f.answerText
            ? `<p>${escapeHtml(f.answerText)}</p>`
            : "";
        return `<div class="faq-item"><h3>${escapeHtml(f.question)}</h3>${answer}</div>`;
      })
      .join("\n");
    html +=
      `\n<!-- Yoast FAQ structured schema requires Gutenberg FAQ blocks; this HTML provides a semantic fallback. -->\n<section class="faq"><h2>Frequently Asked Questions</h2>\n${items}\n</section>`;
  }

  return html;
}

export class WpPublishError extends Error {
  constructor(
    message: string,
    public readonly wpStatus: number,
    public readonly wpBody: string,
  ) {
    super(message);
    this.name = "WpPublishError";
  }
}

/**
 * Build a Basic Auth header value for WordPress Application Passwords.
 * Strips spaces from the password before encoding (Application Passwords are
 * displayed with spaces for readability but must be sent without them).
 */
export function buildBasicAuthHeader(user: string, appPassword: string): string {
  const clean = appPassword.replace(/\s+/g, "");
  const encoded = btoa(`${user}:${clean}`);
  return `Basic ${encoded}`;
}

/**
 * Resolve a list of taxonomy term names to WordPress IDs, creating any that
 * do not yet exist. Returns the list of IDs in the same order as the input.
 *
 * @param siteUrl - WordPress site base URL (no trailing slash)
 * @param taxonomy  - "categories" or "tags"
 * @param names     - Term names to resolve
 * @param authHeader - Pre-built Authorization header value
 */
export async function resolveTermIds(
  siteUrl: string,
  taxonomy: "categories" | "tags",
  names: string[],
  authHeader: string,
): Promise<number[]> {
  if (names.length === 0) return [];

  const endpoint = taxonomy === "categories" ? "categories" : "tags";
  const ids: number[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    // Search for existing term
    const searchUrl = `${siteUrl}/wp-json/wp/v2/${endpoint}?search=${encodeURIComponent(trimmed)}&per_page=100`;
    const searchResp = await fetch(searchUrl, {
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
    });

    if (!searchResp.ok) {
      const body = await searchResp.text();
      throw new WpPublishError(
        `WordPress ${endpoint} search failed for "${trimmed}": HTTP ${searchResp.status}`,
        searchResp.status,
        body,
      );
    }

    const existing = (await searchResp.json()) as Array<{ id: number; name: string; slug: string }>;
    const match = existing.find(
      (t) => t.name.toLowerCase() === trimmed.toLowerCase() || t.slug === trimmed.toLowerCase(),
    );

    if (match) {
      ids.push(match.id);
      continue;
    }

    // Create new term
    const createResp = await fetch(`${siteUrl}/wp-json/wp/v2/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: trimmed }),
    });

    if (!createResp.ok) {
      const body = await createResp.text();
      throw new WpPublishError(
        `WordPress ${endpoint} creation failed for "${trimmed}": HTTP ${createResp.status}`,
        createResp.status,
        body,
      );
    }

    const created = (await createResp.json()) as { id: number };
    ids.push(created.id);
  }

  return ids;
}

/**
 * Publish (or create a draft of) a post on a WordPress site via the REST API.
 *
 * @param siteUrl     - WordPress site base URL (no trailing slash), e.g. https://example.kinsta.cloud
 * @param user        - WordPress username with Application Password
 * @param appPassword - Application Password (spaces are stripped automatically)
 * @param input       - Post data to publish
 */
export async function wpPublishPost(
  siteUrl: string,
  user: string,
  appPassword: string,
  input: WpPublishInput,
): Promise<WpPublishResult> {
  const authHeader = buildBasicAuthHeader(user, appPassword);
  const status = input.status ?? "draft";

  // Resolve taxonomy term names to IDs
  const categoryIds = await resolveTermIds(
    siteUrl,
    "categories",
    input.categories ?? [],
    authHeader,
  );
  const tagIds = await resolveTermIds(
    siteUrl,
    "tags",
    input.tags ?? [],
    authHeader,
  );

  // Build final HTML content (H1 injection, Apply Now button, Related Links, FAQ)
  const finalContent = buildContentHtml(input);

  // Create the post
  const postPayload: Record<string, unknown> = {
    title: input.title,
    content: finalContent,
    status,
  };
  if (categoryIds.length > 0) postPayload.categories = categoryIds;
  if (tagIds.length > 0) postPayload.tags = tagIds;

  // Yoast SEO meta (requires the bitx-yoast-rest plugin on the WP site)
  if (input.yoast) {
    const meta: Record<string, string> = {};
    const yoastFieldMap: Array<[keyof YoastMeta, string]> = [
      ["title", "_yoast_wpseo_title"],
      ["description", "_yoast_wpseo_metadesc"],
      ["focuskw", "_yoast_wpseo_focuskw"],
    ];
    for (const [field, key] of yoastFieldMap) {
      if (input.yoast[field] !== undefined) meta[key] = input.yoast[field] as string;
    }
    if (Object.keys(meta).length > 0) postPayload.meta = meta;
  }

  const postResp = await fetch(`${siteUrl}/wp-json/wp/v2/posts`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(postPayload),
  });

  if (!postResp.ok) {
    const body = await postResp.text();
    throw new WpPublishError(
      `WordPress post creation failed: HTTP ${postResp.status}`,
      postResp.status,
      body,
    );
  }

  const post = (await postResp.json()) as { id: number; link: string; status: string };

  return {
    postId: post.id,
    wpLink: post.link,
    status: post.status,
    categoryIds,
    tagIds,
  };
}
