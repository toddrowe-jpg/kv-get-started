/**
 * WordPress REST API client for publishing posts.
 *
 * Uses Basic Auth with an Application Password (spaces stripped)
 * to create posts and resolve category/tag names to IDs.
 */

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
}

export interface WpPublishResult {
  postId: number;
  wpLink: string;
  status: string;
  categoryIds: number[];
  tagIds: number[];
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

  // Create the post
  const postPayload: Record<string, unknown> = {
    title: input.title,
    content: input.contentHtml,
    status,
  };
  if (categoryIds.length > 0) postPayload.categories = categoryIds;
  if (tagIds.length > 0) postPayload.tags = tagIds;

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
