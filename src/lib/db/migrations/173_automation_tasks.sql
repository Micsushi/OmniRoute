CREATE TABLE IF NOT EXISTS automation_tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  idempotency_key TEXT,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  policy TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'leased', 'cancelling', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  available_at TEXT NOT NULL,
  deadline_at TEXT,
  lease_owner TEXT,
  lease_token TEXT,
  lease_started_at TEXT,
  lease_expires_at TEXT,
  cancel_requested_at TEXT,
  result TEXT,
  error TEXT,
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_tasks_idempotency
  ON automation_tasks(owner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_tasks_claim
  ON automation_tasks(owner_id, status, available_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_tasks_trace
  ON automation_tasks(trace_id);

CREATE TABLE IF NOT EXISTS automation_task_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES automation_tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_automation_task_events_task
  ON automation_task_events(task_id, sequence);
