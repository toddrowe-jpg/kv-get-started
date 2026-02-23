import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (opts?: { prefix?: string }) => {
      const prefix = opts?.prefix ?? "";
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name, expiration: undefined, metadata: null }));
      return { keys, list_complete: true, cursor: "", cacheStatus: null };
    },
    getWithMetadata: async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

function buildEnv(kv: KVNamespace): Env {
  return {
    AI: { run: vi.fn().mockResolvedValue({}) },
    GEMINI_API_KEY: "test-key",
    BLOG_WORKFLOW_STATE: kv,
  };
}

function makeGeminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** Canonical mock research output used across multiple tests. */
const MOCK_RESEARCH_JSON = JSON.stringify({
  topic: "SBA Loans",
  summary: "Overview of SBA loans",
  keyPoints: ["point1"],
  suggestedHeadings: ["Intro"],
  sources: ["SBA.gov"],
});

function postExecute(body: Record<string, unknown>, env: Env): Promise<Response> {
  return worker.fetch(
    new Request("https://worker.example/workflow/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /workflow/execute", () => {
  const originalFetch = globalThis.fetch;
  let kv: KVNamespace;
  let env: Env;

  beforeEach(() => {
    kv = createMockKV();
    env = buildEnv(kv);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns 405 for GET requests", async () => {
    const res = await worker.fetch(
      new Request("https://worker.example/workflow/execute"),
      env,
    );
    expect(res.status).toBe(405);
  });

  it("returns 400 when topic is missing", async () => {
    const res = await postExecute({}, env);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/topic/);
  });

  it("returns 400 when topic exceeds 500 characters", async () => {
    const res = await postExecute({ topic: "x".repeat(501) }, env);
    expect(res.status).toBe(400);
  });

  it("returns 503 when GEMINI_API_KEY is not configured", async () => {
    const noKeyEnv: Env = { ...env, GEMINI_API_KEY: "" };
    const res = await postExecute({ topic: "test" }, noKeyEnv);
    expect(res.status).toBe(503);
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await worker.fetch(
      new Request("https://worker.example/workflow/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("chains all three phases and returns completed workflow state on success", async () => {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 1) return Promise.resolve(makeGeminiResponse(MOCK_RESEARCH_JSON));
      if (callIndex === 2) return Promise.resolve(makeGeminiResponse("## Outline\n1. Intro"));
      return Promise.resolve(makeGeminiResponse("# Blog Post\n\nContent here."));
    });

    const res = await postExecute(
      { topic: "SBA Loans", audience: "small business owners" },
      env,
    );
    expect(res.status).toBe(200);

    const body = await res.json() as { workflowId: string; state: Record<string, unknown> };
    expect(body.workflowId).toMatch(/^wf_/);
    expect(body.state).toBeTruthy();
    expect(body.state.status).toBe("completed");
    expect(body.state.phaseOutputs).toHaveProperty("research");
    expect(body.state.phaseOutputs).toHaveProperty("outline");
    expect(body.state.phaseOutputs).toHaveProperty("draft");
  });

  it("persists workflow state in KV so it can be retrieved by GET /workflow/:id", async () => {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 1) return Promise.resolve(makeGeminiResponse(MOCK_RESEARCH_JSON));
      if (callIndex === 2) return Promise.resolve(makeGeminiResponse("## Outline"));
      return Promise.resolve(makeGeminiResponse("# Draft"));
    });

    const execRes = await postExecute({ topic: "SBA" }, env);
    const { workflowId } = await execRes.json() as { workflowId: string };

    // Retrieve workflow via GET
    const getRes = await worker.fetch(
      new Request(`https://worker.example/workflow/${workflowId}`),
      env,
    );
    expect(getRes.status).toBe(200);
    const state = await getRes.json() as { status: string; traceLogs: unknown[] };
    expect(state.status).toBe("completed");
    expect(state.traceLogs).toBeDefined();
  });

  it("logs phase_started and phase_completed events for all three phases", async () => {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 1) return Promise.resolve(makeGeminiResponse(MOCK_RESEARCH_JSON));
      if (callIndex === 2) return Promise.resolve(makeGeminiResponse("## Outline"));
      return Promise.resolve(makeGeminiResponse("# Draft"));
    });

    const res = await postExecute({ topic: "SBA" }, env);
    const { state } = await res.json() as { state: { traceLogs: Array<{ phase: string; event: string }> } };

    const phases = ["research", "outline", "draft"];
    for (const phase of phases) {
      expect(state.traceLogs.some((l) => l.phase === phase && l.event === "phase_started")).toBe(true);
      expect(state.traceLogs.some((l) => l.phase === phase && l.event === "phase_completed")).toBe(true);
    }
  });

  it("marks workflow as failed and skips later phases when research fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: 500, status: "INTERNAL", message: "Server error" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );

    const res = await postExecute({ topic: "SBA" }, env);
    expect(res.status).toBe(200);

    const body = await res.json() as { state: { status: string; phaseOutputs: Record<string, unknown> } };
    expect(body.state.status).toBe("failed");
    expect(body.state.phaseOutputs).not.toHaveProperty("outline");
    expect(body.state.phaseOutputs).not.toHaveProperty("draft");
  });

  it("uses default brief field values when optional fields are omitted", async () => {
    let callIndex = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callIndex += 1;
      if (callIndex === 1) return Promise.resolve(makeGeminiResponse(MOCK_RESEARCH_JSON));
      if (callIndex === 2) return Promise.resolve(makeGeminiResponse("## Outline"));
      return Promise.resolve(makeGeminiResponse("# Draft"));
    });

    // Only topic is provided; defaults should fill in the rest
    const res = await postExecute({ topic: "SBA" }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { state: { status: string } };
    expect(body.state.status).toBe("completed");
  });
});
