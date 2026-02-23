import { describe, it, expect, beforeEach } from "vitest";
import {
  ObservabilityStore,
  isWorkflowStuck,
  STUCK_WORKFLOW_THRESHOLD_MS,
  type ObsEvent,
  type AbuseRecord,
  type Alert,
} from "../src/observability";

// ---------------------------------------------------------------------------
// Minimal in-memory KVNamespace mock (mirrors pattern in other test files)
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

// ---------------------------------------------------------------------------
// ObservabilityStore - logging
// ---------------------------------------------------------------------------

describe("ObservabilityStore - logging", () => {
  let obs: ObservabilityStore;

  beforeEach(() => {
    obs = new ObservabilityStore(createMockKV());
  });

  it("log persists a structured event that can be retrieved by getLogs", async () => {
    await obs.log({ type: "request", level: "INFO", context: "test", data: { method: "GET" } });
    const logs = await obs.getLogs();
    expect(logs).toHaveLength(1);
    const entry = logs[0] as ObsEvent;
    expect(entry.type).toBe("request");
    expect(entry.level).toBe("INFO");
    expect(entry.context).toBe("test");
    expect(entry.id).toBeTruthy();
    expect(entry.timestamp).toBeTruthy();
  });

  it("getLogs returns entries sorted by timestamp ascending", async () => {
    await obs.log({ type: "request", level: "INFO", context: "a", data: null });
    await new Promise((r) => setTimeout(r, 2));
    await obs.log({ type: "error", level: "ERROR", context: "b", data: null });
    const logs = await obs.getLogs();
    expect(logs).toHaveLength(2);
    expect(logs[0].context).toBe("a");
    expect(logs[1].context).toBe("b");
  });

  it("getLogs returns an empty array when no events have been logged", async () => {
    const logs = await obs.getLogs();
    expect(logs).toEqual([]);
  });

  it("getLogs filters by date and does not return events from other dates", async () => {
    // Log an event on a real date; querying a different date should return nothing
    await obs.log({ type: "request", level: "INFO", context: "today", data: null });
    const logs = await obs.getLogs("1970-01-01");
    expect(logs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ObservabilityStore - abuse detection
// ---------------------------------------------------------------------------

describe("ObservabilityStore - abuse detection", () => {
  let obs: ObservabilityStore;

  beforeEach(() => {
    obs = new ObservabilityStore(createMockKV());
  });

  it("trackAuthFailure initializes a record for a new IP", async () => {
    const record = await obs.trackAuthFailure("1.2.3.4");
    expect(record.ip).toBe("1.2.3.4");
    expect(record.authFailures).toBe(1);
    expect(record.rateLimitHits).toBe(0);
    expect(record.flagged).toBe(false);
  });

  it("trackAuthFailure accumulates across multiple calls", async () => {
    for (let i = 0; i < 5; i++) await obs.trackAuthFailure("1.2.3.4");
    const record = await obs.getAbuseRecord("1.2.3.4") as AbuseRecord;
    expect(record.authFailures).toBe(5);
  });

  it("trackAuthFailure flags the IP once the threshold (10) is reached", async () => {
    let record: AbuseRecord = { ip: "", authFailures: 0, rateLimitHits: 0, firstSeen: "", lastSeen: "", flagged: false };
    for (let i = 0; i < 10; i++) record = await obs.trackAuthFailure("2.2.2.2");
    expect(record.flagged).toBe(true);
  });

  it("trackRateLimit initializes a record and accumulates", async () => {
    let record = await obs.trackRateLimit("3.3.3.3");
    expect(record.rateLimitHits).toBe(1);
    record = await obs.trackRateLimit("3.3.3.3");
    expect(record.rateLimitHits).toBe(2);
  });

  it("trackRateLimit flags the IP once the threshold (5) is reached", async () => {
    let record: AbuseRecord = { ip: "", authFailures: 0, rateLimitHits: 0, firstSeen: "", lastSeen: "", flagged: false };
    for (let i = 0; i < 5; i++) record = await obs.trackRateLimit("4.4.4.4");
    expect(record.flagged).toBe(true);
  });

  it("getAbuseRecord returns null for an unknown IP", async () => {
    const record = await obs.getAbuseRecord("9.9.9.9");
    expect(record).toBeNull();
  });

  it("getAbuseRecord returns the persisted record after tracking", async () => {
    await obs.trackAuthFailure("5.5.5.5");
    const record = await obs.getAbuseRecord("5.5.5.5") as AbuseRecord;
    expect(record).not.toBeNull();
    expect(record.authFailures).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ObservabilityStore - alerts
// ---------------------------------------------------------------------------

describe("ObservabilityStore - alerts", () => {
  let obs: ObservabilityStore;

  beforeEach(() => {
    obs = new ObservabilityStore(createMockKV());
  });

  it("createAlert persists an alert with generated id, timestamp, and notified=false", async () => {
    const alert = await obs.createAlert({
      type: "workflow_failed",
      severity: "critical",
      message: "Phase research failed",
      details: { workflowId: "wf_1" },
    });
    expect(alert.id).toBeTruthy();
    expect(alert.timestamp).toBeTruthy();
    expect(alert.notified).toBe(false);
    expect(alert.type).toBe("workflow_failed");
    expect(alert.severity).toBe("critical");
  });

  it("getAlerts retrieves all stored alerts", async () => {
    await obs.createAlert({ type: "workflow_failed", severity: "critical", message: "A", details: null });
    await obs.createAlert({ type: "api_error", severity: "warning", message: "B", details: null });
    const alerts = await obs.getAlerts();
    expect(alerts).toHaveLength(2);
  });

  it("getAlerts returns an empty array when there are no alerts", async () => {
    const alerts = await obs.getAlerts();
    expect(alerts).toEqual([]);
  });

  it("getAlerts returns alerts newest-first", async () => {
    await obs.createAlert({ type: "workflow_failed", severity: "critical", message: "first", details: null });
    await new Promise((r) => setTimeout(r, 2));
    await obs.createAlert({ type: "api_error", severity: "warning", message: "second", details: null });
    const alerts = await obs.getAlerts() as Alert[];
    expect(alerts[0].message).toBe("second");
    expect(alerts[1].message).toBe("first");
  });

  it("markAlertNotified sets notified to true on the stored record", async () => {
    const alert = await obs.createAlert({
      type: "quota_exceeded",
      severity: "warning",
      message: "Quota exceeded",
      details: {},
    });
    await obs.markAlertNotified(alert.id);
    const all = await obs.getAlerts() as Alert[];
    const found = all.find((a) => a.id === alert.id);
    expect(found?.notified).toBe(true);
  });

  it("markAlertNotified is a no-op for an unknown alertId", async () => {
    // Should not throw
    await obs.markAlertNotified("nonexistent-id");
  });
});

// ---------------------------------------------------------------------------
// isWorkflowStuck
// ---------------------------------------------------------------------------

describe("isWorkflowStuck", () => {
  it("returns false for a completed workflow regardless of age", () => {
    const old = new Date(Date.now() - STUCK_WORKFLOW_THRESHOLD_MS * 2).toISOString();
    expect(isWorkflowStuck({ status: "completed", updatedAt: old })).toBe(false);
  });

  it("returns false for a failed workflow regardless of age", () => {
    const old = new Date(Date.now() - STUCK_WORKFLOW_THRESHOLD_MS * 2).toISOString();
    expect(isWorkflowStuck({ status: "failed", updatedAt: old })).toBe(false);
  });

  it("returns false for a running workflow updated recently", () => {
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    expect(isWorkflowStuck({ status: "running", updatedAt: recent })).toBe(false);
  });

  it("returns true for a running workflow not updated within the threshold", () => {
    const stale = new Date(Date.now() - STUCK_WORKFLOW_THRESHOLD_MS - 1000).toISOString();
    expect(isWorkflowStuck({ status: "running", updatedAt: stale })).toBe(true);
  });

  it("respects a custom threshold", () => {
    const updatedAt = new Date(Date.now() - 2000).toISOString(); // 2 seconds ago
    expect(isWorkflowStuck({ status: "running", updatedAt }, 1000)).toBe(true);
    expect(isWorkflowStuck({ status: "running", updatedAt }, 10_000)).toBe(false);
  });
});
