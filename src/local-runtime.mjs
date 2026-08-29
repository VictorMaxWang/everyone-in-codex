import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { ProfileManager } from "./profile-manager.mjs";
import { RouterCatalogBridge } from "./router-catalog-bridge.mjs";

const execFileAsync = promisify(execFile);
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_NAME = "everyone-in-codex";
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPathKey(value) {
  return path.resolve(value).replaceAll("/", "\\").toLowerCase();
}

function samePath(left, right) {
  return normalizedPathKey(left) === normalizedPathKey(right);
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} 必须是绝对路径`);
  }
  return path.resolve(value);
}

function normalizeLoopbackUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 必须是有效 URL`);
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error(`${label} 必须是无凭据的 127.0.0.1 HTTP URL`);
  }
  return url;
}

function defaultConfigPath() {
  const configured = process.env.EVERYONE_CODEX_CONFIG;
  if (configured) return requireAbsolutePath(configured, "EVERYONE_CODEX_CONFIG");
  const configuredRoot = process.env.EVERYONE_CODEX_ROOT;
  return path.join(
    configuredRoot ? requireAbsolutePath(configuredRoot, "EVERYONE_CODEX_ROOT") : MODULE_ROOT,
    "fusion.local.json",
  );
}

function defaultStateRoot() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new Error("LOCALAPPDATA 必须是绝对路径");
  }
  return path.join(path.resolve(localAppData), "EveryoneCodex");
}

function resolveCodexHostExecutable(document, configDirectory) {
  const configured = document.runtime?.codexHostExecutable;
  if (configured !== undefined) {
    return requireAbsolutePath(configured, "runtime.codexHostExecutable");
  }
  const portable = path.join(configDirectory, "runtime", "codexhost", "bin", "codexhost.exe");
  const checkout = path.join(MODULE_ROOT, ".build", "codexhost", "payload", "bin", "codexhost.exe");
  return configDirectory === MODULE_ROOT ? checkout : portable;
}

function normalizeProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("fusion profile 缺失");
  const name = String(profile.name ?? "").trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error("fusion profile.name 不是安全标识符");
  }
  return Object.freeze({
    name,
    codexHome: requireAbsolutePath(profile.codexHome, "profile.codexHome"),
    sqliteHome: requireAbsolutePath(profile.sqliteHome, "profile.sqliteHome"),
    desktopRoot: requireAbsolutePath(profile.desktopRoot, "profile.desktopRoot"),
    desktopUserData: requireAbsolutePath(profile.desktopUserData, "profile.desktopUserData"),
  });
}

function normalizeFusionConfig(document, configPath) {
  if (!document || document.schemaVersion !== 1) {
    throw new Error("fusion config schemaVersion 不受支持");
  }
  const profile = normalizeProfile(document.profile);
  const router = document.router;
  if (!router || typeof router !== "object") throw new Error("fusion router 配置缺失");
  const healthUrl = normalizeLoopbackUrl(router.healthUrl, "router.healthUrl");
  const webgptHealthUrl = normalizeLoopbackUrl(
    document.webgpt?.healthUrl,
    "webgpt.healthUrl",
  );
  const configDirectory = path.dirname(configPath);
  const nodeExecutable = document.runtime?.nodeExecutable === undefined
    ? process.execPath
    : requireAbsolutePath(document.runtime.nodeExecutable, "runtime.nodeExecutable");
  const gatewayDaemonPath = document.runtime?.gatewayDaemonPath === undefined
    ? fileURLToPath(new URL("./gateway-daemon.mjs", import.meta.url))
    : requireAbsolutePath(document.runtime.gatewayDaemonPath, "runtime.gatewayDaemonPath");

  return Object.freeze({
    schemaVersion: 1,
    profile,
    router: Object.freeze({
      sourceRoot: requireAbsolutePath(router.sourceRoot, "router.sourceRoot"),
      stateDir: requireAbsolutePath(router.stateDir, "router.stateDir"),
      healthUrl: healthUrl.href,
    }),
    webgpt: Object.freeze({ healthUrl: webgptHealthUrl.href }),
    runtime: Object.freeze({
      codexHostExecutable: resolveCodexHostExecutable(document, configDirectory),
      nodeExecutable,
      gatewayDaemonPath,
    }),
  });
}

async function assertRegularFile(filePath, label) {
  const info = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} 不存在：${filePath}`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`${label} 必须是非链接普通文件`);
  }
  return filePath;
}

async function assertDirectory(directory, label) {
  const info = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} 不存在：${directory}`);
    throw error;
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} 必须是非链接目录`);
  }
  return directory;
}

async function assertRegularFileOrMissing(filePath) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("managed_path_is_not_a_regular_file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function writeTextAtomic(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await assertRegularFileOrMissing(filePath);
  const temporary = `${filePath}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readJsonRegular(filePath, label) {
  await assertRegularFile(filePath, label);
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON`, { cause: error });
  }
}

/** 读取并验证不含凭据的通用融合配置。 */
export async function readFusionConfig(configPath = defaultConfigPath()) {
  const resolved = requireAbsolutePath(configPath, "fusion configPath");
  return normalizeFusionConfig(await readJsonRegular(resolved, "fusion config"), resolved);
}

/** caller-secret 只在需要连接 Router 时短暂进入内存。 */
export async function readRouterCallerSecret(stateDir) {
  const secretPath = path.join(requireAbsolutePath(stateDir, "router.stateDir"), "caller-secret");
  await assertRegularFile(secretPath, "Router caller-secret");
  const secret = (await readFile(secretPath, "utf8")).trim();
  if (!SECRET_PATTERN.test(secret)) throw new Error("router_caller_secret_invalid");
  return secret;
}

/** 构造 Router 已定义的 path capability，不把 secret 搬到 header 或配置。 */
export function routerCapabilityBaseUrl(config, secret) {
  if (!SECRET_PATTERN.test(secret)) throw new Error("router_caller_secret_invalid");
  const health = normalizeLoopbackUrl(config.router.healthUrl, "router.healthUrl");
  health.pathname = `/_codex-router/${secret}/v1/`;
  return health.href;
}

function assertSameProfile(actual, expected) {
  if (
    !actual
    || actual.name !== expected.name
    || !samePath(actual.codexHome, expected.codexHome)
    || !samePath(actual.sqliteHome, expected.sqliteHome)
    || !samePath(actual.desktopRoot, expected.desktopRoot)
    || !samePath(actual.desktopUserData, expected.desktopUserData)
  ) {
    throw new Error("active_profile_does_not_match_fusion_config");
  }

  const primaryHome = path.join(os.homedir(), ".codex");
  if (
    samePath(actual.codexHome, primaryHome)
    || normalizedPathKey(actual.desktopRoot).includes("\\windowsapps\\")
    || new Set(["primary", "default", "codex1", "codex-1"]).has(actual.name)
  ) {
    throw new Error("codex_1_path_is_protected");
  }
  return actual;
}

function safeBaseEnvironment(source = process.env) {
  const names = [
    "APPDATA",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "SystemDrive",
    "SystemRoot",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  const result = {};
  for (const name of names) {
    if (typeof source[name] === "string") result[name] = source[name];
  }
  return result;
}

function safeLeaseId(value) {
  if (typeof value !== "string" || !LEASE_ID_PATTERN.test(value)) {
    throw new Error("invalid_lease_id");
  }
  return value;
}

function waitForGatewayReady(child, leaseId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.off?.("message", onMessage);
      child.off?.("error", onError);
      child.off?.("exit", onExit);
    };
    const settle = (callback, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      callback(value);
    };
    const onMessage = (message) => {
      if (
        message?.type !== "ready"
        || message.leaseId !== leaseId
        || message.pid !== child.pid
        || typeof message.capability !== "string"
        || message.capability.length < 16
      ) return;
      try {
        const url = normalizeLoopbackUrl(message.baseUrl, "Gateway baseUrl");
        if (url.pathname !== "/") throw new Error("gateway_ready_url_has_path");
        settle(resolve, { ...message, baseUrl: url.origin });
      } catch (error) {
        settle(reject, error);
      }
    };
    const onError = () => settle(reject, new Error("gateway_process_failed"));
    const onExit = () => settle(reject, new Error("gateway_process_exited_before_ready"));
    const timeout = setTimeout(
      () => settle(reject, new Error("gateway_ready_timeout")),
      timeoutMs,
    );
    timeout.unref?.();
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForCodexHostReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    let buffer = "";
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off?.("data", onData);
      child.off?.("error", onError);
      child.off?.("exit", onExit);
    };
    const settle = (callback, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      buffer = `${buffer}${chunk}`.slice(-1024);
      if (buffer.split(/\r?\n/).includes("ready")) settle(resolve);
    };
    const onError = () => settle(reject, new Error("codexhost_process_failed"));
    const onExit = () => settle(reject, new Error("codexhost_exited_before_ready"));
    const timeout = setTimeout(
      () => settle(reject, new Error("codexhost_ready_timeout")),
      timeoutMs,
    );
    timeout.unref?.();
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function defaultProcessInspector(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error("invalid_process_id");
  if (process.platform !== "win32") {
    try {
      process.kill(pid, 0);
      return {
        pid,
        executablePath: null,
        creationDate: null,
        commandLine: null,
      };
    } catch (error) {
      if (error?.code === "ESRCH") return null;
      throw error;
    }
  }

  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'`,
    "if ($null -eq $p) { exit 3 }",
    "$value = [ordered]@{",
    "  pid = [int]$p.ProcessId",
    "  executablePath = [string]$p.ExecutablePath",
    "  creationDate = $p.CreationDate.ToUniversalTime().ToString('o')",
    "  commandLine = [string]$p.CommandLine",
    "}",
    "$value | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("pwsh.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 });
    return JSON.parse(stdout.trim());
  } catch (error) {
    if (Number(error?.code) === 3) return null;
    throw new Error("process_identity_query_failed", { cause: error });
  }
}

async function defaultProcessTerminator(identity) {
  if (!Number.isInteger(identity?.pid) || identity.pid < 1) {
    throw new Error("invalid_process_id");
  }
  if (process.platform !== "win32") {
    try {
      process.kill(identity.pid, "SIGTERM");
      return { stopped: true };
    } catch (error) {
      if (error?.code === "ESRCH") return { stopped: false };
      throw error;
    }
  }
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(identity.pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    return { stopped: true };
  } catch (error) {
    if (Number(error?.code) === 128) return { stopped: false };
    throw new Error("owned_process_termination_failed", { cause: error });
  }
}

function publicProcessIdentity(identity) {
  if (
    !identity
    || !Number.isInteger(identity.pid)
    || typeof identity.executablePath !== "string"
    || !identity.executablePath
    || typeof identity.creationDate !== "string"
    || !identity.creationDate
    || typeof identity.commandLine !== "string"
    || !identity.commandLine
  ) {
    throw new Error("process_identity_incomplete");
  }
  return Object.freeze({
    pid: identity.pid,
    executablePath: path.resolve(identity.executablePath),
    creationDate: identity.creationDate,
    commandLineSha256: sha256(identity.commandLine),
  });
}

function assertOwnedProcess(current, receipt) {
  if (
    current.pid !== receipt.pid
    || !samePath(current.executablePath, receipt.executablePath)
    || current.creationDate !== receipt.creationDate
    || sha256(current.commandLine ?? "") !== receipt.commandLineSha256
  ) {
    throw new Error(`process_ownership_conflict:${receipt.pid}`);
  }
}

function parseCatalogSnapshot(document, expectedTarget = "codex") {
  if (
    document?.schemaVersion !== 1
    || document.target !== expectedTarget
    || typeof document.catalogRevision !== "string"
    || !Array.isArray(document.models)
  ) {
    throw new Error("catalog_snapshot_invalid");
  }
  const ids = new Set();
  const models = document.models.map((model) => {
    if (!model || typeof model.id !== "string" || !model.id || ids.has(model.id)) {
      throw new Error("catalog_snapshot_invalid");
    }
    ids.add(model.id);
    return { ...model };
  });
  return { ...document, models };
}

async function childKillBestEffort(child) {
  try {
    child?.kill?.("SIGTERM");
  } catch {
    // 启动回滚只触碰刚刚创建且仍持有句柄的子进程。
  }
}

/**
 * 生产本机边界：读取融合配置、发布安全目录快照，并精确拥有两个子进程。
 */
export class LocalFusionRuntime {
  constructor({
    configPath = defaultConfigPath(),
    stateRoot = defaultStateRoot(),
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    processInspector = defaultProcessInspector,
    processTerminator = defaultProcessTerminator,
    randomId = () => randomBytes(16).toString("hex"),
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    harnesses,
    sourceEnvironment = process.env,
  } = {}) {
    if (typeof fetchImpl !== "function" || typeof spawnImpl !== "function") {
      throw new Error("LocalFusionRuntime 需要 fetch 与 spawn 边界");
    }
    if (!harnesses || typeof harnesses.list !== "function") {
      throw new Error("LocalFusionRuntime 需要 HarnessRegistry");
    }
    this.configPath = requireAbsolutePath(configPath, "fusion configPath");
    this.stateRoot = requireAbsolutePath(stateRoot, "fusion stateRoot");
    this.leaseDirectory = path.join(this.stateRoot, "leases");
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.processInspector = processInspector;
    this.processTerminator = processTerminator;
    this.randomId = randomId;
    this.readyTimeoutMs = Math.max(1, Number(readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS);
    this.harnesses = harnesses;
    this.sourceEnvironment = sourceEnvironment;

    this.validationPolicy = Object.freeze({
      assert: async (profile) => this.#assertConfiguredProfile(profile),
    });
    this.preparer = Object.freeze({
      prepare: async ({ profile }) => this.#prepare(profile),
    });
    this.catalogBridge = Object.freeze({
      activate: async (input) => this.#syncModels(input),
      inspect: async () => this.#inspectCatalog(),
    });
    this.launcher = Object.freeze({
      launch: async ({ profile }) => this.#launch(profile),
      restore: async ({ leaseId }) => this.#restore(leaseId),
      inspect: async () => this.#inspectLeases(),
    });
  }

  async #config() {
    return readFusionConfig(this.configPath);
  }

  async #assertConfiguredProfile(profile) {
    const config = await this.#config();
    return assertSameProfile(profile, config.profile);
  }

  #snapshotPath(target) {
    return path.join(this.stateRoot, `router-catalog-${target}.json`);
  }

  #leasePath(leaseId) {
    return path.join(this.leaseDirectory, `${safeLeaseId(leaseId)}.json`);
  }

  async #prepare(profile) {
    const config = await this.#config();
    assertSameProfile(profile, config.profile);
    await Promise.all([
      assertDirectory(profile.codexHome, "Codex 2 HOME"),
      assertDirectory(profile.sqliteHome, "Codex 2 SQLite HOME"),
      assertDirectory(profile.desktopRoot, "Codex 2 Desktop clone"),
      assertDirectory(profile.desktopUserData, "Codex 2 Desktop user data"),
      assertDirectory(config.router.stateDir, "Router state directory"),
      assertRegularFile(config.runtime.codexHostExecutable, "patched CodexHost"),
      assertRegularFile(config.runtime.nodeExecutable, "Node runtime"),
      assertRegularFile(config.runtime.gatewayDaemonPath, "Gateway daemon"),
    ]);
    await Promise.all([
      mkdir(this.stateRoot, { recursive: true }),
      mkdir(this.leaseDirectory, { recursive: true }),
      mkdir(path.join(this.stateRoot, "codexhost", profile.name), { recursive: true }),
    ]);
    return Object.freeze({
      prepared: true,
      profile: profile.name,
      stateRoot: this.stateRoot,
      codexHostExecutable: config.runtime.codexHostExecutable,
    });
  }

  async #syncModels({ target = "codex", profile } = {}) {
    if (!new Set(["codex", "external"]).has(target)) {
      throw new Error(`未知模型发布目标：${target}`);
    }
    const config = await this.#config();
    assertSameProfile(profile, config.profile);
    const callerSecret = await readRouterCallerSecret(config.router.stateDir);
    const routerBaseUrl = routerCapabilityBaseUrl(config, callerSecret);
    const bridge = new RouterCatalogBridge({
      mergedModelsPath: path.join(config.router.stateDir, "merged-models.json"),
      modelPickerPath: path.join(config.router.stateDir, "model-picker.json"),
      routerModelsUrl: new URL("models", routerBaseUrl).href,
      fetchImpl: this.fetchImpl,
    });
    const activated = await bridge.activate({ target });
    const snapshotPath = this.#snapshotPath(target);
    const snapshot = {
      schemaVersion: 1,
      target,
      consumer: activated.consumer,
      catalogRevision: activated.catalogRevision,
      models: activated.models,
    };
    await writeTextAtomic(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    return Object.freeze({
      target,
      snapshotPath,
      catalogRevision: activated.catalogRevision,
      modelCount: activated.models.length,
      allowedModelIds: Object.freeze([...activated.allowedModelIds]),
    });
  }

  async #inspectCatalog() {
    const result = {};
    for (const target of ["codex", "external"]) {
      const snapshotPath = this.#snapshotPath(target);
      try {
        const snapshot = parseCatalogSnapshot(
          await readJsonRegular(snapshotPath, `${target} catalog snapshot`),
          target,
        );
        result[target] = {
          snapshotPath,
          catalogRevision: snapshot.catalogRevision,
          modelCount: snapshot.models.length,
        };
      } catch (error) {
        if (error?.cause?.code === "ENOENT" || error?.code === "ENOENT") continue;
        if (String(error?.message).includes("不存在")) continue;
        throw error;
      }
    }
    return result;
  }

  async #activeLeaseFiles() {
    try {
      return (await readdir(this.leaseDirectory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && LEASE_ID_PATTERN.test(entry.name.replace(/\.json$/, "")))
        .filter((entry) => entry.name.endsWith(".json"))
        .map((entry) => path.join(this.leaseDirectory, entry.name));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async #inspectLeases() {
    const leases = [];
    for (const filePath of await this.#activeLeaseFiles()) {
      const receipt = await readJsonRegular(filePath, "fusion lease receipt");
      leases.push({
        leaseId: receipt.leaseId,
        profile: receipt.profile?.name ?? null,
        processes: Object.fromEntries(
          (receipt.processes ?? []).map((entry) => [entry.role, entry.pid]),
        ),
      });
    }
    return { running: leases.length > 0, leases };
  }

  async #captureProcess(child, expectedExecutable, role) {
    if (!Number.isInteger(child?.pid) || child.pid < 1) {
      throw new Error(`${role}_process_has_no_pid`);
    }
    const current = await this.processInspector(child.pid);
    const receipt = publicProcessIdentity(current);
    if (!samePath(receipt.executablePath, expectedExecutable)) {
      throw new Error(`${role}_process_executable_mismatch`);
    }
    return { role, ...receipt };
  }

  async #launch(profile) {
    const config = await this.#config();
    assertSameProfile(profile, config.profile);
    if ((await this.#activeLeaseFiles()).length > 0) {
      throw new Error("fusion_lease_already_active");
    }
    const snapshotPath = this.#snapshotPath("codex");
    const snapshot = parseCatalogSnapshot(
      await readJsonRegular(snapshotPath, "codex catalog snapshot"),
      "codex",
    );
    await this.#prepare(profile);

    const leaseId = safeLeaseId(this.randomId());
    const gatewayArgs = [
      config.runtime.gatewayDaemonPath,
      "--config",
      this.configPath,
      "--catalog",
      snapshotPath,
      "--lease",
      leaseId,
    ];
    const gatewayChild = this.spawnImpl(config.runtime.nodeExecutable, gatewayArgs, {
      cwd: MODULE_ROOT,
      env: safeBaseEnvironment(this.sourceEnvironment),
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    let hostChild = null;
    let profileManager = null;
    try {
      const gatewayReady = await waitForGatewayReady(
        gatewayChild,
        leaseId,
        this.readyTimeoutMs,
      );
      const gatewayIdentity = await this.#captureProcess(
        gatewayChild,
        config.runtime.nodeExecutable,
        "gateway",
      );

      profileManager = new ProfileManager({ codexHome: profile.codexHome, stateDir: this.stateRoot });
      const profileReceipt = await profileManager.publish({
        gatewayBaseUrl: gatewayReady.baseUrl,
        models: snapshot.models,
      });

      const environment = {
        ...safeBaseEnvironment(this.sourceEnvironment),
        CODEX_HOME: profile.codexHome,
        CODEX_SQLITE_HOME: profile.sqliteHome,
        CODEXHOST_DATA_DIR: path.join(this.stateRoot, "codexhost", profile.name),
        CODEXHOST_CODEX_PROFILE: PROFILE_NAME,
        EVERYONE_CODEX_LEASE_CAPABILITY: gatewayReady.capability,
      };
      for (const harness of await this.harnesses.list()) {
        if (
          typeof harness.commandEnvironment === "string"
          && typeof harness.commandPath === "string"
          && path.isAbsolute(harness.commandPath)
        ) {
          environment[harness.commandEnvironment] = harness.commandPath;
        }
      }

      const hostArgs = [
        "launch",
        "--custom-install",
        profile.desktopRoot,
        "--desktop-user-data-dir",
        profile.desktopUserData,
      ];
      hostChild = this.spawnImpl(config.runtime.codexHostExecutable, hostArgs, {
        cwd: path.dirname(config.runtime.codexHostExecutable),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      await waitForCodexHostReady(hostChild, this.readyTimeoutMs);
      const hostIdentity = await this.#captureProcess(
        hostChild,
        config.runtime.codexHostExecutable,
        "codexHost",
      );

      const receiptPath = this.#leasePath(leaseId);
      const receipt = {
        schemaVersion: 1,
        leaseId,
        profile,
        gatewayBaseUrl: gatewayReady.baseUrl,
        catalogRevision: snapshot.catalogRevision,
        profileOwnership: profileReceipt,
        processes: [gatewayIdentity, hostIdentity],
      };
      await writeTextAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      return Object.freeze({
        leaseId,
        receiptPath,
        gatewayBaseUrl: gatewayReady.baseUrl,
        catalogRevision: snapshot.catalogRevision,
        modelCount: snapshot.models.length,
        processes: Object.freeze({ gateway: gatewayChild.pid, codexHost: hostChild.pid }),
      });
    } catch (error) {
      await childKillBestEffort(hostChild);
      await childKillBestEffort(gatewayChild);
      await profileManager?.restore().catch(() => {});
      throw error;
    }
  }

  async #restore(leaseIdValue) {
    const leaseId = safeLeaseId(leaseIdValue);
    const receiptPath = this.#leasePath(leaseId);
    let receipt;
    try {
      receipt = await readJsonRegular(receiptPath, "fusion lease receipt");
    } catch (error) {
      if (String(error?.message).includes("不存在")) {
        return { restored: false, leaseId, stoppedPids: [] };
      }
      throw error;
    }
    if (
      receipt?.schemaVersion !== 1
      || receipt.leaseId !== leaseId
      || !Array.isArray(receipt.processes)
      || !receipt.profile
    ) {
      throw new Error("fusion_lease_receipt_invalid");
    }

    const ordered = [...receipt.processes].sort((left, right) => {
      const rank = { codexHost: 0, gateway: 1 };
      return (rank[left.role] ?? 9) - (rank[right.role] ?? 9);
    });
    const stoppedPids = [];
    for (const owned of ordered) {
      const current = await this.processInspector(owned.pid);
      if (!current) continue;
      assertOwnedProcess(current, owned);
      const result = await this.processTerminator(current);
      if (result?.stopped !== false) stoppedPids.push(owned.pid);
    }

    const manager = new ProfileManager({
      codexHome: receipt.profile.codexHome,
      stateDir: this.stateRoot,
    });
    await manager.restore();
    await unlink(receiptPath);
    return { restored: true, leaseId, stoppedPids };
  }
}

export function createLocalFusionRuntime(options = {}) {
  return new LocalFusionRuntime(options);
}
