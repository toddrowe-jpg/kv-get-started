import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src/index";

// ---------------------------------------------------------------------------
// Minimal mock Env for WhatsApp webhook tests
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, cursor: "", cacheStatus: null }),
    getWithMetadata: async (key: string) => ({ value: store.get(key) ?? null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

function makeEnv(verifyToken?: string, extras: Partial<Env> = {}): Env {
  return {
    GEMINI_API_KEY: "",
    BLOG_WORKFLOW_STATE: createMockKV(),
    USER_NOTIFICATION: createMockKV(),
    API_KEY: "",
    ADMIN_API_KEY: "",
    CF_ACCESS_AUD: "",
    ALERT_WEBHOOK_URL: "",
    WP_SITE_URL: "",
    WP_USER: "",
    WP_APP_PASSWORD: "",
    WHATSAPP_VERIFY_TOKEN: verifyToken,
    AI: { run: async () => ({}) } as Env["AI"],
    ...extras,
  } as unknown as Env;
}

const BASE_URL = "https://worker.example.com";

// ---------------------------------------------------------------------------
// GET /whatsapp/webhook — Meta webhook verification
// ---------------------------------------------------------------------------

describe("GET /whatsapp/webhook - Meta webhook verification", () => {
  it("returns 200 with challenge when mode=subscribe and token matches", async () => {
    const env = makeEnv("my-secret-token");
    const url = `${BASE_URL}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=my-secret-token&hub.challenge=abc123`;
    const req = new Request(url, { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("returns 403 when the verify token does not match", async () => {
    const env = makeEnv("correct-token");
    const url = `${BASE_URL}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=xyz`;
    const req = new Request(url, { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it("returns 403 when hub.verify_token is missing", async () => {
    const env = makeEnv("correct-token");
    const url = `${BASE_URL}/whatsapp/webhook?hub.mode=subscribe&hub.challenge=xyz`;
    const req = new Request(url, { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it("returns 403 when hub.mode is not subscribe", async () => {
    const env = makeEnv("correct-token");
    const url = `${BASE_URL}/whatsapp/webhook?hub.mode=unsubscribe&hub.verify_token=correct-token&hub.challenge=xyz`;
    const req = new Request(url, { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it("returns 403 when WHATSAPP_VERIFY_TOKEN is not configured", async () => {
    const env = makeEnv(undefined);
    const url = `${BASE_URL}/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=&hub.challenge=xyz`;
    const req = new Request(url, { method: "GET" });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /whatsapp/webhook — inbound event acknowledgement
// ---------------------------------------------------------------------------

describe("POST /whatsapp/webhook - inbound event handler", () => {
  it("returns 200 OK for a valid JSON payload", async () => {
    const env = makeEnv("some-token");
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1234" }] });
    const req = new Request(`${BASE_URL}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
  });

  it("returns 200 OK even for a non-JSON body", async () => {
    const env = makeEnv("some-token");
    const req = new Request(`${BASE_URL}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-json",
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// POST /whatsapp/webhook — auto-reply for inbound text messages
// ---------------------------------------------------------------------------

describe("POST /whatsapp/webhook - auto-reply", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls fetch to send auto-reply when a text message is received", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const env = makeEnv("some-token", {
      WHATSAPP_ACCESS_TOKEN: "test-access-token",
      WHATSAPP_PHONE_NUMBER_ID: "12345678",
    });

    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "entry-1",
        changes: [{
          field: "messages",
          value: {
            messages: [{
              id: "wamid.test",
              from: "1234567890",
              timestamp: "1700000000",
              type: "text",
              text: { body: "Hello there" },
            }],
          },
        }],
      }],
    };

    const req = new Request(`${BASE_URL}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);

    // Give the fire-and-forget fetch a tick to run.
    await new Promise(r => setTimeout(r, 10));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v21.0/12345678/messages");
    expect(init.headers).toMatchObject({ "Authorization": "Bearer test-access-token" });
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.to).toBe("1234567890");
    expect(sentBody.text.body).toBe("Received: Hello there");
  });

  it("does not call fetch for auto-reply when access token is missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));

    const env = makeEnv("some-token"); // no WHATSAPP_ACCESS_TOKEN

    const payload = {
      object: "whatsapp_business_account",
      entry: [{
        id: "entry-1",
        changes: [{
          field: "messages",
          value: {
            messages: [{ id: "wamid.test", from: "1234567890", timestamp: "1700000000", type: "text", text: { body: "Hi" } }],
          },
        }],
      }],
    };

    const req = new Request(`${BASE_URL}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /whatsapp/webhook — signature verification
// ---------------------------------------------------------------------------

/** Compute HMAC-SHA256 hex digest of `body` using `secret`. */
async function hmacSha256Hex(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

describe("POST /whatsapp/webhook - signature verification", () => {
  it("returns 200 when a valid X-Hub-Signature-256 is provided", async () => {
    const secret = "my-app-secret";
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1" }] });
    const sig = `sha256=${await hmacSha256Hex(body, secret)}`;

    const env = makeEnv("some-token", { WHATSAPP_APP_SECRET: secret });
    const req = new Request(`${BASE_URL}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig },
      body,
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
  });

  it("returns 403 when X-Hub-Signature-256 header is missing and secret is configured", async () => {
    const env = makeEnv("some-token", { WHATSAPP_APP_SECRET: "my-app-secret" });
    const req = new Request(`${BASE_URL}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object: "whatsapp_business_account" }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it("returns 403 when X-Hub-Signature-256 is invalid", async () => {
    const env = makeEnv("some-token", { WHATSAPP_APP_SECRET: "my-app-secret" });
    const req = new Request(`${BASE_URL}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=badhash" },
      body: JSON.stringify({ object: "whatsapp_business_account" }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(403);
  });

  it("skips signature check and returns 200 when WHATSAPP_APP_SECRET is not set", async () => {
    const env = makeEnv("some-token"); // no WHATSAPP_APP_SECRET
    const req = new Request(`${BASE_URL}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ object: "whatsapp_business_account" }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
  });
});
