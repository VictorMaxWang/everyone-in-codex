import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProductUpdateCoordinator } from "../src/product-update-coordinator.mjs";

const currentManifest = Object.freeze({
  schemaVersion: 2,
  product: "everyone-in-codex",
  version: "0.3.1",
  channel: "stable",
  target: "windows-x64",
  sourceCommit: "1".repeat(40),
  runtimeManifestSha256: "a".repeat(64),
  upstreams: {
    codexhost: { commit: "2".repeat(40), tree: "3".repeat(40) },
    router: { commit: "4".repeat(40), tree: "5".repeat(40) },
    webgpt: { commit: "6".repeat(40), tree: "7".repeat(40) },
  },
});

function candidate(version = "0.3.2") {
  return Object.freeze({
    version,
    tag: `v${version}`,
    sourceCommit: "8".repeat(40),
    releaseNotes: "notes",
    releaseNotesUrl:
      `https://github.com/VictorMaxWang/everyone-in-codex/releases/tag/v${version}`,
    assets: {},
  });
}

async function fixture(t, overrides = {}) {
  const productRoot = await mkdtemp(path.join(tmpdir(), "everyone-update-"));
  t.after(() => rm(productRoot, { recursive: true, force: true }));
  const stagedDirectory = "0.3.2-deadbeef0000";
  await mkdir(path.join(productRoot, "versions", stagedDirectory), { recursive: true });
  const calls = { fetch: 0, stage: 0, activate: [] };
  const coordinator = new ProductUpdateCoordinator({
    productRoot,
    currentManifest,
    fetchLatest: async () => {
      calls.fetch += 1;
      return candidate(overrides.version ?? "0.3.2");
    },
    stageRelease: async ({ release, onProgress }) => {
      calls.stage += 1;
      onProgress({ downloadedBytes: 5, totalBytes: 10 });
      return {
        version: release.version,
        directory: stagedDirectory,
        digest: "b".repeat(64),
        sourceCommit: release.sourceCommit,
      };
    },
    scheduleActivation: async (value) => calls.activate.push(value),
    ...overrides,
  });
  return { coordinator, calls, productRoot };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("test_wait_timeout");
}

test("同版本不显示徽标，也不下载或安排激活", async (t) => {
  const { coordinator, calls } = await fixture(t, { version: "0.3.1" });
  const result = await coordinator.check({ launcherPid: 1234 });
  assert.equal(result.currentVersion, "0.3.1");
  assert.equal(result.latestVersion, "0.3.1");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.installationAvailable, false);
  assert.equal(calls.stage, 0);
  assert.deepEqual(calls.activate, []);
});

test("检查发现稳定新版后后台暂存，并登记退出后自动激活", async (t) => {
  const { coordinator, calls } = await fixture(t);
  const result = await coordinator.check({ launcherPid: 4321, leaseId: "lease-one" });
  assert.equal(result.updateAvailable, true);
  assert.equal(result.installationAvailable, true);
  await waitFor(async () => (await coordinator.status()).status?.phase === "waiting-for-exit");
  assert.equal(calls.stage, 1);
  assert.equal(calls.activate.length, 1);
  assert.equal(calls.activate[0].mode, "auto");
  assert.equal(calls.activate[0].launcherPid, 4321);
});

test("立即安装复用同一暂存事务并把激活模式提升为 manual", async (t) => {
  let releaseStage;
  const stageBarrier = new Promise((resolve) => { releaseStage = resolve; });
  const base = await fixture(t, {
    stageRelease: async ({ release }) => {
      base.calls.stage += 1;
      await stageBarrier;
      return {
        version: release.version,
        directory: "0.3.2-deadbeef0000",
        digest: "b".repeat(64),
        sourceCommit: release.sourceCommit,
      };
    },
  });
  await base.coordinator.check({ launcherPid: 9876, leaseId: "lease-two" });
  const started = base.coordinator.start({ launcherPid: 9876, leaseId: "lease-two" });
  releaseStage();
  const result = await started;
  assert.equal(result.status.phase, "waiting-for-exit");
  assert.equal(base.calls.stage, 1);
  assert.equal(base.calls.activate.at(-1).mode, "manual");
});

test("GitHub API 失败或 429 只返回无徽标错误，不触发下载", async (t) => {
  const { coordinator, calls } = await fixture(t, {
    fetchLatest: async () => {
      calls.fetch += 1;
      throw new Error("product_update_rate_limited");
    },
  });
  const result = await coordinator.check({ launcherPid: 1234 });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.latestVersion, null);
  assert.match(result.error, /product_update_rate_limited/u);
  assert.equal(calls.fetch, 1);
  assert.equal(calls.stage, 0);
});

test("检查结果在六小时窗口内复用，状态可由新进程恢复", async (t) => {
  let now = 100_000;
  const { coordinator, calls, productRoot } = await fixture(t, {
    autoDownload: false,
    now: () => now,
  });
  await coordinator.check({ launcherPid: 1234 });
  now += 60_000;
  await coordinator.check({ launcherPid: 1234 });
  assert.equal(calls.fetch, 1);
  const started = await coordinator.start({ launcherPid: 1234, leaseId: "lease-three" });
  assert.equal(started.status.phase, "waiting-for-exit");

  const recovered = new ProductUpdateCoordinator({
    productRoot,
    currentManifest,
    fetchLatest: async () => candidate(),
    stageRelease: async () => { throw new Error("must_not_stage"); },
    scheduleActivation: async () => {},
    autoDownload: false,
    now: () => now,
  });
  assert.equal((await recovered.status()).status.phase, "waiting-for-exit");
});
