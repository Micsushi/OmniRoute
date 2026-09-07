#!/usr/bin/env node
import { OmniRouteClient, OmniRouteError } from "./index.js";

const [command, id, ...extra] = process.argv.slice(2);
const usage =
  "omniroute-client health|models|capabilities|chat|responses|task-create|task-list|task-get ID|task-cancel ID|task-events ID";
const noBody = new Set([
  "health",
  "models",
  "capabilities",
  "task-list",
  "task-get",
  "task-cancel",
  "task-events",
]);
const bodyCommands = new Set(["chat", "responses", "task-create"]);
try {
  if (!command || command === "--help") {
    process.stdout.write(
      `${usage}\nJSON request bodies come from stdin. Credentials come from OMNIROUTE_API_KEY.\n`
    );
  } else {
    const needsId = ["task-get", "task-cancel", "task-events"].includes(command);
    if (
      (!noBody.has(command) && !bodyCommands.has(command)) ||
      extra.length ||
      (needsId ? !id : id)
    )
      throw new TypeError("Invalid command");
    const client = new OmniRouteClient({
      baseUrl: process.env.OMNIROUTE_BASE_URL,
      apiKey: process.env.OMNIROUTE_API_KEY,
    });
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    let body;
    if (bodyCommands.has(command)) {
      const chunks = [];
      let length = 0;
      for await (const chunk of process.stdin) {
        length += chunk.length;
        if (length > 262_144) throw new TypeError("Input exceeds 256 KiB");
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    const options = {
      signal: controller.signal,
      idempotencyKey: process.env.OMNIROUTE_IDEMPOTENCY_KEY,
    };
    let result;
    switch (command) {
      case "health":
        result = await client.health();
        break;
      case "models":
        result = await client.models();
        break;
      case "capabilities":
        result = await client.capabilities();
        break;
      case "chat":
        result = await client.chatCompletions(body, options);
        break;
      case "responses":
        result = await client.responses(body, options);
        break;
      case "task-create":
        result = await client.createTask(body, options);
        break;
      case "task-list":
        result = await client.listTasks();
        break;
      case "task-get":
        result = await client.getTask(id);
        break;
      case "task-cancel":
        result = await client.cancelTask(id);
        break;
      case "task-events":
        result = await client.taskEvents(id);
        break;
    }
    if (result instanceof ReadableStream) {
      for await (const chunk of result) {
        if (!process.stdout.write(chunk))
          await new Promise((resolve) => process.stdout.once("drain", resolve));
      }
    } else process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  // Never echo provider bodies, credentials, task payloads or local paths to stderr.
  process.stderr.write(
    `${JSON.stringify({ error: { code: error instanceof OmniRouteError ? (error.code ?? "http_error") : "client_error", status: error instanceof OmniRouteError ? error.status : undefined, message: "Request failed; check command, input and gateway configuration" } })}\n`
  );
  process.exitCode = 1;
}
