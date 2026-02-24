/**
 * workflowStore.ts
 *
 * KV-backed persistence layer for blog workflow executions.
 * Stores workflow state, phase outputs, error details, and structured trace logs
 * so that completed and failed runs are inspectable after the fact.
 */

export interface TraceEvent {
  timestamp: string;
  phase: string;
  event: string;
  details?: unknown;
}

export interface WorkflowError {
  phase: string;
  message: string;
  timestamp: string;
}

export interface WorkflowEntry {
  id: string;
  status: "running" | "completed" | "failed";
  currentPhase: string;
  phaseOutputs: Record<string, unknown>;
  errors: WorkflowError[];
  traceLogs: TraceEvent[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Wraps a Cloudflare KV namespace to persist blog workflow state.
 * Each workflow is stored under the key `workflow:<id>`.
 */
export class WorkflowStore {
  constructor(private readonly kv: KVNamespace) {}

  /** Create and persist a new workflow entry, returning it. */
  async create(id: string, initialPhase: string): Promise<WorkflowEntry> {
    const now = new Date().toISOString();
    const entry: WorkflowEntry = {
      id,
      status: "running",
      currentPhase: initialPhase,
      phaseOutputs: {},
      errors: [],
      traceLogs: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.kv.put(`workflow:${id}`, JSON.stringify(entry));
    return entry;
  }

  /** Retrieve a workflow entry by ID, or null if not found. */
  async get(id: string): Promise<WorkflowEntry | null> {
    const raw = await this.kv.get(`workflow:${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as WorkflowEntry;
  }

  private async update(
    id: string,
    updater: (entry: WorkflowEntry) => void,
  ): Promise<WorkflowEntry | null> {
    const entry = await this.get(id);
    if (!entry) return null;
    updater(entry);
    entry.updatedAt = new Date().toISOString();
    await this.kv.put(`workflow:${id}`, JSON.stringify(entry));
    return entry;
  }

  /** Append a structured trace event to the workflow's log. */
  async addLog(
    id: string,
    phase: string,
    event: string,
    details?: unknown,
  ): Promise<void> {
    await this.update(id, (entry) => {
      entry.traceLogs.push({
        timestamp: new Date().toISOString(),
        phase,
        event,
        details,
      });
    });
  }

  /** Record the output of a completed phase and advance the current phase. */
  async setPhaseOutput(
    id: string,
    phase: string,
    output: unknown,
  ): Promise<void> {
    await this.update(id, (entry) => {
      entry.phaseOutputs[phase] = output;
      entry.currentPhase = phase;
    });
  }

  /** Record an error for a phase and mark the workflow as failed. */
  async setError(
    id: string,
    phase: string,
    message: string,
  ): Promise<void> {
    await this.update(id, (entry) => {
      entry.errors.push({
        phase,
        message,
        timestamp: new Date().toISOString(),
      });
      entry.status = "failed";
    });
  }

  /** Mark the workflow as successfully completed. */
  async complete(id: string): Promise<void> {
    await this.update(id, (entry) => {
      entry.status = "completed";
    });
  }

  /**
   * List all workflow entries stored in KV.
   * Returns entries sorted by createdAt descending (newest first).
   */
  async list(): Promise<WorkflowEntry[]> {
    const { keys } = await this.kv.list({ prefix: "workflow:" });
    const raws = await Promise.all(keys.map((key) => this.kv.get(key.name)));
    const entries: WorkflowEntry[] = [];
    for (const raw of raws) {
      if (raw) {
        try {
          entries.push(JSON.parse(raw) as WorkflowEntry);
        } catch {
          // skip malformed entries
        }
      }
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
