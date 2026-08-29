import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startGatewayDaemonService } from "../src/gateway-daemon.mjs";
import {
  publishHarnessConfigs,
  restoreHarnessConfigs,
} from "../src/harness-configs.mjs";
import {
  createLocalFusionRuntime,
  inspectProcessIdentity,
} from "../src/local-runtime.mjs";

const ROUTER_SECRET = "router-caller-capability-value-1234567890";

test(
  "Windows默认Inspector可读取当前进程身份",
  { skip: process.platform !== "win32" },
  async () => {
    const identity = await inspectProcessIdentity(process.pid);
    assert.equal(identity.pid, process.pid);
    assert.equal(path.isAbsolute(identity.executablePath), true);
    assert.match(identity.creationDate, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(identity.commandLineSha256, /^[a-f0-9]{64}$/);
    assert.equal(identity.commandLine, undefined);
  },
);

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
  await writeFile(path.join(root, "validation-policy.local.json"), JSON.stringify({
    schemaVersion: 1,
    allowedCodexHomes: [codexHome],
    allowedDesktopRoots: [desktopRoot, desktopUserData],
    protectedCodexHomes: [path.join(root, "codex-1-home")],
    protectedDesktopRoots: [path.join(root, "windows-apps")],
  }), "utf8");

  const models = [
    {
      id: "provider/api-model",
      display_name: "Provider API Model",
      context_window: 1_000_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
    },
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

test("validation policy 必须显式允许 Codex 2 的四条路径", async () => {
  const fx = await fixture();
  await writeFile(path.join(fx.root, "validation-policy.local.json"), JSON.stringify({
    schemaVersion: 1,
    allowedCodexHomes: [fx.profile.codexHome],
    allowedDesktopRoots: [fx.profile.desktopRoot],
    protectedCodexHomes: [path.join(fx.root, "codex-1-home")],
    protectedDesktopRoots: [path.join(fx.root, "windows-apps")],
  }), "utf8");
  const runtime = createLocalFusionRuntime({
    configPath: fx.configPath,
    stateRoot: fx.stateRoot,
    harnesses: { list: async () => [] },
  });

  await assert.rejects(
    runtime.validationPolicy.assert(fx.profile),
    /profile_path_is_not_explicitly_allowlisted/,
  );
});

test("Gateway daemon 在单进程中隔离 Codex 15 模型与 external 10 模型 lease", async () => {
  const fx = await fixture();
  const codexCatalogPath = path.join(fx.stateRoot, "router-catalog-codex.json");
  const externalCatalogPath = path.join(fx.stateRoot, "router-catalog-external.json");
  const externalModels = Array.from({ length: 10 }, (_, index) => ({
    id: `provider/api-model-${index + 1}`,
  }));
  await writeFile(codexCatalogPath, JSON.stringify({
    schemaVersion: 1,
    target: "codex",
    catalogRevision: "catalog-codex-revision",
    models: [
      ...externalModels,
      ...Array.from({ length: 5 }, (_, index) => ({ id: `chatgpt-web/web-${index + 1}` })),
    ],
  }), "utf8");
  await writeFile(externalCatalogPath, JSON.stringify({
    schemaVersion: 1,
    target: "external",
    catalogRevision: "catalog-external-revision",
    models: externalModels,
  }), "utf8");

  const sent = [];
  const starts = [];
  let closed = 0;
  const service = await startGatewayDaemonService({
    configPath: fx.configPath,
    codexCatalogPath,
    externalCatalogPath,
    leaseId: "lease-daemon-1",
    pid: 7001,
    send: (value) => sent.push(value),
    gatewayFactory: (options, target) => {
      starts.push({ options, target });
      return {
        start: async ({ models }) => ({
          baseUrl: target === "codex"
            ? "http://127.0.0.1:45678"
            : "http://127.0.0.1:45679",
          models,
          authorizationHeaders: () => ({
            authorization: `Bearer fixture-${target}-consumer-capability`,
          }),
          close: async () => { closed += 1; },
        }),
      };
    },
  });

  assert.equal(starts.length, 2);
  assert.equal(
    starts[0].options.routerBaseUrl,
    `http://127.0.0.1:43123/_codex-router/${ROUTER_SECRET}/v1/`,
  );
  assert.deepEqual(starts.map((entry) => entry.target), ["codex", "external"]);
  assert.deepEqual(sent, [{
    type: "ready",
    leaseId: "lease-daemon-1",
    pid: 7001,
    codex: {
      baseUrl: "http://127.0.0.1:45678",
      capability: "fixture-codex-consumer-capability",
      modelCount: 15,
      catalogRevision: "catalog-codex-revision",
    },
    external: {
      baseUrl: "http://127.0.0.1:45679",
      capability: "fixture-external-consumer-capability",
      modelCount: 10,
      catalogRevision: "catalog-external-revision",
    },
  }]);

  await service.close();
  await service.close();
  assert.equal(closed, 2);
});

test("external Gateway lease 拒绝手写 chatgpt-web slug", async () => {
  const fx = await fixture();
  const codexCatalogPath = path.join(fx.stateRoot, "router-catalog-codex.json");
  const externalCatalogPath = path.join(fx.stateRoot, "router-catalog-external.json");
  await writeFile(codexCatalogPath, JSON.stringify({
    schemaVersion: 1,
    target: "codex",
    catalogRevision: "codex-r1",
    models: [{ id: "provider/api-model" }, { id: "chatgpt-web/light" }],
  }), "utf8");
  await writeFile(externalCatalogPath, JSON.stringify({
    schemaVersion: 1,
    target: "external",
    catalogRevision: "external-r1",
    models: [{ id: "provider/api-model" }],
  }), "utf8");
  const sent = [];
  const service = await startGatewayDaemonService({
    configPath: fx.configPath,
    codexCatalogPath,
    externalCatalogPath,
    leaseId: "lease-external-reject",
    pid: 7002,
    send: (value) => sent.push(value),
  });
  try {
    const ready = sent[0];
    const response = await fetch(`${ready.external.baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ready.external.capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "chatgpt-web/light", input: "must-not-forward" }),
    });
    assert.equal(response.status, 403);
  } finally {
    await service.close();
  }
});

test("Harness 清理只删除指纹匹配的受管文件，保留未知与已改写内容", async () => {
  const fx = await fixture();
  const harnessRoot = path.join(fx.stateRoot, "leases", "lease-config-cleanup", "harnesses");
  const published = await publishHarnessConfigs({
    root: harnessRoot,
    gatewayBaseUrl: "http://127.0.0.1:45683",
    models: [{ id: "provider/api-model", context_window: 1_000_000 }],
    loopbackPortAllocator: async () => 49323,
  });
  const managed = published.ownership.files[0].path;
  const unknown = path.join(path.dirname(managed), "session-owned.jsonl");
  await writeFile(managed, "harness rewrote this file\n", "utf8");
  await writeFile(unknown, "unknown runtime state\n", "utf8");

  const result = await restoreHarnessConfigs(published.ownership, {
    expectedRoot: harnessRoot,
  });
  assert.deepEqual(result.removed, published.ownership.files.slice(1).map((entry) => entry.path));
  assert.deepEqual(result.preserved, [managed]);
  assert.equal(await readFile(managed, "utf8"), "harness rewrote this file\n");
  assert.equal(await readFile(unknown, "utf8"), "unknown runtime state\n");
});

test("Harness 配置发布在 mkdir 前拒绝已有 reparse 祖先", async () => {
  const fx = await fixture();
  const target = path.join(fx.root, "junction-target");
  const link = path.join(fx.stateRoot, "junction-parent");
  await mkdir(target, { recursive: true });
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    publishHarnessConfigs({
      root: path.join(link, "must-not-create", "harnesses"),
      gatewayBaseUrl: "http://127.0.0.1:45684",
      models: [{ id: "provider/api-model" }],
      loopbackPortAllocator: async () => 49324,
    }),
    /harness_config_path_is_reparse_or_not_directory/,
  );
  await assert.rejects(stat(path.join(target, "must-not-create")), /ENOENT/);
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
        codex: {
          baseUrl: "http://127.0.0.1:45679",
          capability: "codex-consumer-launch-capability",
          modelCount: 2,
          catalogRevision: "catalog-codex-launch-revision",
        },
        external: {
          baseUrl: "http://127.0.0.1:45681",
          capability: "external-consumer-launch-capability",
          modelCount: 1,
          catalogRevision: "catalog-external-launch-revision",
        },
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
  const harnessRecords = [
    ["pi", "CODEXHOST_PI_COMMAND"],
    ["omp", "CODEXHOST_OMP_COMMAND"],
    ["deepseek-harness", "CODEXHOST_DEEPSEEK_HARNESS_COMMAND"],
    ["grok", "CODEXHOST_GROK_COMMAND"],
  ].map(([id, commandEnvironment]) => ({
    id,
    commandEnvironment,
    commandPath: path.join(fx.root, `${id}.cmd`),
  }));
  const harnesses = { list: async () => harnessRecords };
  await Promise.all(harnessRecords.map((record) => (
    writeFile(record.commandPath, "@echo off", "utf8")
  )));

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
    loopbackPortAllocator: async () => 49321,
    harnesses,
  });
  await Promise.all([
    runtime.catalogBridge.activate({ target: "codex", profile: fx.profile }),
    runtime.catalogBridge.activate({ target: "external", profile: fx.profile }),
  ]);

  const lease = await runtime.launcher.launch({ profile: fx.profile });
  assert.equal(lease.leaseId, "lease-runtime-1");
  assert.deepEqual(lease.processes, { gateway: 7101, codexHost: 7102 });
  assert.equal(JSON.stringify(lease).includes("codex-consumer-launch-capability"), false);
  assert.equal(JSON.stringify(lease).includes("external-consumer-launch-capability"), false);
  assert.equal(JSON.stringify(lease).includes(ROUTER_SECRET), false);

  const gatewaySpawn = spawnCalls[0];
  assert.equal(JSON.stringify(gatewaySpawn.args).includes(ROUTER_SECRET), false);
  assert.equal(JSON.stringify(gatewaySpawn.options.env).includes(ROUTER_SECRET), false);
  assert.deepEqual(gatewaySpawn.args.slice(-8), [
    "--config",
    fx.configPath,
    "--codex-catalog",
    path.join(fx.stateRoot, "router-catalog-codex.json"),
    "--external-catalog",
    path.join(fx.stateRoot, "router-catalog-external.json"),
    "--lease",
    "lease-runtime-1",
  ]);
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
  assert.equal(hostSpawn.options.env.CODEXHOST_CODEX_PROFILE, undefined);
  assert.deepEqual(
    hostSpawn.options.env.CODEXHOST_CODEX_CONFIG_OVERRIDES.split("\u001f"),
    [
      'model_provider="everyone-in-codex"',
      `model_catalog_json=${JSON.stringify(
        path.join(fx.stateRoot, "codex2-models.json").replaceAll("\\", "/"),
      )}`,
      'model_providers.everyone-in-codex.name="Everyone in Codex"',
      'model_providers.everyone-in-codex.base_url="http://127.0.0.1:45679/v1"',
      'model_providers.everyone-in-codex.wire_api="responses"',
      "model_providers.everyone-in-codex.requires_openai_auth=false",
      'model_providers.everyone-in-codex.env_key="EVERYONE_CODEX_LEASE_CAPABILITY"',
    ],
  );
  assert.equal(
    hostSpawn.options.env.EVERYONE_CODEX_LEASE_CAPABILITY,
    "codex-consumer-launch-capability",
  );
  assert.equal(
    hostSpawn.options.env.EVERYONE_CODEX_EXTERNAL_LEASE_CAPABILITY,
    "external-consumer-launch-capability",
  );
  assert.equal(hostSpawn.options.env.CODEXHOST_PI_COMMAND, path.join(fx.root, "pi.cmd"));
  const harnessRoot = path.join(fx.stateRoot, "leases", "lease-runtime-1", "harnesses");
  assert.equal(hostSpawn.options.env.CODEXHOST_PI_DATA_DIR, path.join(harnessRoot, "pi"));
  assert.equal(hostSpawn.options.env.CODEXHOST_OMP_DATA_DIR, path.join(harnessRoot, "omp"));
  assert.equal(hostSpawn.options.env.CODEXHOST_DSH_HOME, path.join(harnessRoot, "dsh"));
  assert.equal(hostSpawn.options.env.CODEXHOST_GROK_HOME, path.join(harnessRoot, "grok"));
  const projectedGrokModels = JSON.parse(hostSpawn.options.env.CODEXHOST_GROK_MODELS_JSON);
  assert.equal(projectedGrokModels.length, lease.externalModelCount);
  assert.equal(projectedGrokModels.some((model) => model.id.startsWith("chatgpt-web/")), false);
  assert.equal(
    projectedGrokModels.every((model) => model.id.startsWith("everyone-in-codex~")),
    true,
  );
  assert.equal(
    hostSpawn.options.env.CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT,
    "http://127.0.0.1:49321/",
  );

  const configFiles = {
    pi: path.join(harnessRoot, "pi", "models.json"),
    omp: path.join(harnessRoot, "omp", "models.yml"),
    dsh: path.join(harnessRoot, "dsh", "settings.yaml"),
    grok: path.join(harnessRoot, "grok", "config.toml"),
  };
  const configTexts = Object.fromEntries(await Promise.all(
    Object.entries(configFiles).map(async ([id, filePath]) => [id, await readFile(filePath, "utf8")]),
  ));
  for (const text of Object.values(configTexts)) {
    assert.match(text, /provider\/api-model/);
    assert.doesNotMatch(text, /chatgpt-web/);
    assert.match(text, /EVERYONE_CODEX_EXTERNAL_LEASE_CAPABILITY/);
    assert.doesNotMatch(text, /external-consumer-launch-capability/);
    assert.match(text, /http:\/\/127\.0\.0\.1:45681\/v1/);
  }
  const piConfig = JSON.parse(configTexts.pi);
  assert.equal(piConfig.providers["everyone-in-codex"].api, "openai-responses");
  assert.deepEqual(
    piConfig.providers["everyone-in-codex"].models[0],
    {
      id: "provider/api-model",
      name: "Provider API Model",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
    },
  );
  assert.match(configTexts.omp, /^providers:/m);
  assert.equal(
    configTexts.omp.includes(`apiKey: ${"EVERYONE_CODEX_"}EXTERNAL_LEASE_CAPABILITY`),
    true,
  );
  assert.doesNotMatch(configTexts.omp, /apiKey: \$EVERYONE/);
  assert.match(configTexts.dsh, /^llm-pi-ai:\n  providers:/m);
  assert.match(configTexts.dsh, /apiKeyEnv: EVERYONE_CODEX_EXTERNAL_LEASE_CAPABILITY/);
  assert.match(configTexts.dsh, /baseURL: "http:\/\/127\.0\.0\.1:45681\/v1"/);
  assert.match(configTexts.dsh, /reasoningEfforts:\n\s+low: low\n\s+high: high/);
  assert.doesNotMatch(configTexts.dsh, /^\s+(?:reasoning|input):/m);
  assert.equal(
    configTexts.grok.includes(`[model.${JSON.stringify(projectedGrokModels[0].id)}]`),
    true,
  );
  assert.match(configTexts.grok, /^model = "provider\/api-model"$/m);
  assert.match(configTexts.grok, /api_backend = "responses"/);
  assert.match(configTexts.grok, /"x-everyone-codex-harness" = "grok"/);

  const profile = await readFile(
    path.join(fx.profile.codexHome, "everyone-in-codex.config.toml"),
    "utf8",
  );
  assert.match(profile, /base_url = "http:\/\/127\.0\.0\.1:45679\/v1"/);

  const receiptText = await readFile(lease.receiptPath, "utf8");
  assert.equal(receiptText.includes("codex-consumer-launch-capability"), false);
  assert.equal(receiptText.includes("external-consumer-launch-capability"), false);
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
  for (const filePath of Object.values(configFiles)) {
    await assert.rejects(stat(filePath), /ENOENT/);
  }
  assert.deepEqual(await runtime.launcher.restore({ leaseId: lease.leaseId }), {
    restored: false,
    leaseId: "lease-runtime-1",
    stoppedPids: [],
  });
});

test("launch 就绪失败时按已捕获身份终止进程树并恢复 Profile", async () => {
  const fx = await fixture();
  const identities = new Map([
    [7201, {
      pid: 7201,
      executablePath: process.execPath,
      creationDate: "2026-08-30T00:10:01.000Z",
      commandLine: "node gateway-daemon.mjs --lease lease-failure",
    }],
    [7202, {
      pid: 7202,
      executablePath: fx.codexHostExecutable,
      creationDate: "2026-08-30T00:10:02.000Z",
      commandLine: "codexhost.exe launch --custom-install codex-2",
    }],
  ]);
  const terminated = [];
  let nextPid = 7201;
  const runtime = createLocalFusionRuntime({
    configPath: fx.configPath,
    stateRoot: fx.stateRoot,
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{ id: "provider/api-model" }, { id: "chatgpt-web/light" }],
    })),
    spawnImpl: (command, args) => {
      const child = new FakeChild(nextPid++);
      if (args.some((arg) => String(arg).endsWith("gateway-daemon.mjs"))) {
        const leaseId = args[args.indexOf("--lease") + 1];
        queueMicrotask(() => child.emit("message", {
          type: "ready",
          leaseId,
          pid: child.pid,
          codex: {
            baseUrl: "http://127.0.0.1:45680",
            capability: "failure-codex-consumer-capability",
            modelCount: 2,
            catalogRevision: "failure-codex-revision",
          },
          external: {
            baseUrl: "http://127.0.0.1:45682",
            capability: "failure-external-consumer-capability",
            modelCount: 1,
            catalogRevision: "failure-external-revision",
          },
        }));
      } else {
        queueMicrotask(() => child.emit("exit", 1, null));
      }
      return child;
    },
    processInspector: async (pid) => identities.get(pid) ?? null,
    processTerminator: async (identity) => {
      terminated.push(identity.pid);
      identities.delete(identity.pid);
      return { stopped: true };
    },
    randomId: () => "lease-failure",
    loopbackPortAllocator: async () => 49322,
    harnesses: { list: async () => [] },
  });
  await Promise.all([
    runtime.catalogBridge.activate({ target: "codex", profile: fx.profile }),
    runtime.catalogBridge.activate({ target: "external", profile: fx.profile }),
  ]);

  await assert.rejects(
    runtime.launcher.launch({ profile: fx.profile }),
    /codexhost_exited_before_ready/,
  );
  assert.deepEqual(terminated, [7202, 7201]);
  await assert.rejects(
    stat(path.join(fx.profile.codexHome, "everyone-in-codex.config.toml")),
    /ENOENT/,
  );
  await assert.rejects(
    stat(path.join(fx.stateRoot, "leases", "lease-failure", "harnesses", "pi", "models.json")),
    /ENOENT/,
  );
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
