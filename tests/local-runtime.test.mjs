import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startGatewayDaemonService } from "../src/gateway-daemon.mjs";
import { createLocalFusionRuntime } from "../src/local-runtime.mjs";

const ROUTER_SECRET = "router-caller-capability-value-1234567890";

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "everyone-local-runtime-"));
  const codexHome = path.join(root, "codex-2-home");
  const desktopRoot = path.join(root, "codex-2-desktop");
  const desktopUserData = path.join(root, "codex-2-ui");
  const routerSourceRoot = path.join(root, "router-source");
  const routerStateDir = path.join(root, "router-state");
  const stateRoot = path.join(root, "fusion-state");
  const codexHostExecutable = path.join(root, "codexhost.exe");
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(desktopRoot, { recursive: true }),
    mkdir(desktopUserData, { recursive: true }),
    mkdir(routerSourceRoot, { recursive: true }),
    mkdir(routerStateDir, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
  ]);
  await writeFile(codexHostExecutable, "fake codexhost", "utf8");

  const profile = {
    name: "second",
    codexHome,
    sqliteHome: codexHome,
    desktopRoot,
    desktopUserData,
  };
  const configPath = path.join(root, "fusion.local.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    profile,
    router: {
      sourceRoot: routerSourceRoot,
      stateDir: routerStateDir,
      healthUrl: "http://127.0.0.1:43123/health",
    },
    webgpt: { healthUrl: "http://127.0.0.1:43124/healthz" },
    runtime: { codexHostExecutable },
  }), "utf8");

  const models = [
    { id: "provider/api-model", context_window: 1_000_000 },
    { id: "chatgpt-web/light", context_window: 333_579 },
    { id: "gpt-5.6-sol-1m", context_window: 1_000_000 },
  ];
  await writeFile(
    path.join(routerStateDir, "merged-models.json"),
    JSON.stringify({ models }),
    "utf8",
  );
  await writeFile(
    path.join(routerStateDir, "model-picker.json"),
    JSON.stringify({ visible: models.map((model) => model.id) }),
    "utf8",
  );
  await writeFile(path.join(routerStateDir, "caller-secret"), `${ROUTER_SECRET}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    root,
    stateRoot,
    configPath,
    profile,
    routerStateDir,
    codexHostExecutable,
  };
}

test("models sync 通过 capability path 查询 fake Router 且安全快照不含 secret", async () => {
  const fx = await fixture();
  const requests = [];
  const runtime = createLocalFusionRuntime({
    configPath: fx.configPath,
    stateRoot: fx.stateRoot,
    fetchImpl: async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        data: [
          { id: "provider/api-model" },
          { id: "chatgpt-web/light" },
          { id: "gpt-5.6-sol-1m" },
        ],
      }));
    },
    harnesses: { list: async () => [] },
  });

  const receipt = await runtime.catalogBridge.activate({
    target: "codex",
    profile: fx.profile,
  });

  assert.deepEqual(requests, [
    `http://127.0.0.1:43123/_codex-router/${ROUTER_SECRET}/v1/models`,
  ]);
  assert.deepEqual(receipt.allowedModelIds, [
    "provider/api-model",
    "chatgpt-web/light",
  ]);
  assert.equal(JSON.stringify(receipt).includes(ROUTER_SECRET), false);

  const snapshotText = await readFile(receipt.snapshotPath, "utf8");
  assert.equal(snapshotText.includes(ROUTER_SECRET), false);
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.target, "codex");
  assert.deepEqual(snapshot.models.map((model) => model.id), receipt.allowedModelIds);
});

test("Gateway daemon 自己读取 caller-secret 并只通过 IPC 返回 consumer capability", async () => {
  const fx = await fixture();
  const catalogPath = path.join(fx.stateRoot, "router-catalog-codex.json");
  await writeFile(catalogPath, JSON.stringify({
    schemaVersion: 1,
    target: "codex",
    catalogRevision: "catalog-revision",
    models: [{ id: "provider/api-model" }],
  }), "utf8");

  const sent = [];
  const starts = [];
  let closed = 0;
  const service = await startGatewayDaemonService({
    configPath: fx.configPath,
    catalogPath,
    leaseId: "lease-daemon-1",
    pid: 7001,
    send: (value) => sent.push(value),
    gatewayFactory: (options) => {
      starts.push(options);
      return {
        start: async ({ models }) => ({
          baseUrl: "http://127.0.0.1:45678",
          models,
          authorizationHeaders: () => ({ authorization: "Bearer fixture-consumer-capability" }),
          close: async () => { closed += 1; },
        }),
      };
    },
  });

  assert.equal(starts.length, 1);
  assert.equal(
    starts[0].routerBaseUrl,
    `http://127.0.0.1:43123/_codex-router/${ROUTER_SECRET}/v1/`,
  );
  assert.deepEqual(sent, [{
    type: "ready",
    leaseId: "lease-daemon-1",
    pid: 7001,
    baseUrl: "http://127.0.0.1:45678",
    capability: "fixture-consumer-capability",
    modelCount: 1,
    catalogRevision: "catalog-revision",
  }]);

  await service.close();
  await service.close();
  assert.equal(closed, 1);
});

test("launch 只把 consumer capability 交给 CodexHost，restore 精确终止 receipt PID", async () => {
  const fx = await fixture();
  const spawnCalls = [];
  const children = new Map();
  let nextPid = 7101;
  const spawnImpl = (command, args, options) => {
    const child = new FakeChild(nextPid++);
    children.set(child.pid, child);
    spawnCalls.push({ command, args: [...args], options, pid: child.pid });
    if (args.some((arg) => String(arg).endsWith("gateway-daemon.mjs"))) {
      const leaseId = args[args.indexOf("--lease") + 1];
      queueMicrotask(() => child.emit("message", {
        type: "ready",
        leaseId,
        pid: child.pid,
        baseUrl: "http://127.0.0.1:45679",
        capability: "consumer-launch-capability",
        modelCount: 2,
        catalogRevision: "catalog-launch-revision",
      }));
    } else {
      queueMicrotask(() => child.stdout.write("ready\n"));
    }
    return child;
  };
  const identities = new Map([
    [7101, {
      pid: 7101,
      executablePath: process.execPath,
      creationDate: "2026-08-30T00:00:01.000Z",
      commandLine: "node gateway-daemon.mjs --lease lease-runtime-1",
    }],
    [7102, {
      pid: 7102,
      executablePath: fx.codexHostExecutable,
      creationDate: "2026-08-30T00:00:02.000Z",
      commandLine: "codexhost.exe launch --custom-install codex-2",
    }],
  ]);
  const terminated = [];
  const harnesses = {
    list: async () => [{
      id: "pi",
      commandPath: path.join(fx.root, "pi.cmd"),
      commandEnvironment: "CODEXHOST_PI_COMMAND",
    }],
  };
  await writeFile(path.join(fx.root, "pi.cmd"), "@echo off", "utf8");

  const runtime = createLocalFusionRuntime({
    configPath: fx.configPath,
    stateRoot: fx.stateRoot,
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "provider/api-model" }, { id: "chatgpt-web/light" }],
    })),
    spawnImpl,
    processInspector: async (pid) => identities.get(pid) ?? null,
    processTerminator: async (identity) => {
      terminated.push(identity.pid);
      identities.delete(identity.pid);
      return { stopped: true };
    },
    randomId: () => "lease-runtime-1",
    harnesses,
  });
  await runtime.catalogBridge.activate({ target: "codex", profile: fx.profile });

  const lease = await runtime.launcher.launch({ profile: fx.profile });
  assert.equal(lease.leaseId, "lease-runtime-1");
  assert.deepEqual(lease.processes, { gateway: 7101, codexHost: 7102 });
  assert.equal(JSON.stringify(lease).includes("consumer-launch-capability"), false);
  assert.equal(JSON.stringify(lease).includes(ROUTER_SECRET), false);

  const gatewaySpawn = spawnCalls[0];
  assert.equal(JSON.stringify(gatewaySpawn.args).includes(ROUTER_SECRET), false);
  assert.equal(JSON.stringify(gatewaySpawn.options.env).includes(ROUTER_SECRET), false);
  const hostSpawn = spawnCalls[1];
  assert.deepEqual(hostSpawn.args, [
    "launch",
    "--custom-install",
    fx.profile.desktopRoot,
    "--desktop-user-data-dir",
    fx.profile.desktopUserData,
  ]);
  assert.equal(hostSpawn.options.env.CODEX_HOME, fx.profile.codexHome);
  assert.equal(hostSpawn.options.env.CODEX_SQLITE_HOME, fx.profile.sqliteHome);
  assert.equal(hostSpawn.options.env.CODEXHOST_CODEX_PROFILE, "everyone-in-codex");
  assert.equal(hostSpawn.options.env.EVERYONE_CODEX_LEASE_CAPABILITY, "consumer-launch-capability");
  assert.equal(hostSpawn.options.env.CODEXHOST_PI_COMMAND, path.join(fx.root, "pi.cmd"));

  const profile = await readFile(
    path.join(fx.profile.codexHome, "everyone-in-codex.config.toml"),
    "utf8",
  );
  assert.match(profile, /base_url = "http:\/\/127\.0\.0\.1:45679\/v1"/);

  const receiptText = await readFile(lease.receiptPath, "utf8");
  assert.equal(receiptText.includes("consumer-launch-capability"), false);
  assert.equal(receiptText.includes(ROUTER_SECRET), false);

  assert.deepEqual(await runtime.launcher.restore({ leaseId: lease.leaseId }), {
    restored: true,
    leaseId: "lease-runtime-1",
    stoppedPids: [7102, 7101],
  });
  assert.deepEqual(terminated, [7102, 7101]);
  await assert.rejects(
    stat(path.join(fx.profile.codexHome, "everyone-in-codex.config.toml")),
    /ENOENT/,
  );
  assert.deepEqual(await runtime.launcher.restore({ leaseId: lease.leaseId }), {
    restored: false,
    leaseId: "lease-runtime-1",
    stoppedPids: [],
  });
});

test("restore 检测 PID 复用并失败关闭，不按进程名终止", async () => {
  const fx = await fixture();
  const runtime = createLocalFusionRuntime({
    configPath: fx.configPath,
    stateRoot: fx.stateRoot,
    harnesses: { list: async () => [] },
    processInspector: async () => ({
      pid: 8123,
      executablePath: "C:\\Windows\\System32\\not-owned.exe",
      creationDate: "2026-08-30T00:10:00.000Z",
      commandLine: "not-owned.exe",
    }),
    processTerminator: async () => {
      assert.fail("ownership mismatch must not terminate a process");
    },
  });
  const leaseDirectory = path.join(fx.stateRoot, "leases");
  await mkdir(leaseDirectory, { recursive: true });
  await writeFile(path.join(leaseDirectory, "lease-reused-pid.json"), JSON.stringify({
    schemaVersion: 1,
    leaseId: "lease-reused-pid",
    profile: fx.profile,
    processes: [{
      role: "gateway",
      pid: 8123,
      executablePath: process.execPath,
      creationDate: "2026-08-30T00:00:00.000Z",
      commandLineSha256: "not-the-current-command",
    }],
  }), "utf8");

  await assert.rejects(
    runtime.launcher.restore({ leaseId: "lease-reused-pid" }),
    /process_ownership_conflict/,
  );
});
