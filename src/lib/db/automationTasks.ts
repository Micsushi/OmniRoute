import { createHash, randomUUID } from "node:crypto";

import { getDbInstance } from "./core";

export type AutomationTaskStatus =
  "queued" | "leased" | "cancelling" | "completed" | "failed" | "cancelled";

export type AutomationTask = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  policy: Record<string, unknown>;
  priority: number;
  status: AutomationTaskStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  deadlineAt: string | null;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseStartedAt: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
  result: unknown;
  error: string | null;
  traceId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AutomationTaskEvent = {
  sequence: number;
  taskId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
};

type TaskRow = {
  id: string;
  owner_id: string;
  idempotency_key: string | null;
  request_hash: string;
  kind: string;
  payload: string;
  policy: string;
  priority: number;
  status: AutomationTaskStatus;
  attempt: number;
  max_attempts: number;
  available_at: string;
  deadline_at: string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_started_at: string | null;
  lease_expires_at: string | null;
  cancel_requested_at: string | null;
  result: string | null;
  error: string | null;
  trace_id: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function nowIso(value?: string): string {
  const timestamp = Date.parse(value ?? new Date().toISOString());
  if (!Number.isFinite(timestamp)) throw new Error("now must be a valid ISO timestamp");
  return new Date(timestamp).toISOString();
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapTask(row: TaskRow): AutomationTask {
  return {
    id: row.id,
    kind: row.kind,
    priority: row.priority,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    deadlineAt: row.deadline_at,
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseStartedAt: row.lease_started_at,
    leaseExpiresAt: row.lease_expires_at,
    cancelRequestedAt: row.cancel_requested_at,
    traceId: row.trace_id,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    payload: (parseJson(row.payload) ?? {}) as Record<string, unknown>,
    policy: (parseJson(row.policy) ?? {}) as Record<string, unknown>,
    result: parseJson(row.result),
  };
}

function event(taskId: string, type: string, data: Record<string, unknown>, now: string): void {
  getDbInstance()
    .prepare(
      "INSERT INTO automation_task_events (task_id, type, data, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(taskId, type, JSON.stringify(data), now);
}

export function hashAutomationTaskRequest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function createAutomationTask(input: {
  ownerId: string;
  idempotencyKey?: string | null;
  requestHash: string;
  kind: string;
  payload: Record<string, unknown>;
  policy: Record<string, unknown>;
  priority: number;
  availableAt?: string;
  deadlineAt?: string;
  maxAttempts: number;
  now?: string;
}): { task: AutomationTask; reused: boolean; conflict: boolean } {
  const db = getDbInstance();
  const now = nowIso(input.now);
  let result: { task: AutomationTask; reused: boolean; conflict: boolean } | undefined;
  db.immediate(() => {
    if (input.idempotencyKey) {
      const existing = db
        .prepare("SELECT * FROM automation_tasks WHERE owner_id = ? AND idempotency_key = ?")
        .get(input.ownerId, input.idempotencyKey) as TaskRow | undefined;
      if (existing) {
        result = {
          task: mapTask(existing),
          reused: existing.request_hash === input.requestHash,
          conflict: existing.request_hash !== input.requestHash,
        };
        return;
      }
    }
    const id = `task_${randomUUID()}`;
    const traceId = `trace_${randomUUID()}`;
    db.prepare(
      `INSERT INTO automation_tasks (
         id, owner_id, idempotency_key, request_hash, kind, payload, policy, priority,
         status, attempt, max_attempts, available_at, deadline_at, trace_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.ownerId,
      input.idempotencyKey ?? null,
      input.requestHash,
      input.kind,
      JSON.stringify(input.payload),
      JSON.stringify(input.policy),
      input.priority,
      input.maxAttempts,
      nowIso(input.availableAt ?? now),
      input.deadlineAt ? nowIso(input.deadlineAt) : null,
      traceId,
      now,
      now
    );
    event(id, "submitted", { traceId }, now);
    result = {
      task: mapTask(db.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(id) as TaskRow),
      reused: false,
      conflict: false,
    };
  });
  if (!result) throw new Error("automation task transaction produced no result");
  return result;
}

export function getAutomationTask(ownerId: string, id: string): AutomationTask | null {
  const row = getDbInstance()
    .prepare("SELECT * FROM automation_tasks WHERE owner_id = ? AND id = ?")
    .get(ownerId, id) as TaskRow | undefined;
  return row ? mapTask(row) : null;
}

export function listAutomationTasks(
  ownerId: string,
  input: { status?: AutomationTaskStatus; limit?: number; after?: string } = {}
): AutomationTask[] {
  const conditions = ["owner_id = ?"];
  const params: unknown[] = [ownerId];
  if (input.status) {
    conditions.push("status = ?");
    params.push(input.status);
  }
  if (input.after) {
    conditions.push(
      "(created_at, id) < (SELECT created_at, id FROM automation_tasks WHERE owner_id = ? AND id = ?)"
    );
    params.push(ownerId, input.after);
  }
  params.push(Math.max(1, Math.min(201, input.limit ?? 50)));
  const rows = getDbInstance()
    .prepare(
      `SELECT * FROM automation_tasks WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(...params) as TaskRow[];
  return rows.map(mapTask);
}

function recoverExpired(ownerId: string, now: string): void {
  const db = getDbInstance();
  const rows = db
    .prepare(
      `SELECT * FROM automation_tasks
       WHERE owner_id = ? AND status IN ('leased', 'cancelling') AND lease_expires_at <= ?`
    )
    .all(ownerId, now) as TaskRow[];
  for (const row of rows) {
    const cancelled = row.status === "cancelling" || row.cancel_requested_at !== null;
    const exhausted = row.attempt >= row.max_attempts;
    const status: AutomationTaskStatus = cancelled ? "cancelled" : exhausted ? "failed" : "queued";
    db.prepare(
      `UPDATE automation_tasks SET status = ?, lease_owner = NULL, lease_token = NULL,
       lease_expires_at = NULL, updated_at = ?, completed_at = ?, error = ? WHERE id = ?`
    ).run(
      status,
      now,
      status === "queued" ? null : now,
      exhausted ? "lease expired after final attempt" : row.error,
      row.id
    );
    event(row.id, cancelled ? "cancelled" : exhausted ? "failed" : "lease_expired", {}, now);
  }
  const overdue = db
    .prepare(
      `SELECT id FROM automation_tasks WHERE owner_id = ? AND status = 'queued'
       AND deadline_at IS NOT NULL AND deadline_at <= ?`
    )
    .all(ownerId, now) as Array<{ id: string }>;
  for (const row of overdue) {
    db.prepare(
      "UPDATE automation_tasks SET status = 'failed', error = ?, updated_at = ?, completed_at = ? WHERE id = ?"
    ).run("task deadline elapsed", now, now, row.id);
    event(row.id, "deadline_elapsed", {}, now);
  }
}

export function claimAutomationTask(input: {
  ownerId: string;
  workerId: string;
  kinds?: string[];
  leaseMs: number;
  now?: string;
}): AutomationTask | null {
  const db = getDbInstance();
  const now = nowIso(input.now);
  let claimed: AutomationTask | null = null;
  db.immediate(() => {
    recoverExpired(input.ownerId, now);
    const conditions = ["owner_id = ?", "status = 'queued'", "available_at <= ?"];
    const params: unknown[] = [input.ownerId, now];
    if (input.kinds?.length) {
      conditions.push(`kind IN (${input.kinds.map(() => "?").join(", ")})`);
      params.push(...input.kinds);
    }
    const row = db
      .prepare(
        `SELECT * FROM automation_tasks WHERE ${conditions.join(" AND ")}
         ORDER BY priority DESC, created_at ASC LIMIT 1`
      )
      .get(...params) as TaskRow | undefined;
    if (!row) return;
    const token = randomUUID();
    const expiresAt = leaseExpiry(row, now, input.leaseMs, now);
    const changed = db
      .prepare(
        `UPDATE automation_tasks SET status = 'leased', attempt = attempt + 1,
         lease_owner = ?, lease_token = ?, lease_expires_at = ?, lease_started_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued'`
      )
      .run(input.workerId, token, expiresAt, now, now, row.id).changes;
    if (changed !== 1) return;
    event(row.id, "leased", { workerId: input.workerId, attempt: row.attempt + 1 }, now);
    claimed = mapTask(
      db.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(row.id) as TaskRow
    );
  });
  return claimed;
}

function leaseExpiry(row: TaskRow, now: string, leaseMs: number, startedAt: string): string {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new TypeError("Invalid lease duration");
  const policy = parseJson(row.policy) as Record<string, unknown> | null;
  const runtime =
    typeof policy?.maxRuntimeMs === "number" && policy.maxRuntimeMs > 0
      ? Math.min(policy.maxRuntimeMs, 86_400_000)
      : 900_000;
  return new Date(
    Math.min(
      Date.parse(now) + leaseMs,
      Date.parse(startedAt) + runtime,
      row.deadline_at ? Date.parse(row.deadline_at) : Infinity
    )
  ).toISOString();
}

function withLease(input: {
  ownerId: string;
  id: string;
  leaseToken: string;
  now: string;
}): { db: ReturnType<typeof getDbInstance>; row: TaskRow } | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT * FROM automation_tasks WHERE owner_id = ? AND id = ?")
    .get(input.ownerId, input.id) as TaskRow | undefined;
  if (
    !row ||
    !["leased", "cancelling"].includes(row.status) ||
    row.lease_token !== input.leaseToken ||
    !row.lease_expires_at ||
    row.lease_expires_at <= input.now
  ) {
    return null;
  }
  return { db, row };
}

export function heartbeatAutomationTask(input: {
  ownerId: string;
  id: string;
  leaseToken: string;
  leaseMs: number;
  now?: string;
}): { task: AutomationTask; cancelRequested: boolean } | null {
  const now = nowIso(input.now);
  let result: { task: AutomationTask; cancelRequested: boolean } | null = null;
  getDbInstance().immediate(() => {
    const leased = withLease({ ...input, now });
    if (!leased) return;
    const cancelRequested = leased.row.status === "cancelling";
    if (!cancelRequested) {
      const expiresAt = leaseExpiry(leased.row, now, input.leaseMs, leased.row.lease_started_at!);
      leased.db
        .prepare("UPDATE automation_tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?")
        .run(expiresAt, now, input.id);
      event(input.id, "heartbeat", {}, now);
    }
    result = {
      task: mapTask(
        leased.db.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(input.id) as TaskRow
      ),
      cancelRequested,
    };
  });
  return result;
}

export function settleAutomationTask(input: {
  ownerId: string;
  id: string;
  leaseToken: string;
  outcome: "complete" | "fail";
  result?: unknown;
  error?: string;
  retry?: boolean;
  retryDelayMs?: number;
  now?: string;
}): AutomationTask | null {
  const now = nowIso(input.now);
  let result: AutomationTask | null = null;
  getDbInstance().immediate(() => {
    const leased = withLease({ ...input, now });
    if (!leased) return;
    const cancellation = leased.row.status === "cancelling";
    const retry =
      !cancellation &&
      input.outcome === "fail" &&
      input.retry !== false &&
      leased.row.attempt < leased.row.max_attempts;
    const status: AutomationTaskStatus = cancellation
      ? "cancelled"
      : input.outcome === "complete"
        ? "completed"
        : retry
          ? "queued"
          : "failed";
    const availableAt = retry
      ? new Date(Date.parse(now) + (input.retryDelayMs ?? 0)).toISOString()
      : leased.row.available_at;
    leased.db
      .prepare(
        `UPDATE automation_tasks SET status = ?, result = ?, error = ?, available_at = ?,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         updated_at = ?, completed_at = ? WHERE id = ?`
      )
      .run(
        status,
        !cancellation && input.outcome === "complete" ? JSON.stringify(input.result ?? null) : null,
        !cancellation && input.outcome === "fail" ? "worker reported task failure" : null,
        availableAt,
        now,
        retry ? null : now,
        input.id
      );
    event(input.id, cancellation ? "cancelled" : retry ? "retry_scheduled" : status, {}, now);
    result = mapTask(
      leased.db.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(input.id) as TaskRow
    );
  });
  return result;
}

export function cancelAutomationTask(
  ownerId: string,
  id: string,
  nowValue?: string
): AutomationTask | null {
  const db = getDbInstance();
  const now = nowIso(nowValue);
  let result: AutomationTask | null = null;
  db.immediate(() => {
    const row = db
      .prepare("SELECT * FROM automation_tasks WHERE owner_id = ? AND id = ?")
      .get(ownerId, id) as TaskRow | undefined;
    if (!row) return;
    if (["completed", "failed", "cancelled"].includes(row.status)) {
      result = mapTask(row);
      return;
    }
    const status = row.status === "queued" ? "cancelled" : "cancelling";
    db.prepare(
      `UPDATE automation_tasks SET status = ?, cancel_requested_at = ?, updated_at = ?,
       completed_at = ? WHERE id = ?`
    ).run(status, now, now, status === "cancelled" ? now : null, id);
    event(id, status === "cancelled" ? "cancelled" : "cancellation_requested", {}, now);
    result = mapTask(db.prepare("SELECT * FROM automation_tasks WHERE id = ?").get(id) as TaskRow);
  });
  return result;
}

export function listAutomationTaskEvents(
  ownerId: string,
  id: string,
  afterSequence = 0,
  limit = 500
): AutomationTaskEvent[] | null {
  const db = getDbInstance();
  const task = db
    .prepare("SELECT id FROM automation_tasks WHERE owner_id = ? AND id = ?")
    .get(ownerId, id);
  if (!task) return null;
  const rows = db
    .prepare(
      "SELECT * FROM automation_task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence LIMIT ?"
    )
    .all(id, afterSequence, Math.max(1, Math.min(501, limit))) as Array<{
    sequence: number;
    task_id: string;
    type: string;
    data: string;
    created_at: string;
  }>;
  return rows.map((row) => ({
    sequence: row.sequence,
    taskId: row.task_id,
    type: row.type,
    data: (parseJson(row.data) ?? {}) as Record<string, unknown>,
    createdAt: row.created_at,
  }));
}
