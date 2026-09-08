import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("security-tier checker accepts regex-backed route annotations", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-security-tiers-"));
  try {
    const result = spawnSync(process.execPath, ["scripts/check/check-openapi-security-tiers.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /PASS — all security tier annotations match/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
