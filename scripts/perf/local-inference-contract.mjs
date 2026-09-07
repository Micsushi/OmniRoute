import { readFile } from "node:fs/promises";
import { cpus, totalmem, platform, arch } from "node:os";
import { isDeepStrictEqual } from "node:util";

// No installation or discovery side effects. Run only against an owned local runtime.
const baseUrl = new URL(process.env.OLLAMA_BENCH_URL ?? "http://127.0.0.1:23129");
if (
  baseUrl.hostname !== "127.0.0.1" ||
  baseUrl.protocol !== "http:" ||
  baseUrl.username ||
  baseUrl.password
)
  throw new Error("An owned loopback runtime is required");
const model = process.env.OLLAMA_BENCH_MODEL ?? "qwen2.5:0.5b-instruct";
const probes = JSON.parse(
  await readFile(
    new URL("../../tests/fixtures/omniroute-local-probes.json", import.meta.url),
    "utf8"
  )
);
async function api(path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Runtime returned HTTP ${response.status}`);
  return response.json();
}
const inventory = await api("/api/tags");
const installed = inventory.models.find((entry) => entry.name === model);
if (!installed || installed.size > 1_200_000_000)
  throw new Error("Expected bounded model is not installed");
const results = [];
for (const probe of probes) {
  const started = performance.now();
  const result = await api("/api/generate", {
    model,
    prompt: probe.prompt,
    format: probe.schema,
    stream: false,
    keep_alive: "1m",
    options: {
      num_ctx: 2048,
      num_predict: 64,
      num_gpu: 0,
      num_thread: 4,
      temperature: 0,
      seed: 42,
    },
  });
  const output = result.response.trim();
  let passed = output === probe.expected;
  if (probe.expectedJson) {
    try {
      passed = isDeepStrictEqual(JSON.parse(output), probe.expectedJson);
    } catch {
      passed = false;
    }
  }
  results.push({
    id: probe.id,
    passed,
    output,
    wallMs: Math.round(performance.now() - started),
    loadMs: Math.round(result.load_duration / 1e6),
    promptTokens: result.prompt_eval_count,
    outputTokens: result.eval_count,
    tokensPerSecond:
      result.eval_duration > 0
        ? Number((result.eval_count / (result.eval_duration / 1e9)).toFixed(2))
        : null,
  });
}
const resident = (await api("/api/ps")).models.find((entry) => entry.name === model);
console.log(
  JSON.stringify(
    {
      runtime: await api("/api/version"),
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0].model,
      ramBytes: totalmem(),
      model,
      digest: installed.digest,
      modelBytes: installed.size,
      quantization: installed.details.quantization_level,
      residentBytes: resident?.size,
      vramBytes: resident?.size_vram,
      context: 2048,
      threads: 4,
      seed: 42,
      temperature: 0,
      results,
      qualification:
        "Three unconstrained smoke probes and one schema-constrained probe; not a reasoning or tool-use evaluation.",
    },
    null,
    2
  )
);
await api("/api/generate", { model, keep_alive: 0 });
