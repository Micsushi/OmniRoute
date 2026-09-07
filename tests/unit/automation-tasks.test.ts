import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "omniroute-automation-"));
process.env.DATA_DIR = directory;
const core = await import("../../src/lib/db/core.ts");
const tasks = await import("../../src/lib/db/automationTasks.ts");
const now = "2026-09-06T00:00:00.000Z";
const later = (ms: number) => new Date(Date.parse(now) + ms).toISOString();
let owner = 0;
const create = (extra = {}) =>
  tasks.createAutomationTask({
    ownerId: `owner-${owner++}`,
    requestHash: "hash",
    kind: "test",
    payload: {},
    policy: { maxRuntimeMs: 10_000 },
    priority: 0,
    maxAttempts: 2,
    now,
    ...extra,
  }).task;
test.after(() => {
  core.resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("idempotency hashing ignores JSON object key order", () => {
  assert.equal(
    tasks.hashAutomationTaskRequest({ a: 1, b: { c: 2, d: 3 } }),
    tasks.hashAutomationTaskRequest({ b: { d: 3, c: 2 }, a: 1 })
  );
});
test("task projection excludes internal ownership and request fingerprint", () => {
  const task = create();
  for (const key of ["ownerId", "requestHash", "idempotencyKey"]) assert.equal(key in task, false);
});
test("exclusive claim, fencing, bounded runtime and recovery", () => {
  const task = create({ ownerId: "lease-owner" });
  const claim = tasks.claimAutomationTask({
    ownerId: "lease-owner",
    workerId: "first",
    leaseMs: 5000,
    now,
  });
  assert.equal(claim?.id, task.id);
  assert.equal(
    tasks.claimAutomationTask({ ownerId: "lease-owner", workerId: "second", leaseMs: 5000, now }),
    null
  );
  const reclaimed = tasks.claimAutomationTask({
    ownerId: "lease-owner",
    workerId: "second",
    leaseMs: 5000,
    now: later(5000),
  });
  assert.notEqual(reclaimed?.leaseToken, claim?.leaseToken);
  assert.equal(
    tasks.settleAutomationTask({
      ownerId: "lease-owner",
      id: task.id,
      leaseToken: claim!.leaseToken!,
      outcome: "complete",
      now: later(5001),
    }),
    null
  );
  const heartbeat = tasks.heartbeatAutomationTask({
    ownerId: "lease-owner",
    id: task.id,
    leaseToken: reclaimed!.leaseToken!,
    leaseMs: 100_000,
    now: later(6000),
  });
  assert.equal(heartbeat?.task.leaseExpiresAt, later(15000));
  assert.equal(tasks.getAutomationTask("another-owner", task.id), null);
  assert.equal(tasks.listAutomationTaskEvents("another-owner", task.id), null);
});
test("cancellation wins over a late completion and does not retain output", () => {
  const task = create({ ownerId: "cancel-owner" });
  const claimed = tasks.claimAutomationTask({
    ownerId: "cancel-owner",
    workerId: "worker",
    leaseMs: 5000,
    now,
  })!;
  assert.equal(tasks.cancelAutomationTask("cancel-owner", task.id, later(1))?.status, "cancelling");
  const settled = tasks.settleAutomationTask({
    ownerId: "cancel-owner",
    id: task.id,
    leaseToken: claimed.leaseToken!,
    outcome: "complete",
    result: "discard me",
    now: later(2),
  });
  assert.equal(settled?.status, "cancelled");
  assert.equal(settled?.result, null);
});
test("pagination keeps tasks sharing a timestamp", () => {
  for (let i = 0; i < 3; i++) create({ ownerId: "page-owner" });
  const first = tasks.listAutomationTasks("page-owner", { limit: 1 });
  const next = tasks.listAutomationTasks("page-owner", { limit: 2, after: first[0].id });
  assert.equal(next.length, 2);
  assert.equal(new Set([...first, ...next].map((t) => t.id)).size, 3);
});

test("deadlines fence active work and queued deadlines recover without a worker", () => {
  const task = create({ ownerId: "deadline-owner", deadlineAt: later(2000) });
  const claim = tasks.claimAutomationTask({
    ownerId: "deadline-owner",
    workerId: "worker",
    leaseMs: 5000,
    now,
  })!;
  assert.equal(claim.leaseExpiresAt, later(2000));
  assert.equal(
    tasks.settleAutomationTask({
      ownerId: "deadline-owner",
      id: task.id,
      leaseToken: claim.leaseToken!,
      outcome: "complete",
      now: later(2001),
    }),
    null
  );
  assert.equal(
    tasks.claimAutomationTask({
      ownerId: "deadline-owner",
      workerId: "worker",
      leaseMs: 5000,
      now: later(2001),
    }),
    null
  );
  assert.equal(tasks.getAutomationTask("deadline-owner", task.id)?.status, "failed");
});

test("final lease expiry is terminal and event cursors replay without duplicates", () => {
  const task = create({ ownerId: "last-owner", maxAttempts: 1 });
  tasks.claimAutomationTask({ ownerId: "last-owner", workerId: "worker", leaseMs: 5000, now });
  assert.equal(
    tasks.claimAutomationTask({
      ownerId: "last-owner",
      workerId: "worker",
      leaseMs: 5000,
      now: later(5000),
    }),
    null
  );
  assert.equal(tasks.getAutomationTask("last-owner", task.id)?.status, "failed");
  const first = tasks.listAutomationTaskEvents("last-owner", task.id, 0, 1)!;
  const rest = tasks.listAutomationTaskEvents("last-owner", task.id, first[0].sequence)!;
  assert.deepEqual(
    [...first, ...rest].map((event) => event.type),
    ["submitted", "leased", "failed"]
  );
});
