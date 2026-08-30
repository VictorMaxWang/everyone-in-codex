import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scheduleProductActivation } from "../src/product-update-runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "everyone-update-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const productRoot = path.join(root, "product");
  const currentPackageRoot = path.join(root, "current");
  const launcherExecutable = path.join(root, "codexhost.exe");
  const runtimeDescriptorPath = path.join(root, "codexhost-state", "desktop-runtime-v1.json");
  await mkdir(path.dirname(runtimeDescriptorPath), { recursive: true });
  await mkdir(currentPackageRoot, { recursive: true });
  await writeFile(launcherExecutable, "fixture");
  await writeFile(runtimeDescriptorPath, "{}\n");
  return { root, productRoot, currentPackageRoot, launcherExecutable, runtimeDescriptorPath };
}

const record = Object.freeze({
  version: "0.3.2",
  directory: "0.3.2-deadbeef0000",
  digest: "a".repeat(64),
  sourceCommit: "b".repeat(40),
});

test("手工立即安装写入 Launcher 可验证退出信号，自动模式不会打断 Codex 2", async (t) => {
  const manual = await fixture(t);
  const scheduled = await scheduleProductActivation({
    ...manual,
    configPath: path.join(manual.productRoot, "fusion.local.json"),
    record,
    launcherPid: 4242,
    leaseId: "lease-one",
    mode: "manual",
    spawnImpl: () => ({ pid: 7272, unref() {} }),
    sourceEnvironment: { LOCALAPPDATA: manual.root, SystemRoot: "C:\\Windows" },
  });
  assert.equal(scheduled.launcherSignal, true);
  const updateRoot = path.join(path.dirname(manual.runtimeDescriptorPath), "updates");
  const lock = JSON.parse(await readFile(path.join(updateRoot, "active-update-v1.lock"), "utf8"));
  const request = JSON.parse(await readFile(
    path.join(path.dirname(lock.statusPath), "request-v1.json"),
    "utf8",
  ));
  assert.equal(request.wait_pid, 4242);
  assert.equal(request.wait_executable, manual.launcherExecutable);

  const automatic = await fixture(t);
  const background = await scheduleProductActivation({
    ...automatic,
    configPath: path.join(automatic.productRoot, "fusion.local.json"),
    record,
    launcherPid: 5252,
    leaseId: "lease-two",
    mode: "auto",
    spawnImpl: () => ({ pid: 7373, unref() {} }),
    sourceEnvironment: { LOCALAPPDATA: automatic.root, SystemRoot: "C:\\Windows" },
  });
  assert.equal(background.launcherSignal, false);
  await assert.rejects(
    readFile(path.join(path.dirname(automatic.runtimeDescriptorPath), "updates", "active-update-v1.lock")),
    { code: "ENOENT" },
  );
});
