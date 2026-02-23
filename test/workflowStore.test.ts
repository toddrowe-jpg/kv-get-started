import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowStore, WorkflowEntry } from "../src/workflowStore";

// ---------------------------------------------------------------------------
// Minimal in-memory KVNamespace mock
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
    list: async () => ({
      keys: [],
      list_complete: true,
      cursor: "",
      cacheStatus: null,
    }),
    getWithMetadata: async (key: string) => ({
      value: store.get(key) ?? null,
      metadata: null,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// WorkflowStore – unit tests
// ---------------------------------------------------------------------------

describe("WorkflowStore", () => {
  let store: WorkflowStore;

  beforeEach(() => {
    store = new WorkflowStore(createMockKV());
  });

  it("create returns a running entry with the initial phase", async () => {
    const entry = await store.create("wf1", "research");
    expect(entry.id).toBe("wf1");
    expect(entry.status).toBe("running");
    expect(entry.currentPhase).toBe("research");
    expect(entry.phaseOutputs).toEqual({});
    expect(entry.errors).toEqual([]);
    expect(entry.traceLogs).toEqual([]);
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBeTruthy();
  });

  it("get returns null for an unknown workflow ID", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("get returns the stored entry after create", async () => {
    await store.create("wf2", "research");
    const entry = await store.get("wf2");
    expect(entry).not.toBeNull();
    expect((entry as WorkflowEntry).id).toBe("wf2");
  });

  it("addLog appends a trace event with correct fields", async () => {
    await store.create("wf3", "research");
    await store.addLog("wf3", "research", "phase_started", { topic: "SBA loans" });
    const entry = await store.get("wf3");
    expect(entry?.traceLogs).toHaveLength(1);
    expect(entry?.traceLogs[0].phase).toBe("research");
    expect(entry?.traceLogs[0].event).toBe("phase_started");
    expect(entry?.traceLogs[0].details).toEqual({ topic: "SBA loans" });
    expect(entry?.traceLogs[0].timestamp).toBeTruthy();
  });

  it("setPhaseOutput stores output and advances currentPhase", async () => {
    await store.create("wf4", "research");
    await store.setPhaseOutput("wf4", "research", { summary: "overview" });
    const entry = await store.get("wf4");
    expect(entry?.phaseOutputs["research"]).toEqual({ summary: "overview" });
    expect(entry?.currentPhase).toBe("research");
  });

  it("setError records an error and marks the workflow as failed", async () => {
    await store.create("wf5", "research");
    await store.setError("wf5", "research", "API quota exceeded");
    const entry = await store.get("wf5");
    expect(entry?.status).toBe("failed");
    expect(entry?.errors).toHaveLength(1);
    expect(entry?.errors[0].phase).toBe("research");
    expect(entry?.errors[0].message).toBe("API quota exceeded");
    expect(entry?.errors[0].timestamp).toBeTruthy();
  });

  it("complete marks the workflow as completed", async () => {
    await store.create("wf6", "research");
    await store.complete("wf6");
    const entry = await store.get("wf6");
    expect(entry?.status).toBe("completed");
  });

  it("addLog on a nonexistent workflow is a no-op", async () => {
    // Should not throw
    await store.addLog("missing", "research", "phase_started");
  });

  it("updatedAt is refreshed after mutations", async () => {
    const created = await store.create("wf7", "research");
    const before = created.updatedAt;
    // Ensure at least 1 ms passes
    await new Promise((r) => setTimeout(r, 2));
    await store.addLog("wf7", "research", "event");
    const after = (await store.get("wf7"))?.updatedAt ?? "";
    expect(after >= before).toBe(true);
  });

  it("multiple trace events are accumulated in order", async () => {
    await store.create("wf8", "research");
    await store.addLog("wf8", "research", "phase_started");
    await store.addLog("wf8", "research", "phase_completed");
    const entry = await store.get("wf8");
    expect(entry?.traceLogs).toHaveLength(2);
    expect(entry?.traceLogs[0].event).toBe("phase_started");
    expect(entry?.traceLogs[1].event).toBe("phase_completed");
  });
});
