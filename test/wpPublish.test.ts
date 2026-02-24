import { describe, it, expect } from "vitest";
import {
  buildBasicAuthHeader,
  wpPublishPost,
  WpPublishError,
  resolveTermIds,
  buildContentHtml,
  buildContentBlocks,
  escapeHtml,
  APPLY_NOW_URL,
} from "../src/wpPublish";

// ---------------------------------------------------------------------------
// buildBasicAuthHeader
// ---------------------------------------------------------------------------
describe("buildBasicAuthHeader", () => {
  it("builds a correct Basic auth header without spaces", () => {
    const header = buildBasicAuthHeader("user", "pass");
    expect(header).toBe(`Basic ${btoa("user:pass")}`);
  });

  it("strips spaces from the app password before encoding", () => {
    const header = buildBasicAuthHeader("bitx-worker", "abcd efgh ijkl");
    expect(header).toBe(`Basic ${btoa("bitx-worker:abcdefghijkl")}`);
  });

  it("strips multiple consecutive spaces", () => {
    const header = buildBasicAuthHeader("u", "a b  c   d");
    expect(header).toBe(`Basic ${btoa("u:abcd")}`);
  });

  it("handles password with no spaces (no-op)", () => {
    const header = buildBasicAuthHeader("u", "nospaces");
    expect(header).toBe(`Basic ${btoa("u:nospaces")}`);
  });
});

// ---------------------------------------------------------------------------
// WpPublishError
// ---------------------------------------------------------------------------
describe("WpPublishError", () => {
  it("preserves wpStatus and wpBody", () => {
    const err = new WpPublishError("Post failed", 422, '{"code":"invalid_param"}');
    expect(err.message).toBe("Post failed");
    expect(err.wpStatus).toBe(422);
    expect(err.wpBody).toBe('{"code":"invalid_param"}');
    expect(err.name).toBe("WpPublishError");
  });

  it("is an instance of Error", () => {
    const err = new WpPublishError("x", 500, "");
    expect(err instanceof Error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveTermIds — mocked fetch
// ---------------------------------------------------------------------------
describe("resolveTermIds", () => {
  it("returns an empty array when no names are provided", async () => {
    const ids = await resolveTermIds("https://example.com", "categories", [], "Basic abc");
    expect(ids).toEqual([]);
  });

  it("returns the existing term ID when found by search", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([{ id: 42, name: "Finance", slug: "finance" }]), { status: 200 });

    try {
      const ids = await resolveTermIds("https://example.com", "categories", ["Finance"], "Basic abc");
      expect(ids).toEqual([42]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("creates a new term and returns its ID when not found", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        // Search returns empty
        return new Response(JSON.stringify([]), { status: 200 });
      }
      // Create returns new term
      return new Response(JSON.stringify({ id: 99, name: "NewTag", slug: "newtag" }), { status: 201 });
    };

    try {
      const ids = await resolveTermIds("https://example.com", "tags", ["NewTag"], "Basic abc");
      expect(ids).toEqual([99]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws WpPublishError when search returns non-2xx", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Forbidden", { status: 403 });

    try {
      await expect(
        resolveTermIds("https://example.com", "categories", ["Test"], "Basic abc")
      ).rejects.toBeInstanceOf(WpPublishError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws WpPublishError when creation returns non-2xx", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      if (callCount === 1) return new Response(JSON.stringify([]), { status: 200 });
      return new Response("Internal Server Error", { status: 500 });
    };

    try {
      await expect(
        resolveTermIds("https://example.com", "tags", ["NewTag"], "Basic abc")
      ).rejects.toBeInstanceOf(WpPublishError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// wpPublishPost — mocked fetch
// ---------------------------------------------------------------------------
describe("wpPublishPost", () => {
  it("creates a post and returns postId, wpLink, status, categoryIds, tagIds", async () => {
    const originalFetch = globalThis.fetch;
    // All taxonomy searches return empty, creation not needed (no cats/tags)
    globalThis.fetch = async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/wp-json/wp/v2/posts")) {
        return new Response(
          JSON.stringify({ id: 1001, link: "https://example.com/?p=1001", status: "draft" }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const result = await wpPublishPost(
        "https://example.com",
        "bitx-worker",
        "abcd efgh",
        { title: "My Post", contentHtml: "<p>Hello</p>" }
      );
      expect(result.postId).toBe(1001);
      expect(result.wpLink).toBe("https://example.com/?p=1001");
      expect(result.status).toBe("draft");
      expect(result.categoryIds).toEqual([]);
      expect(result.tagIds).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("resolves category and tag names to IDs and includes them in the request", async () => {
    const originalFetch = globalThis.fetch;
    const capturedBodies: string[] = [];

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/wp-json/wp/v2/posts") && !urlStr.includes("categories") && !urlStr.includes("tags")) {
        capturedBodies.push(init?.body as string);
        return new Response(
          JSON.stringify({ id: 2002, link: "https://example.com/?p=2002", status: "publish" }),
          { status: 201 }
        );
      }
      if (urlStr.includes("categories")) {
        return new Response(JSON.stringify([{ id: 5, name: "Finance", slug: "finance" }]), { status: 200 });
      }
      if (urlStr.includes("tags")) {
        return new Response(JSON.stringify([{ id: 8, name: "crypto", slug: "crypto" }]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      const result = await wpPublishPost(
        "https://example.com",
        "user",
        "pass",
        {
          title: "Post with Taxonomy",
          contentHtml: "<p>Content</p>",
          status: "publish",
          categories: ["Finance"],
          tags: ["crypto"],
        }
      );
      expect(result.categoryIds).toEqual([5]);
      expect(result.tagIds).toEqual([8]);
      const body = JSON.parse(capturedBodies[0]);
      expect(body.categories).toEqual([5]);
      expect(body.tags).toEqual([8]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws WpPublishError when WordPress post creation fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr.includes("/wp-json/wp/v2/posts")) {
        return new Response('{"code":"rest_invalid_param"}', { status: 400 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      await expect(
        wpPublishPost("https://example.com", "u", "p", { title: "T", contentHtml: "<p>C</p>" })
      ).rejects.toBeInstanceOf(WpPublishError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses 'draft' as default status when none is provided", async () => {
    const originalFetch = globalThis.fetch;
    const capturedBodies: string[] = [];

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/wp-json/wp/v2/posts")) {
        capturedBodies.push(init?.body as string);
        return new Response(
          JSON.stringify({ id: 3003, link: "https://example.com/?p=3003", status: "draft" }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      await wpPublishPost("https://example.com", "u", "p", {
        title: "Draft",
        contentHtml: "<p>x</p>",
      });
      const body = JSON.parse(capturedBodies[0]);
      expect(body.status).toBe("draft");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
describe("escapeHtml", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml("Hello <World> & \"Friends\" '")).toBe(
      "Hello &lt;World&gt; &amp; &quot;Friends&quot; &#39;"
    );
  });

  it("returns the same string when no special characters are present", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});

// ---------------------------------------------------------------------------
// buildContentHtml
// ---------------------------------------------------------------------------
describe("buildContentHtml", () => {
  it("prepends an H1 when content lacks one", () => {
    const html = buildContentHtml({ title: "My Title", contentHtml: "<p>Body</p>" });
    expect(html).toContain("<h1>My Title</h1>");
    expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf("<p>Body</p>"));
  });

  it("does not prepend an H1 when content already has one", () => {
    const html = buildContentHtml({
      title: "My Title",
      contentHtml: "<h1>Existing H1</h1><p>Body</p>",
    });
    expect(html.match(/<h1/gi)?.length).toBe(1);
    expect(html).toContain("<h1>Existing H1</h1>");
  });

  it("appends Apply Now button by default", () => {
    const html = buildContentHtml({ title: "T", contentHtml: "<p>x</p>" });
    expect(html).toContain(`href="${APPLY_NOW_URL}"`);
    expect(html).toContain("Apply Now");
  });

  it("omits Apply Now button when includeApplyNowButton is false", () => {
    const html = buildContentHtml({
      title: "T",
      contentHtml: "<p>x</p>",
      includeApplyNowButton: false,
    });
    expect(html).not.toContain("Apply Now");
  });

  it("appends a Related Links section when relatedLinks provided", () => {
    const html = buildContentHtml({
      title: "T",
      contentHtml: "<p>x</p>",
      relatedLinks: [
        { title: "Link One", url: "https://example.com/one" },
        { title: "Link Two", url: "https://example.com/two" },
      ],
    });
    expect(html).toContain("Related Links");
    expect(html).toContain("https://example.com/one");
    expect(html).toContain("Link One");
    expect(html).toContain("https://example.com/two");
    expect(html).toContain("Link Two");
  });

  it("does not append a Related Links section when relatedLinks is empty", () => {
    const html = buildContentHtml({ title: "T", contentHtml: "<p>x</p>", relatedLinks: [] });
    expect(html).not.toContain("Related Links");
  });

  it("appends an FAQ section with answerHtml", () => {
    const html = buildContentHtml({
      title: "T",
      contentHtml: "<p>x</p>",
      faq: [{ question: "What is X?", answerHtml: "<p>X is great</p>" }],
    });
    expect(html).toContain("Frequently Asked Questions");
    expect(html).toContain("What is X?");
    expect(html).toContain("<p>X is great</p>");
  });

  it("appends an FAQ section with answerText (escaped)", () => {
    const html = buildContentHtml({
      title: "T",
      contentHtml: "<p>x</p>",
      faq: [{ question: "Who are you?", answerText: "I am <you>" }],
    });
    expect(html).toContain("Who are you?");
    expect(html).toContain("I am &lt;you&gt;");
  });

  it("appends an FAQ section with no answer when both answerHtml and answerText are absent", () => {
    const html = buildContentHtml({
      title: "T",
      contentHtml: "<p>x</p>",
      faq: [{ question: "Empty?" }],
    });
    expect(html).toContain("Empty?");
    expect(html).toContain("faq-item");
  });

  it("escapes HTML in title when prepending H1", () => {
    const html = buildContentHtml({ title: "Loans & <Mortgages>", contentHtml: "<p>x</p>" });
    expect(html).toContain("<h1>Loans &amp; &lt;Mortgages&gt;</h1>");
  });

  it("sections appear in correct order: H1, content, Apply Now, Related Links, FAQ", () => {
    const html = buildContentHtml({
      title: "T",
      contentHtml: "<p>body</p>",
      relatedLinks: [{ title: "L", url: "https://example.com" }],
      faq: [{ question: "Q?", answerText: "A" }],
    });
    const h1Pos = html.indexOf("<h1>");
    const bodyPos = html.indexOf("<p>body</p>");
    const applyPos = html.indexOf("Apply Now");
    const relatedPos = html.indexOf("Related Links");
    const faqPos = html.indexOf("Frequently Asked Questions");
    expect(h1Pos).toBeLessThan(bodyPos);
    expect(bodyPos).toBeLessThan(applyPos);
    expect(applyPos).toBeLessThan(relatedPos);
    expect(relatedPos).toBeLessThan(faqPos);
  });
});

// ---------------------------------------------------------------------------
// wpPublishPost — Yoast meta
// ---------------------------------------------------------------------------
describe("wpPublishPost with Yoast meta", () => {
  it("sends Yoast meta keys in the WP payload when yoast is provided", async () => {
    const originalFetch = globalThis.fetch;
    const capturedBodies: string[] = [];

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/wp-json/wp/v2/posts") && !urlStr.includes("categories") && !urlStr.includes("tags")) {
        capturedBodies.push(init?.body as string);
        return new Response(
          JSON.stringify({ id: 5005, link: "https://example.com/?p=5005", status: "draft" }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      await wpPublishPost("https://example.com", "u", "p", {
        title: "SEO Post",
        contentHtml: "<p>Content</p>",
        yoast: {
          title: "SEO Title",
          description: "SEO Description",
          focuskw: "loans",
        },
      });
      const body = JSON.parse(capturedBodies[0]);
      expect(body.meta._yoast_wpseo_title).toBe("SEO Title");
      expect(body.meta._yoast_wpseo_metadesc).toBe("SEO Description");
      expect(body.meta._yoast_wpseo_focuskw).toBe("loans");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not include meta when yoast is not provided", async () => {
    const originalFetch = globalThis.fetch;
    const capturedBodies: string[] = [];

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/wp-json/wp/v2/posts")) {
        capturedBodies.push(init?.body as string);
        return new Response(
          JSON.stringify({ id: 6006, link: "https://example.com/?p=6006", status: "draft" }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      await wpPublishPost("https://example.com", "u", "p", {
        title: "No Yoast",
        contentHtml: "<p>Content</p>",
      });
      const body = JSON.parse(capturedBodies[0]);
      expect(body.meta).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends only provided Yoast sub-fields (partial yoast object)", async () => {
    const originalFetch = globalThis.fetch;
    const capturedBodies: string[] = [];

    globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.includes("/wp-json/wp/v2/posts")) {
        capturedBodies.push(init?.body as string);
        return new Response(
          JSON.stringify({ id: 7007, link: "https://example.com/?p=7007", status: "draft" }),
          { status: 201 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    };

    try {
      await wpPublishPost("https://example.com", "u", "p", {
        title: "Partial Yoast",
        contentHtml: "<p>x</p>",
        yoast: { title: "Only Title" },
      });
      const body = JSON.parse(capturedBodies[0]);
      expect(body.meta._yoast_wpseo_title).toBe("Only Title");
      expect(body.meta._yoast_wpseo_metadesc).toBeUndefined();
      expect(body.meta._yoast_wpseo_focuskw).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// buildContentBlocks
// ---------------------------------------------------------------------------
describe("buildContentBlocks", () => {
  it("output contains Gutenberg block delimiters", () => {
    const out = buildContentBlocks({ title: "T", contentHtml: "<p>body</p>" });
    expect(out).toContain("<!-- wp:");
    expect(out).toContain("<!-- /wp:");
  });

  it("prepends an H1 block when content lacks one", () => {
    const out = buildContentBlocks({ title: "My Title", contentHtml: "<p>Body</p>" });
    expect(out).toContain('<!-- wp:heading {"level":1} -->');
    expect(out).toContain('<h1 class="wp-block-heading">My Title</h1>');
    expect(out).toContain("<!-- /wp:heading -->");
    expect(out.indexOf("<!-- wp:heading")).toBeLessThan(out.indexOf("<!-- wp:html -->"));
  });

  it("does not prepend an H1 block when content already has one", () => {
    const out = buildContentBlocks({
      title: "My Title",
      contentHtml: "<h1>Existing H1</h1><p>Body</p>",
    });
    expect(out.match(/<h1/gi)?.length).toBe(1);
    expect(out).not.toContain("<!-- wp:heading");
  });

  it("wraps caller HTML in a wp:html block", () => {
    const out = buildContentBlocks({ title: "T", contentHtml: "<p>content</p>" });
    expect(out).toContain("<!-- wp:html -->");
    expect(out).toContain("<p>content</p>");
    expect(out).toContain("<!-- /wp:html -->");
  });

  it("appends Apply Now button block by default", () => {
    const out = buildContentBlocks({ title: "T", contentHtml: "<p>x</p>" });
    expect(out).toContain("<!-- wp:buttons -->");
    expect(out).toContain("<!-- wp:button");
    expect(out).toContain(`href="${APPLY_NOW_URL}"`);
    expect(out).toContain("Apply Now");
  });

  it("omits Apply Now block when includeApplyNowButton is false", () => {
    const out = buildContentBlocks({
      title: "T",
      contentHtml: "<p>x</p>",
      includeApplyNowButton: false,
    });
    expect(out).not.toContain("Apply Now");
    expect(out).not.toContain("<!-- wp:buttons -->");
  });

  it("appends Related Links as Gutenberg heading + list blocks", () => {
    const out = buildContentBlocks({
      title: "T",
      contentHtml: "<p>x</p>",
      relatedLinks: [
        { title: "Link One", url: "https://example.com/one" },
        { title: "Link Two", url: "https://example.com/two" },
      ],
    });
    expect(out).toContain('<!-- wp:heading {"level":2} -->');
    expect(out).toContain('<h2 class="wp-block-heading">Related Links</h2>');
    expect(out).toContain("<!-- wp:list -->");
    expect(out).toContain("<!-- wp:list-item -->");
    expect(out).toContain("https://example.com/one");
    expect(out).toContain("Link One");
    expect(out).toContain("https://example.com/two");
    expect(out).toContain("Link Two");
  });

  it("does not append a Related Links block when relatedLinks is empty", () => {
    const out = buildContentBlocks({ title: "T", contentHtml: "<p>x</p>", relatedLinks: [] });
    expect(out).not.toContain("Related Links");
    expect(out).not.toContain("<!-- wp:list -->");
  });

  it("appends Yoast FAQ block when faq is provided", () => {
    const out = buildContentBlocks({
      title: "T",
      contentHtml: "<p>x</p>",
      faq: [{ question: "What is X?", answerHtml: "<p>X is great</p>" }],
    });
    expect(out).toContain("<!-- wp:yoast/faq-block");
    expect(out).toContain("<!-- /wp:yoast/faq-block -->");
    expect(out).toContain('"questions"');
    expect(out).toContain("What is X?");
    expect(out).toContain("schema-faq wp-block-yoast-faq-block");
    expect(out).toContain("schema-faq-section");
    expect(out).toContain("schema-faq-question");
  });

  it("Yoast FAQ block encodes answerText (escaped)", () => {
    const out = buildContentBlocks({
      title: "T",
      contentHtml: "<p>x</p>",
      faq: [{ question: "Who?", answerText: "I am <you>" }],
    });
    expect(out).toContain("I am &lt;you&gt;");
    expect(out).toContain("schema-faq-answer");
  });

  it("Yoast FAQ block contains the correct block comment markers and attributes", () => {
    const out = buildContentBlocks({
      title: "T",
      contentHtml: "<p>x</p>",
      faq: [
        { question: "Q1?", answerText: "A1" },
        { question: "Q2?", answerText: "A2" },
      ],
    });
    expect(out).toMatch(/<!-- wp:yoast\/faq-block \{.*"questions".*\} -->/);
    expect(out).toContain('"id":"faq-question-1"');
    expect(out).toContain('"id":"faq-question-2"');
    expect(out).toContain('id="faq-question-1"');
    expect(out).toContain('id="faq-question-2"');
  });

  it("escapes HTML in title when prepending H1 block", () => {
    const out = buildContentBlocks({ title: "Loans & <Mortgages>", contentHtml: "<p>x</p>" });
    expect(out).toContain("Loans &amp; &lt;Mortgages&gt;");
  });

  it("sections appear in correct order: H1 block, HTML block, Apply Now, Related Links, FAQ", () => {
    const out = buildContentBlocks({
      title: "T",
      contentHtml: "<p>body</p>",
      relatedLinks: [{ title: "L", url: "https://example.com" }],
      faq: [{ question: "Q?", answerText: "A" }],
    });
    const h1Pos = out.indexOf("<!-- wp:heading");
    const htmlPos = out.indexOf("<!-- wp:html -->");
    const applyPos = out.indexOf("Apply Now");
    const relatedPos = out.indexOf("Related Links");
    const faqPos = out.indexOf("wp:yoast/faq-block");
    expect(h1Pos).toBeLessThan(htmlPos);
    expect(htmlPos).toBeLessThan(applyPos);
    expect(applyPos).toBeLessThan(relatedPos);
    expect(relatedPos).toBeLessThan(faqPos);
  });
});
