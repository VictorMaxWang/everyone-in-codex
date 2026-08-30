import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FusionController,
  JsonProfileStore,
  createLocalFusionController,
  createLocalValidationPolicy,
  defaultFusionPaths,
} from "../src/fusion-controller.mjs";

test("Profile 配置只写入指定 LOCALAPPDATA 下的 EveryoneCodex", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "everyone-localappdata-"));
  const paths = defaultFusionPaths({ localAppData });
  assert.equal(paths.root, path.join(localAppData, "EveryoneCodex"));
  assert.equal(paths.profileConfigFile, path.join(paths.root, "profiles.json"));
  assert.equal(paths.harnessStateFile, path.join(paths.root, "harnesses.json"));

  const store = new JsonProfileStore({ filePath: paths.profileConfigFile });
  const profile = {
    name: "secondary",
    codexHome: "C:\\Users\\tester\\CodexProfiles\\second",
    sqliteHome: "C:\\Users\\tester\\CodexProfiles\\second",
    desktopRoot: "C:\\Users\\tester\\CodexParallelDesktop\\managed",
    desktopUserData: "C:\\Users\\tester\\CodexParallelDesktop\\ui\\second",
  };

  await store.add(profile);
  await store.use("secondary");

  assert.deepEqual(await store.list(), [profile]);
  assert.deepEqual(await store.getActive(), profile);
  const persisted = JSON.parse(await readFile(paths.profileConfigFile, "utf8"));
  assert.equal(persisted.active, "secondary");
  assert.deepEqual(persisted.profiles.secondary, profile);
});

test("本机 validation policy 在任何外部动作前拒绝 primary Profile", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "everyone-localappdata-"));
  const store = new JsonProfileStore({
    filePath: defaultFusionPaths({ localAppData }).profileConfigFile,
  });
  await store.add({
    name: "primary",
    codexHome: "C:\\Users\\tester\\.codex",
    sqliteHome: "C:\\Users\\tester\\.codex",
    desktopRoot: "C:\\Program Files\\WindowsApps\\OpenAI.Codex",
    desktopUserData: "C:\\Users\\tester\\AppData\\Roaming\\Codex",
  });

  let externalCalls = 0;
  const controller = new FusionController({
    profiles: store,
    harnesses: { list: async () => [] },
    catalogBridge: {
      activate: async () => {
        externalCalls += 1;
      },
    },
    launcher: {
      launch: async () => {
        externalCalls += 1;
      },
    },
    validationPolicy: createLocalValidationPolicy({
      allowedProfileNames: ["secondary"],
    }),
  });

  await assert.rejects(controller.useProfile("primary"), /本机验证不允许 Profile primary/);
  assert.equal(externalCalls, 0);
});

test("FusionController 通过注入边界准备、同步、启动和精确恢复", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "everyone-localappdata-"));
  const store = new JsonProfileStore({
    filePath: defaultFusionPaths({ localAppData }).profileConfigFile,
  });
  const profile = await store.add({
    name: "secondary",
    codexHome: "C:\\Users\\tester\\CodexProfiles\\second",
    sqliteHome: "C:\\Users\\tester\\CodexProfiles\\second",
    desktopRoot: "C:\\Users\\tester\\CodexParallelDesktop\\managed",
    desktopUserData: "C:\\Users\\tester\\CodexParallelDesktop\\ui\\second",
  });
  await store.use("secondary");

  const calls = [];
  const controller = new FusionController({
    profiles: store,
    harnesses: { list: async () => [{ id: "pi" }] },
    preparer: {
      prepare: async (input) => {
        calls.push(["prepare", input]);
        return { prepared: true };
      },
    },
    catalogBridge: {
      inspect: async () => ({ status: "ready" }),
      activate: async (input) => {
        calls.push(["activate", input]);
        return { leaseId: "bridge-1", models: 10 };
      },
    },
    launcher: {
      inspect: async () => ({ running: false }),
      launch: async (input) => {
        calls.push(["launch", input]);
        return { leaseId: "fusion-1", pid: 4242 };
      },
      restore: async (input) => {
        calls.push(["restore", input]);
        return { restored: true, leaseId: input.leaseId };
      },
    },
    validationPolicy: createLocalValidationPolicy({
      allowedProfileNames: ["secondary"],
    }),
  });

  assert.deepEqual(await controller.inspect(), {
    activeProfile: profile,
    profiles: [profile],
    harnesses: [{ id: "pi" }],
    catalog: { status: "ready" },
    launcher: { running: false },
  });
  assert.deepEqual(await controller.prepare(), { prepared: true });
  assert.deepEqual(await controller.syncModels({ target: "external" }), {
    leaseId: "bridge-1",
    models: 10,
  });
  assert.deepEqual(await controller.launch(), {
    leaseId: "fusion-1",
    pid: 4242,
  });
  assert.deepEqual(await controller.restore({ leaseId: "fusion-1" }), {
    restored: true,
    leaseId: "fusion-1",
  });

  assert.deepEqual(calls, [
    ["prepare", { profile }],
    ["activate", { target: "external", profile }],
    ["launch", { profile }],
    ["restore", { leaseId: "fusion-1" }],
  ]);
});

test("createLocalFusionController 默认装配 runtime 边界且保留显式依赖注入", async () => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "everyone-localappdata-"));
  const calls = [];
  const runtime = {
    validationPolicy: { assert: async (profile) => profile },
    preparer: {
      prepare: async ({ profile }) => {
        calls.push(["prepare", profile.name]);
        return { prepared: true };
      },
    },
    catalogBridge: {
      inspect: async () => ({ codex: { modelCount: 2 } }),
      activate: async ({ target }) => {
        calls.push(["sync", target]);
        return { target, modelCount: 2 };
      },
    },
    launcher: {
      inspect: async () => ({ running: false, leases: [] }),
      launch: async ({ profile }) => {
        calls.push(["launch", profile.name]);
        return { leaseId: "local-runtime-1" };
      },
      restore: async ({ leaseId }) => {
        calls.push(["restore", leaseId]);
        return { restored: true, leaseId };
      },
    },
  };
  const controller = createLocalFusionController({ localAppData, runtime });
  const profile = {
    name: "second",
    codexHome: "C:\\Profiles\\second",
    sqliteHome: "C:\\Profiles\\second",
    desktopRoot: "C:\\Desktop\\second",
    desktopUserData: "C:\\Desktop\\ui\\second",
  };
  await controller.addProfile(profile);
  await controller.useProfile(profile.name);

  assert.deepEqual(await controller.prepare(), { prepared: true });
  assert.deepEqual(await controller.syncModels(), { target: "codex", modelCount: 2 });
  assert.deepEqual(await controller.launch(), { leaseId: "local-runtime-1" });
  assert.deepEqual(await controller.restore({ leaseId: "local-runtime-1" }), {
    restored: true,
    leaseId: "local-runtime-1",
  });
  assert.deepEqual(calls, [
    ["prepare", "second"],
    ["sync", "codex"],
    ["launch", "second"],
    ["restore", "local-runtime-1"],
  ]);
});

test("FusionController 统一委托 Connections，而不让 CLI 接触 owner 凭据", async () => {
  const calls = [];
  const controller = new FusionController({
    profiles: {
      getActive: async () => ({ name: "second" }),
      list: async () => [],
    },
    harnesses: { list: async () => [] },
    validationPolicy: { assert: async (profile) => profile },
    connections: {
      inspect: async () => [{ id: "codex2", state: "connected" }],
      createCustom: async (draft) => {
        calls.push(["create", draft]);
        return { id: "custom-lab" };
      },
      startLogin: async (target) => {
        calls.push(["login", target]);
        return { target };
      },
      remove: async (id) => {
        calls.push(["remove", id]);
        return { removed: true };
      },
      apply: async () => {
        calls.push(["apply"]);
        return { applied: true };
      },
      open: async () => ({ opened: true }),
    },
  });

  assert.deepEqual(await controller.listConnections(), [{ id: "codex2", state: "connected" }]);
  assert.deepEqual(await controller.createConnection({ label: "Lab" }), { id: "custom-lab" });
  assert.deepEqual(await controller.loginConnection("codex2"), { target: "codex2" });
  assert.deepEqual(await controller.removeConnection("custom-lab"), { removed: true });
  assert.deepEqual(await controller.applyConnections(), { applied: true });
  assert.deepEqual(await controller.openConnections(), { opened: true });
  assert.deepEqual(calls, [
    ["create", { label: "Lab" }],
    ["login", "codex2"],
    ["remove", "custom-lab"],
    ["apply"],
  ]);
});
