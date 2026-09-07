import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OmniRouteClient, OmniRouteError } from "../../packages/sdk/src/index.js";

test("rejects credential-bearing or ambiguous gateway URLs", () => {
  for (const baseUrl of [
    "ftp://localhost",
    "http://user:pass@localhost",
    "http://localhost?key=x",
    "http://localhost#key",
  ]) {
    assert.throws(() => new OmniRouteClient({ baseUrl }), TypeError);
  }
});
test("normalizes v1 suffix, sends auth, refuses redirects", async () => {
  const client = new OmniRouteClient({
    baseUrl: "http://localhost/gateway/v1/",
    apiKey: "test-key",
    fetch: async (url, options) => {
      assert.equal(url, "http://localhost/gateway/v1/models");
      assert.equal(options.headers.get("authorization"), "Bearer test-key");
      assert.equal(options.redirect, "error");
      return Response.json({ data: [] });
    },
  });
  assert.deepEqual(await client.models(), { data: [] });
  assert.equal(JSON.stringify(client).includes("test-key"), false);
});
test("errors have status, code and request ID without automatic retries", async () => {
  let calls = 0;
  const client = new OmniRouteClient({
    fetch: async () => {
      calls++;
      return Response.json(
        { error: { message: "Budget exceeded", code: "budget_exceeded" } },
        { status: 429, headers: { "x-request-id": "request-1" } }
      );
    },
  });
  await assert.rejects(
    client.models(),
    (error) =>
      error instanceof OmniRouteError &&
      error.status === 429 &&
      error.code === "budget_exceeded" &&
      error.requestId === "request-1"
  );
  assert.equal(calls, 1);
});
test("streaming preserves tool-call SSE bytes", async () => {
  const sse =
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\\"x\\\":"}}]}}]}\n\ndata: [DONE]\n\n';
  const client = new OmniRouteClient({ fetch: async () => new Response(sse) });
  const stream = await client.chatCompletions({ model: "local/fixed", messages: [], stream: true });
  assert.equal(await new Response(stream).text(), sse);
});
test("raw request path cannot override the gateway authority", async () => {
  const client = new OmniRouteClient({
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  for (const path of ["//evil.invalid", "https://evil.invalid", "/../private", "/v1/../private"]) {
    await assert.rejects(client.request(path), TypeError);
  }
});

test("CLI streams exact bytes over real HTTP and errors never echo provider content", async () => {
  const sse = 'data: {"choices":[]}\n\ndata: [DONE]\n\n';
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer synthetic-key");
    req.resume();
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200);
      res.end(sse);
    } else {
      res.writeHead(500);
      res.end("synthetic-private-provider-content");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  async function cli(command, body) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../../packages/sdk/src/cli.js", import.meta.url)), command],
      {
        env: {
          ...process.env,
          OMNIROUTE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
          OMNIROUTE_API_KEY: "synthetic-key",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.stdin.end(body);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { stdout, stderr, code };
  }
  try {
    assert.deepEqual(
      await cli("chat", JSON.stringify({ model: "fixed", messages: [], stream: true })),
      { stdout: sse, stderr: "", code: 0 }
    );
    const failed = await cli("models");
    assert.equal(failed.code, 1);
    assert.equal(failed.stderr.includes("synthetic"), false);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
