import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "omniroute-offline-routing-"));
try {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--test",
      "--test-concurrency=1",
      "tests/unit/automation-tasks.test.ts",
      "tests/unit/omniroute-sdk.test.mjs",
      "tests/unit/omniroute-worker.test.mjs",
      "tests/integration/automation-contract.test.ts",
      "tests/unit/policy-engine.test.ts",
      "tests/unit/model-capabilities-registry.test.ts",
      "tests/unit/circuit-breaker-failure-kind.test.ts",
      "tests/unit/circuit-breaker-client-abort.test.ts",
    ],
    { stdio: "inherit", env: { ...process.env, DATA_DIR: directory, NODE_ENV: "test" } }
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(directory, { recursive: true, force: true });
}
