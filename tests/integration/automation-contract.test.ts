import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniRouteClient } from "../../packages/sdk/src/index.js";

const directory = mkdtempSync(join(tmpdir(), "omniroute-contract-"));
process.env.DATA_DIR = directory;
process.env.API_KEY_SECRET = randomBytes(32).toString("hex");
const core = await import("../../src/lib/db/core.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const collection = await import("../../src/app/api/v1/tasks/route.ts");
const claim = await import("../../src/app/api/v1/tasks/claim/route.ts");
const item = await import("../../src/app/api/v1/tasks/[id]/route.ts");
const events = await import("../../src/app/api/v1/tasks/[id]/events/route.ts");
const capabilities = await import("../../src/app/api/v1/capabilities/route.ts");
const shared = await import("../../src/app/api/v1/tasks/_shared.ts");

test.after(() => {
  core.resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test("real SDK -> HTTP -> authenticated routes -> SQLite lifecycle", async () => {
  const key = await keys.createApiKey("contract-test", "test-machine");
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const url = new URL(incoming.url!, "http://127.0.0.1");
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        body: incoming.method === "POST" ? Buffer.concat(chunks) : undefined,
      });
      let response: Response;
      const id = url.pathname.split("/")[3];
      const context = { params: Promise.resolve({ id }) };
      if (url.pathname === "/v1/capabilities") response = await capabilities.GET();
      else if (url.pathname === "/v1/tasks/claim") response = await claim.POST(request);
      else if (url.pathname === "/v1/tasks")
        response =
          incoming.method === "POST"
            ? await collection.POST(request)
            : await collection.GET(request);
      else if (url.pathname.endsWith("/events")) response = await events.GET(request, context);
      else
        response =
          incoming.method === "POST"
            ? await item.POST(request, context)
            : await item.GET(request, context);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new OmniRouteClient({ baseUrl, apiKey: key.key });
    assert.equal((await client.capabilities()).contractVersion, "1.0.0");
    const input = { kind: "offline.test", payload: { a: 1, b: 2 } };
    const created = await client.createTask(input, { idempotencyKey: "same-request" });
    assert.equal(created.data.policy?.filesystem, "none");
    const replayed = await client.createTask(
      { ...input, payload: { b: 2, a: 1 } },
      { idempotencyKey: "same-request" }
    );
    assert.equal(replayed.reused, true);
    assert.equal(replayed.data.id, created.data.id);
    await assert.rejects(
      client.createTask({ ...input, payload: { a: 3 } }, { idempotencyKey: "same-request" }),
      { status: 409 }
    );
    const leased = await client.claimTask({
      workerId: "integration-worker",
      kinds: ["offline.test"],
    });
    assert.equal(leased?.data.id, created.data.id);
    assert.equal(await client.claimTask({ workerId: "other-worker" }), null);
    await client.heartbeatTask(created.data.id, leased!.data.leaseToken!);
    await client.completeTask(created.data.id, leased!.data.leaseToken!, { ok: true });
    assert.equal((await client.getTask(created.data.id)).data.status, "completed");
    assert.deepEqual(
      (await client.taskEvents(created.data.id)).data.map((event) => event.type),
      ["submitted", "leased", "heartbeat", "completed"]
    );
    core.resetDbInstance();
    assert.deepEqual((await client.getTask(created.data.id)).data.result, { ok: true });
    const otherKey = await keys.createApiKey("other-test", "other-machine");
    await assert.rejects(
      new OmniRouteClient({ baseUrl, apiKey: otherKey.key }).getTask(created.data.id),
      { status: 404 }
    );
    await assert.rejects(new OmniRouteClient({ baseUrl }).listTasks(), { status: 401 });
    await assert.rejects(client.createTask({ kind: "test", payload: { apiKey: "synthetic" } }), {
      status: 400,
    });
    await assert.rejects(
      client.createTask({ kind: "test", payload: { text: "x".repeat(262_144) } }),
      { status: 413 }
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("unexpected task errors never expose internal paths or stack", async () => {
  const response = await shared.safeTaskHandler(async () => {
    throw new Error("secret at /private/source.ts:12");
  })();
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.equal(body.includes("secret"), false);
  assert.equal(body.includes("at /"), false);
});
