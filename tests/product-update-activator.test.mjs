import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProductVersionStore } from "../src/product-state.mjs";
import { activateProductUpdate } from "../src/product-update-activator.mjs";

async function fixture(t, mode = "auto") {
  const productRoot = await mkdtemp(path.join(tmpdir(), "everyone-activate-"));
  t.after(() => rm(productRoot, { recursive: true, force: true }));
  await mkdir(path.join(productRoot, "versions", "0.3.0-old"), { recursive: true });
  await mkdir(path.join(productRoot, "versions", "0.3.1-new"), { recursive: true });
  await mkdir(path.join(productRoot, "updates"), { recursive: true });
  await mkdir(path.join(productRoot, "bin"), { recursive: true });
  await writeFile(path.join(productRoot, "bin", "product-launcher.ps1"), "# fixture\n");
  const store = new ProductVersionStore({ productRoot });
  await store.initialize({
    version: "0.3.0", directory: "0.3.0-old", digest: "a".repeat(64), sourceCommit: "1".repeat(40),
  });
  const requestPath = path.join(productRoot, "updates", "activation-request.json");
  await writeFile(requestPath, `${JSON.stringify({
    schemaVersion: 1,
    productRoot,
    currentPackageRoot: path.join(productRoot, "versions", "0.3.0-old"),
    configPath: path.join(productRoot, "fusion.local.json"),
    record: {
      version: "0.3.1", directory: "0.3.1-new", digest: "b".repeat(64), sourceCommit: "2".repeat(40),
    },
    launcherPid: 4242,
    leaseId: "lease-one",
    mode,
    updatedAt: Date.now(),
  }, null, 2)}\n`);
  return { productRoot, requestPath, store };
}

test("自动激活等待精确 Launcher 退出、恢复租约并只切换指针", async (t) => {
  const { requestPath, store } = await fixture(t, "auto");
  const events = [];
  const result = await activateProductUpdate({
    requestPath,
    processAlive: () => false,
    runRestore: async (request) => events.push(`restore:${request.leaseId}`),
    spawnImpl: () => { throw new Error("must_not_relaunch"); },
  });
  assert.deepEqual(events, ["restore:lease-one"]);
  assert.equal(result.activated, true);
  assert.equal(result.relaunchedPid, null);
  assert.equal((await store.read()).state, "pending-first-launch");
});

test("立即安装在切换后只启动稳定 launcher，不直接运行新版本文件", async (t) => {
  const { requestPath } = await fixture(t, "manual");
  let spawned;
  const result = await activateProductUpdate({
    requestPath,
    processAlive: () => false,
    runRestore: async () => {},
    spawnImpl(command, args, options) {
      spawned = { command, args, options };
      return { pid: 9191, unref() {} };
    },
  });
  assert.equal(result.relaunchedPid, 9191);
  assert.equal(spawned.command, "powershell.exe");
  assert.equal(spawned.args.at(-1), "launch");
  assert.equal(Object.keys(spawned.options.env).some((name) => /TOKEN|SECRET|CAPABILITY/u.test(name)), false);
});

test("恢复失败时不切换指针并持久化脱敏失败状态", async (t) => {
  const { productRoot, requestPath, store } = await fixture(t, "manual");
  await assert.rejects(
    activateProductUpdate({
      requestPath,
      processAlive: () => false,
      runRestore: async () => { throw new Error("restore_failed"); },
    }),
    /restore_failed/u,
  );
  assert.equal((await store.read()).active.version, "0.3.0");
  const status = JSON.parse(await readFile(path.join(productRoot, "updates", "status-v1.json"), "utf8"));
  assert.equal(status.phase, "failed");
  assert.equal(status.error, "restore_failed");
});
