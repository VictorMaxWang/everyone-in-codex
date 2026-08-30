import assert from "node:assert/strict";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcherSource = path.join(repoRoot, "scripts", "product-launcher.ps1");

function versionRecord(version, directory, fill) {
  return { version, directory, digest: fill.repeat(64), sourceCommit: fill.repeat(40) };
}

function createRuntime(productRoot, directory, cliSource) {
  const runtime = path.join(productRoot, "versions", directory);
  mkdirSync(path.join(runtime, "runtime", "node"), { recursive: true });
  mkdirSync(path.join(runtime, "src"), { recursive: true });
  const node = path.join(runtime, "runtime", "node", "node.exe");
  try { linkSync(process.execPath, node); } catch { copyFileSync(process.execPath, node); }
  writeFileSync(path.join(runtime, "src", "cli.mjs"), cliSource);
}

function runFixture({ newCli, oldCli }) {
  const productRoot = mkdtempSync(path.join(tmpdir(), "everyone-launcher-"));
  mkdirSync(path.join(productRoot, "bin"), { recursive: true });
  mkdirSync(path.join(productRoot, "updates"), { recursive: true });
  copyFileSync(launcherSource, path.join(productRoot, "bin", "product-launcher.ps1"));
  createRuntime(productRoot, "0.3.0-old", oldCli);
  createRuntime(productRoot, "0.3.1-new", newCli);
  const oldRecord = versionRecord("0.3.0", "0.3.0-old", "a");
  const newRecord = versionRecord("0.3.1", "0.3.1-new", "b");
  writeFileSync(path.join(productRoot, "active-version.json"), JSON.stringify({
    schemaVersion: 1,
    state: "pending-first-launch",
    active: newRecord,
    previous: oldRecord,
    failed: null,
  }));
  writeFileSync(path.join(productRoot, "updates", "status-v1.json"), JSON.stringify({
    schemaVersion: 1,
    version: "0.3.1",
    phase: "restarting",
    updatedAt: 1,
    error: null,
  }));
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(productRoot, "bin", "product-launcher.ps1"), "doctor",
  ], { encoding: "utf8", windowsHide: true });
  return { productRoot, result };
}

test("稳定 launcher 在新 Host 就绪后确认活动指针", { skip: process.platform !== "win32" }, () => {
  const fx = runFixture({ newCli: "process.exit(0);\n", oldCli: "process.exit(0);\n" });
  try {
    assert.equal(fx.result.status, 0, fx.result.stderr);
    const pointer = JSON.parse(readFileSync(path.join(fx.productRoot, "active-version.json"), "utf8"));
    assert.equal(pointer.state, "active");
    assert.equal(pointer.active.version, "0.3.1");
    const status = JSON.parse(readFileSync(path.join(fx.productRoot, "updates", "status-v1.json"), "utf8"));
    assert.equal(status.phase, "succeeded");
  } finally {
    rmSync(fx.productRoot, { recursive: true, force: true });
  }
});

test("稳定 launcher 在首次启动失败时切回旧版本并启动它", { skip: process.platform !== "win32" }, () => {
  const fx = runFixture({
    newCli: "process.exit(1);\n",
    oldCli: "import {writeFileSync} from 'node:fs'; writeFileSync(new URL('../../fallback.ok', import.meta.url), 'ok');\n",
  });
  try {
    assert.equal(fx.result.status, 0, fx.result.stderr);
    const pointer = JSON.parse(readFileSync(path.join(fx.productRoot, "active-version.json"), "utf8"));
    assert.equal(pointer.active.version, "0.3.0");
    assert.equal(pointer.failed.version, "0.3.1");
    assert.equal(existsSync(path.join(fx.productRoot, "versions", "fallback.ok")), true);
    const status = JSON.parse(readFileSync(path.join(fx.productRoot, "updates", "status-v1.json"), "utf8"));
    assert.equal(status.phase, "failed");
  } finally {
    rmSync(fx.productRoot, { recursive: true, force: true });
  }
});
