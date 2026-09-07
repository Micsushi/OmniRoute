import { setTimeout as delay } from "node:timers/promises";

/** Executes one inference task. Never evaluates model output or invokes a tool/shell. */
export async function runChatTaskOnce(client, { workerId, model, signal } = {}) {
  if (!workerId || !model || model === "auto" || model.startsWith("auto/")) {
    throw new TypeError("An explicit workerId and fixed model are required");
  }
  const envelope = await client.claimTask(
    { workerId, kinds: ["chat.completion"], leaseMs: 5000 },
    { signal }
  );
  if (!envelope) return null;
  const task = envelope.data;
  const policy = task.policy ?? {};
  const allowedFields = new Set(["messages", "max_tokens", "temperature"]);
  const payload = task.payload ?? {};
  const unsupported =
    policy.filesystem !== "none" ||
    policy.network !== "none" ||
    policy.commandProfile !== "none" ||
    policy.secretRefs?.length ||
    policy.allowedHosts?.length ||
    !Array.isArray(payload.messages) ||
    Object.keys(payload).some((key) => !allowedFields.has(key));
  if (unsupported) {
    return client.failTask(task.id, task.leaseToken, "unsupported task policy or payload", {
      retry: false,
    });
  }
  const stop = new AbortController();
  const execution = new AbortController();
  const timeout = AbortSignal.timeout(policy.maxRuntimeMs ?? 900_000);
  const combined = AbortSignal.any([execution.signal, timeout, ...(signal ? [signal] : [])]);
  const heartbeat = (async () => {
    while (!stop.signal.aborted) {
      try {
        await delay(1000, undefined, { signal: stop.signal });
        const renewed = await client.heartbeatTask(task.id, task.leaseToken, 5000);
        if (renewed.cancelRequested) {
          execution.abort();
          break;
        }
      } catch {
        if (!stop.signal.aborted) execution.abort();
        break;
      }
    }
  })();
  try {
    const result = await client.chatCompletions(
      { ...payload, model, stream: false },
      { signal: combined, timeoutMs: policy.maxRuntimeMs ?? 900_000 }
    );
    combined.throwIfAborted();
    return await client.completeTask(task.id, task.leaseToken, result);
  } catch {
    // A lost lease must not publish output. If settlement fails, expiry drives recovery.
    return await client.failTask(task.id, task.leaseToken, "inference failed", { retry: false });
  } finally {
    stop.abort();
    await heartbeat;
  }
}
