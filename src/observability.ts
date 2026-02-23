/**
 * observability.ts
 *
 * KV-backed observability, alerting, and abuse-detection for the Worker.
 *
 * Key structure in BLOG_WORKFLOW_STATE KV namespace:
 *   obs:log:<YYYY-MM-DD>:<uuid>    → structured request/event log  (7-day TTL)
 *   obs:abuse:<ip>                 → per-IP abuse record           (24-hour TTL)
 *   obs:alert:<uuid>               → generated alert record        (30-day TTL)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObsEventType =
  | "request"
  | "error"
  | "auth_failure"
  | "rate_limited"
  | "quota_exceeded"
  | "phase_transition"
  | "abuse_detected"
  | "alert";

export interface ObsEvent {
  id: string;
  type: ObsEventType;
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR" | "ALERT";
  context: string;
  data: unknown;
}

export interface AbuseRecord {
  ip: string;
  authFailures: number;
  rateLimitHits: number;
  firstSeen: string;
  lastSeen: string;
  flagged: boolean;
}

export type AlertType =
  | "workflow_failed"
  | "workflow_stuck"
  | "quota_exceeded"
  | "abuse_detected"
  | "api_error";

export interface Alert {
  id: string;
  type: AlertType;
  severity: "warning" | "critical";
  message: string;
  details: unknown;
  timestamp: string;
  notified: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of auth failures from one IP before flagging as abuse. */
const ABUSE_AUTH_FAIL_THRESHOLD = 10;

/** Number of rate-limit hits from one IP before flagging as abuse. */
const ABUSE_RATE_LIMIT_THRESHOLD = 5;

/** Milliseconds before a still-running workflow is considered stuck (5 min). */
export const STUCK_WORKFLOW_THRESHOLD_MS = 5 * 60 * 1000;

/** TTL in seconds for individual log entries (7 days). */
const LOG_TTL_SECONDS = 7 * 24 * 3600;

/** TTL in seconds for alert entries (30 days). */
const ALERT_TTL_SECONDS = 30 * 24 * 3600;

/** TTL in seconds for per-IP abuse records (24 hours). */
const ABUSE_TTL_SECONDS = 24 * 3600;

// ---------------------------------------------------------------------------
// ObservabilityStore
// ---------------------------------------------------------------------------

/**
 * KV-backed store for structured event logs, abuse records, and alerts.
 * All writes are fire-and-forget in the sense that failures are caught and
 * logged to console only — observability must never break request handling.
 */
export class ObservabilityStore {
  constructor(private readonly kv: KVNamespace) {}

  // ── Logging ───────────────────────────────────────────────────────────────

  /**
   * Persist a structured observability event to KV.
   * Key format: `obs:log:<YYYY-MM-DD>:<uuid>`
   */
  async log(event: Omit<ObsEvent, "id" | "timestamp">): Promise<void> {
    try {
      const id = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const entry: ObsEvent = { id, timestamp, ...event };
      const date = timestamp.slice(0, 10);
      await this.kv.put(`obs:log:${date}:${id}`, JSON.stringify(entry), {
        expirationTtl: LOG_TTL_SECONDS,
      });
    } catch (err) {
      console.error(`[observability] log write failed (type=${event.type} context=${event.context}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Retrieve all log events for the given UTC date (default: today).
   * Returns entries sorted by timestamp ascending.
   */
  async getLogs(date?: string): Promise<ObsEvent[]> {
    const d = date ?? new Date().toISOString().slice(0, 10);
    const { keys } = await this.kv.list({ prefix: `obs:log:${d}:` });
    const raws = await Promise.all(keys.map((key) => this.kv.get(key.name)));
    const events: ObsEvent[] = [];
    for (const raw of raws) {
      if (raw) {
        try {
          events.push(JSON.parse(raw) as ObsEvent);
        } catch {
          // skip malformed entries
        }
      }
    }
    return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // ── Abuse detection ───────────────────────────────────────────────────────

  /**
   * Record an authentication failure for `ip`.
   * Returns the updated abuse record and whether the IP was newly flagged.
   */
  async trackAuthFailure(ip: string): Promise<AbuseRecord> {
    return this._updateAbuseRecord(ip, (r) => {
      r.authFailures++;
    });
  }

  /**
   * Record a rate-limit violation for `ip`.
   * Returns the updated abuse record.
   */
  async trackRateLimit(ip: string): Promise<AbuseRecord> {
    return this._updateAbuseRecord(ip, (r) => {
      r.rateLimitHits++;
    });
  }

  /** Retrieve the abuse record for `ip`, or `null` if none exists. */
  async getAbuseRecord(ip: string): Promise<AbuseRecord | null> {
    const raw = await this.kv.get(`obs:abuse:${ip}`);
    return raw ? (JSON.parse(raw) as AbuseRecord) : null;
  }

  private async _updateAbuseRecord(
    ip: string,
    updater: (r: AbuseRecord) => void,
  ): Promise<AbuseRecord> {
    const now = new Date().toISOString();
    const existing = await this.getAbuseRecord(ip);
    const record: AbuseRecord = existing ?? {
      ip,
      authFailures: 0,
      rateLimitHits: 0,
      firstSeen: now,
      lastSeen: now,
      flagged: false,
    };
    updater(record);
    record.lastSeen = now;
    record.flagged =
      record.authFailures >= ABUSE_AUTH_FAIL_THRESHOLD ||
      record.rateLimitHits >= ABUSE_RATE_LIMIT_THRESHOLD;
    await this.kv.put(`obs:abuse:${ip}`, JSON.stringify(record), {
      expirationTtl: ABUSE_TTL_SECONDS,
    });
    return record;
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  /**
   * Create and persist an alert record.
   * Key format: `obs:alert:<uuid>`
   */
  async createAlert(
    alert: Omit<Alert, "id" | "timestamp" | "notified">,
  ): Promise<Alert> {
    const id = crypto.randomUUID();
    const entry: Alert = {
      id,
      timestamp: new Date().toISOString(),
      notified: false,
      ...alert,
    };
    await this.kv.put(`obs:alert:${id}`, JSON.stringify(entry), {
      expirationTtl: ALERT_TTL_SECONDS,
    });
    return entry;
  }

  /** Retrieve all stored alerts, newest first. */
  async getAlerts(): Promise<Alert[]> {
    const { keys } = await this.kv.list({ prefix: "obs:alert:" });
    const raws = await Promise.all(keys.map((key) => this.kv.get(key.name)));
    const alerts: Alert[] = [];
    for (const raw of raws) {
      if (raw) {
        try {
          alerts.push(JSON.parse(raw) as Alert);
        } catch {
          // skip malformed entries
        }
      }
    }
    return alerts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** Mark an alert record as notified (webhook delivery confirmed). */
  async markAlertNotified(alertId: string): Promise<void> {
    const raw = await this.kv.get(`obs:alert:${alertId}`);
    if (!raw) return;
    const alert = JSON.parse(raw) as Alert;
    alert.notified = true;
    await this.kv.put(`obs:alert:${alertId}`, JSON.stringify(alert), {
      expirationTtl: ALERT_TTL_SECONDS,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the entry is still in `running` status and has not been
 * updated within `thresholdMs` milliseconds (default: 5 minutes).
 */
export function isWorkflowStuck(
  entry: { status: string; updatedAt: string },
  thresholdMs = STUCK_WORKFLOW_THRESHOLD_MS,
): boolean {
  if (entry.status !== "running") return false;
  return Date.now() - new Date(entry.updatedAt).getTime() > thresholdMs;
}

/**
 * POST an alert payload to an external webhook URL.
 * Failures are swallowed and logged to console — webhook delivery must never
 * propagate errors back into request handling.
 */
export async function sendWebhookAlert(
  webhookUrl: string,
  alert: Alert,
): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        details: alert.details,
        timestamp: alert.timestamp,
        alertId: alert.id,
      }),
    });
  } catch (err) {
    console.error(
      `[observability] webhook notification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
