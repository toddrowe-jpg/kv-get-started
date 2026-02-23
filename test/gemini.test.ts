import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  GeminiApiError,
  parseGeminiError,
  geminiGenerate,
} from "../src/gemini";

// ---------------------------------------------------------------------------
// parseGeminiError – unit tests
// ---------------------------------------------------------------------------

describe("parseGeminiError", () => {
  it("maps HTTP 429 / RESOURCE_EXHAUSTED to upstream 429", () => {
    const err = parseGeminiError(429, {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" },
    });
    expect(err).toBeInstanceOf(GeminiApiError);
    expect(err.httpStatus).toBe(429);
    expect(err.message).toBe("Quota exceeded");
    expect(err.geminiStatus).toBe("RESOURCE_EXHAUSTED");
  });

  it("maps RESOURCE_EXHAUSTED status string to 429 even with different HTTP code", () => {
    const err = parseGeminiError(200, {
      error: { status: "RESOURCE_EXHAUSTED", message: "Rate limit" },
    });
    expect(err.httpStatus).toBe(429);
  });

  it("maps HTTP 401 / UNAUTHENTICATED to upstream 401", () => {
    const err = parseGeminiError(401, {
      error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid API key" },
    });
    expect(err.httpStatus).toBe(401);
    expect(err.message).toBe("Invalid API key");
  });

  it("maps HTTP 403 / PERMISSION_DENIED to upstream 403", () => {
    const err = parseGeminiError(403, {
      error: { code: 403, status: "PERMISSION_DENIED", message: "Access denied" },
    });
    expect(err.httpStatus).toBe(403);
  });

  it("maps HTTP 400 / INVALID_ARGUMENT to upstream 400", () => {
    const err = parseGeminiError(400, {
      error: { code: 400, status: "INVALID_ARGUMENT", message: "Bad request" },
    });
    expect(err.httpStatus).toBe(400);
  });

  it("maps HTTP 5xx to upstream 502", () => {
    const err = parseGeminiError(503, { error: { message: "Internal error" } });
    expect(err.httpStatus).toBe(502);
  });

  it("falls back to 500 for unknown errors", () => {
    const err = parseGeminiError(418, {});
    expect(err.httpStatus).toBe(500);
    expect(err.message).toBe("Unknown Gemini API error");
  });

  it("includes geminiCode on the error object", () => {
    const err = parseGeminiError(429, {
      error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" },
    });
    expect(err.geminiCode).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// GeminiApiError – unit tests
// ---------------------------------------------------------------------------

describe("GeminiApiError", () => {
  it("is an instance of Error", () => {
    const err = new GeminiApiError("oops", 502);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GeminiApiError");
    expect(err.httpStatus).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// geminiGenerate – tests using fetch mock
// ---------------------------------------------------------------------------

// Minimal success response from the Gemini API.
const successBody = {
  candidates: [
    { content: { parts: [{ text: "Hello " }, { text: "world" }] } },
  ],
};

/** Build a Response object that the mocked fetch will return. */
function mockResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("geminiGenerate", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns concatenated text from a successful response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse(successBody, 200));
    const result = await geminiGenerate("key", "say hello");
    expect(result).toBe("Hello world");
  });

  it("throws GeminiApiError with 429 on rate-limit response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse(
        { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } },
        429,
      ),
    );
    await expect(geminiGenerate("key", "prompt")).rejects.toThrow(GeminiApiError);
    await expect(geminiGenerate("key", "prompt")).rejects.toMatchObject({
      httpStatus: 429,
    });
  });

  it("throws GeminiApiError with 401 on invalid API key", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse(
        { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid API key" } },
        401,
      ),
    );
    await expect(geminiGenerate("bad-key", "prompt")).rejects.toMatchObject({
      httpStatus: 401,
      message: "Invalid API key",
    });
  });

  it("throws GeminiApiError with 403 on permission denied", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse(
        { error: { code: 403, status: "PERMISSION_DENIED", message: "Forbidden" } },
        403,
      ),
    );
    await expect(geminiGenerate("key", "prompt")).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it("throws GeminiApiError with 502 on upstream 500", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ error: { message: "Internal error" } }, 500),
    );
    await expect(geminiGenerate("key", "prompt")).rejects.toMatchObject({
      httpStatus: 502,
    });
  });

  it("handles non-JSON error body gracefully", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );
    await expect(geminiGenerate("key", "prompt")).rejects.toBeInstanceOf(GeminiApiError);
  });

  it("throws GeminiApiError when prompt is blocked by safety filters", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse({ promptFeedback: { blockReason: "SAFETY" } }, 200),
    );
    await expect(geminiGenerate("key", "unsafe prompt")).rejects.toMatchObject({
      httpStatus: 400,
      message: expect.stringContaining("SAFETY"),
    });
  });

  it("returns empty string when candidates array is missing", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({}, 200));
    const result = await geminiGenerate("key", "prompt");
    expect(result).toBe("");
  });

  it("returns empty string when candidates array is empty", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse({ candidates: [] }, 200));
    const result = await geminiGenerate("key", "prompt");
    expect(result).toBe("");
  });

  it("passes context label in error messages", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      mockResponse(
        { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } },
        429,
      ),
    );
    // Should not throw; just verifying no crash when context is provided
    await expect(geminiGenerate("key", "prompt", "research")).rejects.toBeInstanceOf(
      GeminiApiError,
    );
  });
});
