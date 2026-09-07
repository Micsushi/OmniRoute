# OmniRoute v1 client and task contract

Dependency-free ESM client, CLI and inference-only worker. Contract version `1.0.0`.
This package is distributed from this repository; no registry publication is assumed.
From `packages/sdk`, run `npm pack`, then install the resulting tarball in the client project.
The gateway must contain this branch's capabilities route and migration `173_automation_tasks.sql`
for task APIs. Existing chat and Responses endpoints do not need the task migration.

## Flapstack integration

```js
import { OmniRouteClient } from "@omniroute/sdk";

const client = new OmniRouteClient({
  baseUrl: process.env.OMNIROUTE_BASE_URL,
  apiKey: process.env.OMNIROUTE_API_KEY,
});
const models = await client.models();
const reply = await client.chatCompletions({
  model: "ollama-local/qwen2.5:1.5b",
  messages: [{ role: "user", content: "Summarize the supplied public text." }],
});
```

Resolve credentials in Flapstack's trusted backend, never its renderer. Use a dedicated
gateway key restricted to the approved connection and fixed model. Do not import paid
subscription credentials. Provider registration, budgets, fallback and circuit breakers
remain gateway responsibilities. The client never configures providers, chooses `auto`,
retries requests, follows redirects or imports other tools' authentication.

Call `capabilities()` before using task APIs. Missing endpoint (404) means a legacy gateway:
retain ordinary chat/Responses integration and disable the queue UI. Reject an unsupported
major `contractVersion`; tolerate additive fields in the same major version. Do not treat
protocol support as proof that a configured model supports tools, vision or structured output.
Inspect `models()` and run a workload-specific acceptance probe. Flapstack owns its adapter,
permission UI and any execution sandbox; this repository does not modify it.

| Surface             | Contract                                                | Limits                                                                       |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Chat                | `chatCompletions(body, options)`                        | OpenAI-compatible JSON; fixed model recommended                              |
| Responses           | `responses(body, options)`                              | Provider translation support varies                                          |
| Streaming           | `stream: true` returns raw `ReadableStream<Uint8Array>` | Preserve SSE framing and tool argument deltas; no automatic retry            |
| Discovery           | `capabilities()`, `models()`                            | Support inventory, not a provider readiness promise                          |
| Health              | `health()`                                              | Liveness only; readiness at `/api/monitoring/health`                         |
| Signals             | `routingSignals(limit)`                                 | Existing metadata-only quality/latency events, gateway authorization applies |
| Tasks               | methods below                                           | Authenticated, key-scoped, durable, at-least-once                            |
| Tool execution      | Not provided                                            | Worker never executes returned tools, code or shell commands                 |
| WebSocket, MCP, A2A | Existing gateway protocols                              | Not implemented by this SDK                                                  |

`OmniRouteError` exposes HTTP `status`, gateway `code`, `requestId` and error `details`.
Transport/abort errors remain Fetch API errors. Do not log raw bodies/details from untrusted
providers. Default timeout is 30 seconds and remains attached while consuming a stream.
Use `signal` to cancel a generation and an explicit `timeoutMs` for longer bounded work.

## Durable task queue

`createTask({ kind, payload, policy, priority, availableAt, deadlineAt, maxAttempts },
{ idempotencyKey })` returns `{ object: "automation.task", apiVersion: "v1", data, reused }`.
Submission is `POST /v1/tasks`; identical normalized JSON and the same key reuse the task.
Changed payload returns HTTP 409. Keys are scoped to the authenticated gateway key and
limited to 256 UTF-8 bytes. JSON object key order does not affect identity; array order does.
Chat/Responses idempotency headers are forwarded, not an exactly-once guarantee.

The task body, including a completion result, is limited to 256 KiB. Common inline secret
field names are rejected at submission, but this is not a general secret detector. Never
submit sensitive prompts or credentials to persistent task storage. `secretRefs` stores
references only; the gateway does not resolve them. Worker failure messages are generic.
Task payloads/results are stored in SQLite, so restrict the data directory and its backups.

| Operation                                            | HTTP                        | Result                                                 |
| ---------------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| `listTasks({status,limit,after})`                    | GET `/v1/tasks`             | Newest first, stable ID cursor, maximum 200, `hasMore` |
| `claimTask({workerId,kinds,leaseMs})`                | POST `/v1/tasks/claim`      | One exclusive lease or HTTP 204 (`null`)               |
| `getTask(id)`                                        | GET `/v1/tasks/{id}`        | Task envelope                                          |
| `heartbeatTask(id,leaseToken,leaseMs)`               | POST `/v1/tasks/{id}`       | Renew lease; `cancelRequested` flag                    |
| `completeTask(id,leaseToken,result)`                 | POST `/v1/tasks/{id}`       | Fenced completion                                      |
| `failTask(id,leaseToken,error,{retry,retryDelayMs})` | POST `/v1/tasks/{id}`       | Retry or terminal failure                              |
| `cancelTask(id)`                                     | POST `/v1/tasks/{id}`       | Queued task cancels; leased task becomes cancelling    |
| `taskEvents(id,afterSequence)`                       | GET `/v1/tasks/{id}/events` | Up to 500 ordered metadata events, `hasMore`           |

Action bodies use `action: heartbeat|complete|fail|cancel`. Leased actions require a UUID
`leaseToken`. Lease requests allow 5 seconds to 30 minutes. Renewal cannot extend beyond
the per-attempt `policy.maxRuntimeMs` or absolute task deadline. Expired tokens cannot settle
work. The next claim recovers expired leases and overdue queued tasks. No background reaper
is required, so status may remain stale until that claim. A cancelled completion discards output.
Recovery and lost replies can repeat execution: external side effects need their own idempotency
and fencing. Queue fencing does not make arbitrary external systems exactly-once.

For event replay, fetch again with the last returned `sequence` while `hasMore` is true.
Events contain transitions and trace/worker IDs, not prompts or model output. They support
audit reconstruction, not automatic re-execution. No automatic historical-data deletion occurs.

## Inference-only worker

```js
import { OmniRouteClient } from "@omniroute/sdk";
import { runChatTaskOnce } from "@omniroute/sdk/worker";

const client = new OmniRouteClient({
  baseUrl: process.env.OMNIROUTE_BASE_URL,
  apiKey: process.env.OMNIROUTE_API_KEY,
});
await runChatTaskOnce(client, {
  workerId: "flapstack-local-1",
  model: "ollama-local/qwen2.5:1.5b",
});
```

The worker claims only `chat.completion`. Payload allows `messages`, `temperature` and
`max_tokens`. Policy must allow no filesystem, network tools, commands or secrets. The
gateway control/inference connection is the only network operation. Unsupported policy or
payload fails closed. A one-second heartbeat aborts inference on cancellation or lost lease.
Runtime timeout and caller abort also stop inference. Failed inference is not automatically
retried by this helper. A supervisor may invoke it again to claim other work; no daemon or
service is installed automatically. It is an inference boundary, not a general OS sandbox.

## CLI

```sh
omniroute-client health
omniroute-client models
omniroute-client capabilities
omniroute-client chat < request.json
omniroute-client responses < request.json
omniroute-client task-create < task.json
omniroute-client task-get TASK_ID
omniroute-client task-cancel TASK_ID
omniroute-client task-events TASK_ID
```

`OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY` and optional `OMNIROUTE_IDEMPOTENCY_KEY` supply
configuration. Do not put keys in argv. stdout is JSON or untouched SSE bytes; stderr is a
generic JSON error and failure exits 1. Help exits 0. No shell/tool invocation is offered.

## Verification and migration

From the repository root, `npm run test:routing-substrate` runs offline SDK, worker, real
HTTP/route/SQLite lifecycle and existing policy/capability/breaker tests. It uses isolated
temporary databases and loopback ports, no provider credentials or models. Run
`npm run typecheck:routing-substrate` and `npm run typecheck:core` as well. The package needs
no build step. This command is suitable for offline CI after dependencies are installed;
no new hosted workflow is enabled by this package.

Back up the gateway data directory before upgrading. Apply the normal migration runner,
then verify capabilities, key isolation, submit/claim/complete, restart and readback. Keep
the previous runtime and backup for rollback; old releases ignore the new tables. Do not
drop task tables automatically. Migration 173 avoids the current release's 171/172 slots;
recheck numbering before integration. Newer A2A history persistence is separate and must
not be overwritten or treated as this queue's worker state. This branch has not been
integrated into the newer release or deployed to the owner's gateways.

## Small-model measurement

Windows CPU-only test: Ollama 0.20.6, i7-12700KF, four threads, 2048 context, seed 42,
temperature 0, maximum 64 output tokens. Model `qwen2.5:0.5b-instruct`, Q4_K_M,
397,821,319 bytes, digest `a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67`.
Ollama reported 417,025,536 resident bytes and zero VRAM bytes. This is runtime-reported
model allocation, not total host process RSS or peak system memory.

| Probe                 | Exact check               | Wall time | Generated tokens/s |
| --------------------- | ------------------------- | --------- | ------------------ |
| Arithmetic, cold      | Failed: did not return 42 | 2542 ms   | 48.85              |
| City extraction, warm | Passed: Denver            | 396 ms    | 75.52              |
| Strict JSON, warm     | Failed: markdown fences   | 767 ms    | 46.86              |

Only 1/3 deterministic smoke probes passed. Do not qualify this model for unattended
structured tasks from this evidence. No reasoning, tool-call or broad quality claim is made.
Run `node scripts/perf/local-inference-contract.mjs` against a separately owned loopback
Ollama runtime to reproduce. It never downloads models or uses paid providers. Mac and
Server2 models were not requalified in this task; existing runtime settings stay unchanged.
The model's [Apache-2.0 license](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/367ae90eaf97b8d64787d6ee9101a04460b55392/LICENSE)
and [Ollama model entry](https://ollama.com/library/qwen2.5:0.5b-instruct) identify the tested family.
