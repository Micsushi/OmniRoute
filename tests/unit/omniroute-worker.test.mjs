import test from "node:test";
import assert from "node:assert/strict";
import { runChatTaskOnce } from "../../packages/sdk/src/worker.js";

function fakeClient(extra = {}) {
  const calls = [];
  return {
    calls,
    claimTask: async () => ({
      data: {
        id: "task-1",
        leaseToken: "token",
        payload: { messages: [] },
        policy: {
          filesystem: "none",
          network: "none",
          commandProfile: "none",
          secretRefs: [],
          allowedHosts: [],
          maxRuntimeMs: 5000,
        },
        ...extra,
      },
    }),
    chatCompletions: async (body) => {
      calls.push(body);
      return { choices: [] };
    },
    heartbeatTask: async () => ({ cancelRequested: false }),
    completeTask: async (_id, _token, result) => ({ result }),
    failTask: async (_id, _token, _error, options) => ({ failed: true, ...options }),
  };
}
test("worker fixes model and never executes returned content", async () => {
  const client = fakeClient();
  assert.deepEqual(
    await runChatTaskOnce(client, { workerId: "worker", model: "ollama-local/fixed" }),
    { result: { choices: [] } }
  );
  assert.equal(client.calls[0].model, "ollama-local/fixed");
  assert.equal(client.calls[0].stream, false);
});
test("worker fails closed on unsupported authority and routing overrides", async () => {
  for (const extra of [
    { policy: { filesystem: "workspace-write" } },
    { payload: { messages: [], model: "paid" } },
    { payload: { messages: [], tools: [{}] } },
  ]) {
    const client = fakeClient(extra);
    assert.equal(
      (await runChatTaskOnce(client, { workerId: "worker", model: "local/fixed" })).failed,
      true
    );
    assert.equal(client.calls.length, 0);
  }
  await assert.rejects(
    runChatTaskOnce(fakeClient(), { workerId: "worker", model: "auto" }),
    TypeError
  );
});
test("heartbeat cancellation aborts inference and never completes", async () => {
  const client = fakeClient();
  client.heartbeatTask = async () => ({ cancelRequested: true });
  client.chatCompletions = async (_body, { signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    );
  client.completeTask = async () => assert.fail("cancelled work must not complete");
  assert.equal(
    (await runChatTaskOnce(client, { workerId: "worker", model: "local/fixed" })).failed,
    true
  );
});
