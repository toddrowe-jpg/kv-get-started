import { describe, it, expect } from "vitest";
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

function makeEnv(verifyToken?: string): Env {
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
