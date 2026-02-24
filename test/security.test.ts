import { describe, it, expect, beforeEach } from "vitest";
import {
  InputValidator,
  AuthenticationMiddleware,
  RateLimiter,
  InputSizeLimiter,
  OutputSanitizer,
  SecurityLogger,
} from "../src/security";
import {
  rateLimitMiddleware,
  inputValidationMiddleware,
  corsMiddleware,
  securityHeadersMiddleware,
  sanitizeOutput,
  setupMiddlewareChain,
  checkAdminAccess,
  checkCfAccessJwt,
} from "../src/middleware";

// ---------------------------------------------------------------------------
// InputValidator
// ---------------------------------------------------------------------------
describe("InputValidator", () => {
  const v = new InputValidator();

  it("returns false for null", () => expect(v.validate(null)).toBe(false));
  it("returns false for undefined", () => expect(v.validate(undefined)).toBe(false));
  it("returns false for empty string", () => expect(v.validate("")).toBe(false));
  it("returns false for whitespace-only string", () => expect(v.validate("   ")).toBe(false));
  it("returns true for a non-empty string", () => expect(v.validate("hello")).toBe(true));
  it("returns true for a non-null object", () => expect(v.validate({ a: 1 })).toBe(true));
});

// ---------------------------------------------------------------------------
// AuthenticationMiddleware
// ---------------------------------------------------------------------------
describe("AuthenticationMiddleware", () => {
  it("allows all requests when no API keys are configured (open mode)", () => {
    const auth = new AuthenticationMiddleware([]);
    const req = new Request("https://example.com/");
    expect(auth.validateApiKey(req)).toBe(true);
  });

  it("rejects a request with no Authorization header when keys are configured", () => {
    const auth = new AuthenticationMiddleware(["secret123"]);
    const req = new Request("https://example.com/");
    expect(auth.validateApiKey(req)).toBe(false);
  });

  it("rejects a request with a wrong token", () => {
    const auth = new AuthenticationMiddleware(["secret123"]);
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer wrongtoken" },
    });
    expect(auth.validateApiKey(req)).toBe(false);
  });

  it("accepts a request with the correct Bearer token", () => {
    const auth = new AuthenticationMiddleware(["secret123"]);
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(auth.validateApiKey(req)).toBe(true);
  });

  it("trims blank keys from the list (they are not valid)", () => {
    const auth = new AuthenticationMiddleware(["", "  ", "validkey"]);
    const req = new Request("https://example.com/", {
      headers: { Authorization: "Bearer   " },
    });
    expect(auth.validateApiKey(req)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------
describe("RateLimiter", () => {
  it("allows requests within the limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.checkLimit("1.2.3.4").allowed).toBe(true);
    expect(limiter.checkLimit("1.2.3.4").allowed).toBe(true);
    expect(limiter.checkLimit("1.2.3.4").allowed).toBe(true);
  });

  it("blocks requests that exceed the limit", () => {
    const limiter = new RateLimiter(2, 60_000);
    limiter.checkLimit("5.5.5.5");
    limiter.checkLimit("5.5.5.5");
    const result = limiter.checkLimit("5.5.5.5");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("tracks IPs independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    limiter.checkLimit("10.0.0.1");
    expect(limiter.checkLimit("10.0.0.1").allowed).toBe(false);
    expect(limiter.checkLimit("10.0.0.2").allowed).toBe(true);
  });

  it("decrements remaining count correctly", () => {
    const limiter = new RateLimiter(5, 60_000);
    const first = limiter.checkLimit("9.9.9.9");
    expect(first.remaining).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// InputSizeLimiter
// ---------------------------------------------------------------------------
describe("InputSizeLimiter", () => {
  it("allows payloads within the limit", () => {
    const limiter = new InputSizeLimiter(1000);
    expect(limiter.check(500)).toBe(true);
    expect(limiter.check(1000)).toBe(true);
  });

  it("blocks payloads that exceed the limit", () => {
    const limiter = new InputSizeLimiter(1000);
    expect(limiter.check(1001)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OutputSanitizer
// ---------------------------------------------------------------------------
describe("OutputSanitizer", () => {
  const sanitizer = new OutputSanitizer();

  it("passes through non-sensitive fields unchanged", () => {
    const result = sanitizer.sanitize({ topic: "loans", summary: "overview" });
    expect(result).toEqual({ topic: "loans", summary: "overview" });
  });

  it("redacts api_key fields", () => {
    const result = sanitizer.sanitize({ api_key: "super-secret" }) as Record<string, unknown>;
    expect(result["api_key"]).toBe("[REDACTED]");
  });

  it("redacts password fields", () => {
    const result = sanitizer.sanitize({ password: "hunter2" }) as Record<string, unknown>;
    expect(result["password"]).toBe("[REDACTED]");
  });

  it("redacts secret fields", () => {
    const result = sanitizer.sanitize({ secret: "shhh" }) as Record<string, unknown>;
    expect(result["secret"]).toBe("[REDACTED]");
  });

  it("redacts nested sensitive fields", () => {
    const result = sanitizer.sanitize({ nested: { api_key: "leak" } }) as Record<string, unknown>;
    expect((result["nested"] as Record<string, unknown>)["api_key"]).toBe("[REDACTED]");
  });

  it("handles arrays", () => {
    const result = sanitizer.sanitize([{ api_key: "x" }, { topic: "y" }]) as Record<string, unknown>[];
    expect(result[0]["api_key"]).toBe("[REDACTED]");
    expect(result[1]["topic"]).toBe("y");
  });

  it("passes through null and primitives unchanged", () => {
    expect(sanitizer.sanitize(null)).toBeNull();
    expect(sanitizer.sanitize("hello")).toBe("hello");
    expect(sanitizer.sanitize(42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// SecurityLogger — smoke test (just ensure it doesn't throw)
// ---------------------------------------------------------------------------
describe("SecurityLogger", () => {
  it("static log does not throw", () => {
    expect(() => SecurityLogger.log("INFO", "test", { key: "value" })).not.toThrow();
  });

  it("static error does not throw", () => {
    expect(() => SecurityLogger.error("test", "something went wrong")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Middleware functions
// ---------------------------------------------------------------------------
describe("rateLimitMiddleware", () => {
  it("returns true for a first request from a new IP", async () => {
    const uniqueIp = `192.168.${Date.now() % 255}.${(Date.now() >> 8) % 255}`;
    const req = new Request("https://example.com/", {
      headers: { "CF-Connecting-IP": uniqueIp },
    });
    const ctx = { authenticated: false, clientIp: uniqueIp, timestamp: "", requestId: "r1", rateLimited: false };
    const result = await rateLimitMiddleware(req, ctx);
    expect(result).toBe(true);
    expect(ctx.rateLimited).toBe(false);
  });
});

describe("inputValidationMiddleware", () => {
  it("returns true when Content-Length is within limit", async () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { "Content-Length": "500" },
      body: "x",
    });
    const ctx = { authenticated: false, clientIp: "1.1.1.1", timestamp: "", requestId: "r2", rateLimited: false };
    const result = await inputValidationMiddleware(req, ctx);
    expect(result).toBe(true);
  });

  it("returns false when Content-Length exceeds 1 MB", async () => {
    const req = new Request("https://example.com/", {
      method: "POST",
      headers: { "Content-Length": "1000001" },
    });
    const ctx = { authenticated: false, clientIp: "1.1.1.1", timestamp: "", requestId: "r3", rateLimited: false };
    const result = await inputValidationMiddleware(req, ctx);
    expect(result).toBe(false);
  });

  it("returns true when no Content-Length header is present", async () => {
    const req = new Request("https://example.com/");
    const ctx = { authenticated: false, clientIp: "1.1.1.1", timestamp: "", requestId: "r4", rateLimited: false };
    const result = await inputValidationMiddleware(req, ctx);
    expect(result).toBe(true);
  });
});

describe("corsMiddleware", () => {
  it("returns null for non-OPTIONS requests", () => {
    const req = new Request("https://example.com/", { method: "GET" });
    expect(corsMiddleware(req)).toBeNull();
  });

  it("returns a 200 response for OPTIONS requests with CORS headers", () => {
    const req = new Request("https://example.com/", { method: "OPTIONS" });
    const res = corsMiddleware(req);
    expect(res).not.toBeNull();
    expect(res!.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res!.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});

describe("securityHeadersMiddleware", () => {
  it("adds security headers to the response", () => {
    const inner = new Response(JSON.stringify({ ok: true }), { status: 200 });
    const secured = securityHeadersMiddleware(inner);
    expect(secured.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(secured.headers.get("X-Frame-Options")).toBe("DENY");
    expect(secured.headers.get("Strict-Transport-Security")).toContain("max-age=");
    expect(secured.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("preserves the original status code", () => {
    const inner = new Response("", { status: 404 });
    const secured = securityHeadersMiddleware(inner);
    expect(secured.status).toBe(404);
  });
});

describe("sanitizeOutput", () => {
  it("redacts api_key in output", () => {
    const result = sanitizeOutput({ data: "ok", api_key: "leak" }) as Record<string, unknown>;
    expect(result["api_key"]).toBe("[REDACTED]");
    expect(result["data"]).toBe("ok");
  });
});

describe("setupMiddlewareChain", () => {
  it("returns a MiddlewareChain instance", () => {
    const chain = setupMiddlewareChain();
    expect(chain).toBeTruthy();
    expect(typeof chain.execute).toBe("function");
  });

  it("allows requests when no API key is configured (open mode)", async () => {
    const chain = setupMiddlewareChain(undefined);
    const uniqueIp = `172.16.100.${(Date.now() % 200) + 1}`;
    const req = new Request("https://example.com/test", {
      headers: { "CF-Connecting-IP": uniqueIp },
    });
    const { allowed } = await chain.execute(req);
    expect(allowed).toBe(true);
  });

  it("rejects requests without a Bearer token when an API key is configured", async () => {
    const chain = setupMiddlewareChain("my-secret-key");
    const uniqueIp = `172.17.100.${(Date.now() % 200) + 1}`;
    const req = new Request("https://example.com/test", {
      headers: { "CF-Connecting-IP": uniqueIp },
    });
    const { allowed, context } = await chain.execute(req);
    expect(allowed).toBe(false);
    expect(context.authenticated).toBe(false);
  });

  it("allows requests with the correct Bearer token when an API key is configured", async () => {
    const chain = setupMiddlewareChain("my-secret-key");
    const uniqueIp = `172.18.100.${(Date.now() % 200) + 1}`;
    const req = new Request("https://example.com/test", {
      headers: {
        Authorization: "Bearer my-secret-key",
        "CF-Connecting-IP": uniqueIp,
      },
    });
    const { allowed, context } = await chain.execute(req);
    expect(allowed).toBe(true);
    expect(context.authenticated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkAdminAccess
// ---------------------------------------------------------------------------
describe("checkAdminAccess", () => {
  it("returns true when no admin key is configured (no-op)", () => {
    const req = new Request("https://example.com/admin/logs");
    expect(checkAdminAccess(req, undefined)).toBe(true);
  });

  it("returns false when admin key is configured and no Authorization header is present", () => {
    const req = new Request("https://example.com/admin/logs");
    expect(checkAdminAccess(req, "admin-secret")).toBe(false);
  });

  it("returns false when the Bearer token does not match the admin key", () => {
    const req = new Request("https://example.com/admin/logs", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(checkAdminAccess(req, "admin-secret")).toBe(false);
  });

  it("returns false when the regular API_KEY is presented instead of ADMIN_API_KEY", () => {
    const req = new Request("https://example.com/admin/logs", {
      headers: { Authorization: "Bearer regular-api-key" },
    });
    expect(checkAdminAccess(req, "admin-secret")).toBe(false);
  });

  it("returns true when the correct admin Bearer token is presented", () => {
    const req = new Request("https://example.com/admin/logs", {
      headers: { Authorization: "Bearer admin-secret" },
    });
    expect(checkAdminAccess(req, "admin-secret")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkCfAccessJwt
// ---------------------------------------------------------------------------
describe("checkCfAccessJwt", () => {
  it("returns true when no CF_ACCESS_AUD is configured (no-op)", async () => {
    const req = new Request("https://example.com/admin/logs");
    expect(await checkCfAccessJwt(req, undefined)).toBe(true);
  });

  it("returns false when CF_ACCESS_AUD is configured and the assertion header is absent", async () => {
    const req = new Request("https://example.com/admin/logs");
    expect(await checkCfAccessJwt(req, "my-aud-tag")).toBe(false);
  });

  it("returns false when the assertion header is present but empty", async () => {
    const req = new Request("https://example.com/admin/logs", {
      headers: { "Cf-Access-Jwt-Assertion": "   " },
    });
    expect(await checkCfAccessJwt(req, "my-aud-tag")).toBe(false);
  });

  it("returns false when the JWT payload has a mismatched audience claim", async () => {
    // JWT with aud: "other-aud"
    const jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2lkIn0.eyJhdWQiOiJvdGhlci1hdWQiLCJleHAiOjE3NzE4OTUxMzB9.ZmFrZS1zaWc";
    const req = new Request("https://example.com/admin/logs", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    expect(await checkCfAccessJwt(req, "my-aud-tag")).toBe(false);
  });

  it("returns false when the JWT token is expired", async () => {
    // JWT with exp: 1000000000 (year 2001, long expired)
    const jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2lkIn0.eyJhdWQiOiJteS1hdWQtdGFnIiwiZXhwIjoxMDAwMDAwMDAwfQ.ZmFrZS1zaWc";
    const req = new Request("https://example.com/admin/logs", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    expect(await checkCfAccessJwt(req, "my-aud-tag")).toBe(false);
  });

  it("returns false when the JWT is malformed (not three parts)", async () => {
    const req = new Request("https://example.com/admin/logs", {
      headers: { "Cf-Access-Jwt-Assertion": "not.a.valid.jwt.at.all" },
    });
    expect(await checkCfAccessJwt(req, "my-aud-tag")).toBe(false);
  });

  it("returns true when the JWT has the correct audience claim (string)", async () => {
    // JWT with aud: "my-aud-tag", exp: far future
    const jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2lkIn0.eyJhdWQiOiJteS1hdWQtdGFnIiwiZXhwIjoxNzcxODk1MTMwLCJpc3MiOiJ0ZXN0In0.ZmFrZS1zaWc";
    const req = new Request("https://example.com/admin/logs", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    expect(await checkCfAccessJwt(req, "my-aud-tag")).toBe(true);
  });

  it("returns true when the JWT audience is an array that includes the configured AUD", async () => {
    // JWT with aud: ["my-aud-tag", "other"], exp: far future
    const jwt = "eyJhbGciOiJSUzI1NiIsImtpZCI6InRlc3Qta2lkIn0.eyJhdWQiOlsibXktYXVkLXRhZyIsIm90aGVyIl0sImV4cCI6MTc3MTg5NTEzMH0.ZmFrZS1zaWc";
    const req = new Request("https://example.com/admin/logs", {
      headers: { "Cf-Access-Jwt-Assertion": jwt },
    });
    expect(await checkCfAccessJwt(req, "my-aud-tag")).toBe(true);
  });
});
