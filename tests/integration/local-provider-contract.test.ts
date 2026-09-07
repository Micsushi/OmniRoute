import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "omniroute-local-provider-"));
process.env.DATA_DIR = directory;
process.env.NODE_ENV = "test";
process.env.OMNIROUTE_PLUGINS_DIR = join(directory, "plugins");
process.env.API_KEY_SECRET = randomBytes(32).toString("hex");
process.env.APP_LOG_TO_FILE = "false";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const keys = await import("../../src/lib/db/apiKeys.ts");
const chat = await import("../../src/app/api/v1/chat/completions/route.ts");
const originalFetch = globalThis.fetch;
test.after(async () => {
  globalThis.fetch = originalFetch;
  const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
  await closeCallLogSaves();
});
// Chat completion schedules deferred telemetry after its response closes. Remove
// this process's database only once those callbacks can no longer recreate it.
process.once("exit", () => {
  core.resetDbInstance();
  rmSync(directory, { recursive: true, force: true });
});

test(
  "real chat route routes JSON and streamed tool deltas to a loopback mock provider",
  { timeout: 30_000 },
  async () => {
    const calls: string[] = [];
    const formats: unknown[] = [];
    const responseFormat = {
      type: "json_schema",
      json_schema: {
        name: "contract",
        strict: true,
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
    };
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      calls.push(req.url!);
      if (req.url?.endsWith("/models")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "qwen2.5:0.5b-instruct" }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.response_format) formats.push(body.response_format);
      const base = { id: "mock-1", model: body.model, created: 1 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "inspect", arguments: '{"value":1}' } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`
        );
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"ok":true}' },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          })
        );
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(url.origin, baseUrl, "Offline integration must not contact external providers");
      return originalFetch(input, options);
    };
    try {
      await providers.createProviderConnection({
        provider: "ollama-local",
        authType: "apikey",
        name: "isolated mock",
        apiKey: "synthetic-upstream",
        isActive: true,
        testStatus: "active",
        providerSpecificData: { baseUrl: `${baseUrl}/v1` },
      });
      const key = await keys.createApiKey("isolated-client", "test-machine");
      for (const stream of [false, true]) {
        const response = await chat.POST(
          new Request("http://127.0.0.1/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
            body: JSON.stringify({
              model: "ollama-local/qwen2.5:0.5b-instruct",
              messages: [{ role: "user", content: "Public synthetic test" }],
              stream,
              ...(!stream ? { response_format: responseFormat } : {}),
            }),
          })
        );
        assert.equal(response.status, 200, await response.clone().text());
        if (stream) {
          const body = await response.text();
          assert.ok(body.includes("call-1"));
          assert.ok(body.includes("[DONE]"));
        } else
          assert.deepEqual(JSON.parse((await response.json()).choices[0].message.content), {
            ok: true,
          });
      }
      assert.ok(calls.some((path) => path.endsWith("/chat/completions")));
      assert.deepEqual(formats, [responseFormat]);
    } finally {
      globalThis.fetch = originalFetch;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);
