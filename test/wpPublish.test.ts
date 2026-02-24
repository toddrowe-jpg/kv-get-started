import { describe, it, expect } from "vitest";
import {
  buildBasicAuthHeader,
  wpPublishPost,
  WpPublishError,
  resolveTermIds,
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
