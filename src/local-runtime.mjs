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
import {
  fetchCodex2NativeCatalog,
  parseCodex2AuthJson,
} from "./codex2-native-catalog.mjs";
import {
  publishHarnessConfigs,
  reserveLoopbackPort,
  restoreHarnessConfigs,
} from "./harness-configs.mjs";

const execFileAsync = promisify(execFile);
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Windows 冷启动会同时拉起 Electron、Shim 与官方 app-server；实机可超过 30 秒，
// 因而给首次启动留出 90 秒，同时仍由单一总超时约束失败清理。
const DEFAULT_READY_TIMEOUT_MS = 90_000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ROUTED_HARNESS_IDS = Object.freeze([
  "pi", "omp", "deepseek-harness", "grok", "claude-code",
]);

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

/**
 * 为 Codex app-server 生成一次性配置覆盖。
 *
 * 命名 Profile 的 `-p` 只适用于部分运行命令，不能用于 Desktop 启动的
 * `app-server`。这里仅投影融合层拥有的七个键，并用单个不可见分隔符交给
 * CodexHost shim；shim 会再次按键名白名单校验后展开为重复的 `-c` 参数。
 */
function encodeCodexConfigOverrides({ gatewayBaseUrl, catalogPath }) {
  const gateway = normalizeLoopbackUrl(gatewayBaseUrl, "Fusion Gateway 地址");
  const normalizedCatalogPath = requireAbsolutePath(
    catalogPath,
    "Codex 2 模型目录",
  ).replaceAll("\\", "/");
  const quote = (value) => JSON.stringify(String(value));
  return [
    'model_provider="everyone-in-codex"',
    `model_catalog_json=${quote(normalizedCatalogPath)}`,
    'model_providers.everyone-in-codex.name="Everyone in Codex"',
    `model_providers.everyone-in-codex.base_url=${quote(`${gateway.origin}/v1`)}`,
    'model_providers.everyone-in-codex.wire_api="responses"',
    "model_providers.everyone-in-codex.requires_openai_auth=false",
    'model_providers.everyone-in-codex.env_key="EVERYONE_CODEX_LEASE_CAPABILITY"',
  ].join("\u001f");
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
  let nativeOpenAiBaseUrl = null;
  if (document.nativeOpenAi
    && (Object.hasOwn(document.nativeOpenAi, "validationAuthPath")
      || Object.hasOwn(document.nativeOpenAi, "validationOnly"))) {
    throw new Error("cross_profile_auth_forbidden");
  }
  if (document.nativeOpenAi?.apiBaseUrl !== undefined) {
    const candidate = new URL(document.nativeOpenAi.apiBaseUrl);
    if (
      candidate.protocol !== "https:"
      || candidate.hostname !== "api.openai.com"
      || candidate.username
      || candidate.password
      || candidate.search
      || candidate.hash
    ) {
      throw new Error("nativeOpenAi.apiBaseUrl 必须是无凭据的 api.openai.com HTTPS URL");
    }
    candidate.pathname = `${candidate.pathname.replace(/\/$/u, "")}/`;
    nativeOpenAiBaseUrl = candidate.href;
  }
  return Object.freeze({
    schemaVersion: 1,
    profile,
    router: Object.freeze({
      sourceRoot: requireAbsolutePath(router.sourceRoot, "router.sourceRoot"),
      stateDir: requireAbsolutePath(router.stateDir, "router.stateDir"),
      healthUrl: healthUrl.href,
    }),
    webgpt: Object.freeze({ healthUrl: webgptHealthUrl.href }),
    nativeOpenAi: Object.freeze({
      apiBaseUrl: nativeOpenAiBaseUrl,
    }),
    runtime: Object.freeze({
      codexHostExecutable: resolveCodexHostExecutable(document, configDirectory),
      nodeExecutable,
      gatewayDaemonPath,
    }),
  });
}

function normalizePolicyPaths(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} 必须是非空绝对路径数组`);
  }
  const normalized = values.map((value, index) => requireAbsolutePath(value, `${label}[${index}]`));
  if (new Set(normalized.map(normalizedPathKey)).size !== normalized.length) {
    throw new Error(`${label} 包含重复路径`);
  }
  return Object.freeze(normalized);
}

function normalizeValidationPolicy(document) {
  if (!document || document.schemaVersion !== 1) {
    throw new Error("validation policy schemaVersion 不受支持");
  }
  return Object.freeze({
    allowedCodexHomes: normalizePolicyPaths(
      document.allowedCodexHomes,
      "allowedCodexHomes",
    ),
    allowedDesktopRoots: normalizePolicyPaths(
      document.allowedDesktopRoots,
      "allowedDesktopRoots",
    ),
    protectedCodexHomes: normalizePolicyPaths(
      document.protectedCodexHomes,
      "protectedCodexHomes",
    ),
    protectedDesktopRoots: normalizePolicyPaths(
      document.protectedDesktopRoots,
      "protectedDesktopRoots",
    ),
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
  // 末级目录正常并不代表祖先安全；Windows Junction 也会改变真实写入边界。
  const root = path.parse(directory).root;
  let current = root;
  for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const ancestor = await lstat(current);
    if (ancestor.isSymbolicLink()) {
      throw new Error(`${label} 的祖先包含 reparse/symlink：${current}`);
    }
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

/** 读取 Codex 1/2 路径隔离策略；本机策略必须显式存在，禁止隐式放宽。 */
export async function readValidationPolicy(policyPath) {
  const resolved = requireAbsolutePath(policyPath, "validation policyPath");
  return normalizeValidationPolicy(await readJsonRegular(resolved, "validation policy"));
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

function sameOrWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertProfileAllowed(profile, policy) {
  const allowedCodex = new Set(policy.allowedCodexHomes.map(normalizedPathKey));
  const allowedDesktop = new Set(policy.allowedDesktopRoots.map(normalizedPathKey));
  if (
    !allowedCodex.has(normalizedPathKey(profile.codexHome))
    || !allowedCodex.has(normalizedPathKey(profile.sqliteHome))
    || !allowedDesktop.has(normalizedPathKey(profile.desktopRoot))
    || !allowedDesktop.has(normalizedPathKey(profile.desktopUserData))
  ) {
    throw new Error("profile_path_is_not_explicitly_allowlisted");
  }
  if (
    [profile.codexHome, profile.sqliteHome].some((candidate) => (
      policy.protectedCodexHomes.some((root) => sameOrWithin(candidate, root))
    ))
    || [profile.desktopRoot, profile.desktopUserData].some((candidate) => (
      policy.protectedDesktopRoots.some((root) => sameOrWithin(candidate, root))
    ))
  ) {
    throw new Error("codex_1_path_is_protected");
  }
  return profile;
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

function codexHostFusionModels(models) {
  return models.map((model) => ({
    id: model.id,
    displayName: String(model.display_name ?? model.name ?? model.id),
    reasoningLevels: [...new Set((Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
        .map((entry) => (typeof entry === "string" ? entry : entry?.effort))
        .filter((entry) => typeof entry === "string")
      : [])
      .map((level) => (level === "ultra" ? "max" : level)))],
  }));
}

async function defaultCodex2NativeCatalogProvider({ profile, sourceEnvironment, config }) {
  const codexExecutable = path.join(profile.desktopRoot, "app", "resources", "codex.exe");
  const authPath = path.join(profile.codexHome, "auth.json");
  await Promise.all([
    assertRegularFile(codexExecutable, "Codex 2 CLI"),
    assertRegularFile(authPath, "Codex 2 auth.json"),
  ]);
  // 先验证 Codex 2 会话可用；目录发布不得因为 Router 自己的 Codex 1 fallback
  // 看似在线而把当前 Profile 实际无法消费的原生模型暴露给 Harness。
  const session = parseCodex2AuthJson(await readFile(authPath, "utf8"));
  if (session.kind === "oauth") {
    const { stdout } = await execFileAsync(codexExecutable, ["--version"], {
      cwd: profile.desktopRoot,
      env: safeBaseEnvironment(sourceEnvironment),
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
    });
    const clientVersion = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\s|$)/u.exec(stdout)?.[1];
    if (!clientVersion) throw new Error("codex2_native_client_version_invalid");
    return fetchCodex2NativeCatalog(session, { clientVersion });
  }
  if (session.kind === "api-key" && !config?.nativeOpenAi?.apiBaseUrl) {
    // 自定义 Provider 的 key 不能被误当成 OpenAI key；没有显式官方端点时隐藏原生行。
    return { models: [] };
  }
  const { stdout } = await execFileAsync(codexExecutable, ["debug", "models", "--bundled"], {
    cwd: profile.desktopRoot,
    env: {
      ...safeBaseEnvironment(sourceEnvironment),
      CODEX_HOME: profile.codexHome,
      CODEX_SQLITE_HOME: profile.sqliteHome,
    },
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  let document;
  try {
    document = JSON.parse(stdout);
  } catch (error) {
    throw new Error("codex2_native_catalog_invalid", { cause: error });
  }
  if (!Array.isArray(document) && !Array.isArray(document?.models)) {
    throw new Error("codex2_native_catalog_invalid");
  }
  return document;
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
      ) return;
      try {
        const normalizeLease = (lease, target) => {
          const expectedProtocol = target === "claude-code"
            ? "anthropic-messages"
            : "openai-responses";
          if (
            typeof lease?.capability !== "string"
            || lease.capability.length < 16
            || !Number.isInteger(lease.modelCount)
            || lease.modelCount < 1
            || typeof lease.catalogRevision !== "string"
            || !lease.catalogRevision
            || lease.protocol !== expectedProtocol
          ) {
            throw new Error(`gateway_${target}_ready_invalid`);
          }
          const url = normalizeLoopbackUrl(lease.baseUrl, `${target} Gateway baseUrl`);
          if (url.pathname !== "/") throw new Error("gateway_ready_url_has_path");
          return { ...lease, baseUrl: url.origin };
        };
        const harnesses = Object.fromEntries(ROUTED_HARNESS_IDS.map((harnessId) => [
          harnessId,
          normalizeLease(message.harnesses?.[harnessId], harnessId),
        ]));
        if (
          typeof message.control?.capability !== "string"
          || message.control.capability.length < 16
        ) {
          throw new Error("gateway_control_ready_invalid");
        }
        const controlUrl = normalizeLoopbackUrl(
          message.control.baseUrl,
          "Gateway control baseUrl",
        );
        if (controlUrl.pathname !== "/") throw new Error("gateway_ready_url_has_path");
        settle(resolve, {
          ...message,
          codex: normalizeLease(message.codex, "codex"),
          harnesses,
          control: { ...message.control, baseUrl: controlUrl.origin },
        });
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
  ].join("\n");
  try {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const candidates = [
      path.join(programFiles, "PowerShell", "7", "pwsh.exe"),
      "pwsh.exe",
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ];
    let stdout = null;
    let lastMissingError = null;
    const uniqueCandidates = candidates.filter((candidate, index) => (
      candidates.findIndex((value) => value.toLowerCase() === candidate.toLowerCase()) === index
    ));
    for (const executable of uniqueCandidates) {
      try {
        ({ stdout } = await execFileAsync(executable, [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          script,
        ], { windowsHide: true, encoding: "utf8", maxBuffer: 64 * 1024 }));
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        lastMissingError = error;
      }
    }
    if (stdout === null) throw lastMissingError ?? new Error("PowerShell runtime missing");
    return JSON.parse(stdout.trim());
  } catch (error) {
    if (Number(error?.code) === 3) return null;
    throw new Error("process_identity_query_failed", { cause: error });
  }
}

/** 公开只读的脱敏进程凭据；原始命令行始终只留在当前函数栈内。 */
export async function inspectProcessIdentity(pid) {
  const identity = await defaultProcessInspector(pid);
  return identity ? publicProcessIdentity(identity) : null;
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
    validationPolicyPath,
    stateRoot = defaultStateRoot(),
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    processInspector = defaultProcessInspector,
    processTerminator = defaultProcessTerminator,
    randomId = () => randomBytes(16).toString("hex"),
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    harnesses,
    sourceEnvironment = process.env,
    loopbackPortAllocator = reserveLoopbackPort,
    nativeCatalogProvider = defaultCodex2NativeCatalogProvider,
  } = {}) {
    if (typeof fetchImpl !== "function" || typeof spawnImpl !== "function") {
      throw new Error("LocalFusionRuntime 需要 fetch 与 spawn 边界");
    }
    if (!harnesses || typeof harnesses.list !== "function") {
      throw new Error("LocalFusionRuntime 需要 HarnessRegistry");
    }
    this.configPath = requireAbsolutePath(configPath, "fusion configPath");
    this.validationPolicyPath = requireAbsolutePath(
      validationPolicyPath ?? path.join(path.dirname(this.configPath), "validation-policy.local.json"),
      "validation policyPath",
    );
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
    if (typeof loopbackPortAllocator !== "function") {
      throw new Error("LocalFusionRuntime 需要回环端口分配器");
    }
    this.loopbackPortAllocator = loopbackPortAllocator;
    if (typeof nativeCatalogProvider !== "function") {
      throw new Error("LocalFusionRuntime 需要 Codex 2 native catalog provider");
    }
    this.nativeCatalogProvider = nativeCatalogProvider;

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
    const [config, policy] = await Promise.all([
      this.#config(),
      readValidationPolicy(this.validationPolicyPath),
    ]);
    assertProfileAllowed(assertSameProfile(profile, config.profile), policy);
    await Promise.all([
      assertDirectory(profile.codexHome, "Codex 2 HOME"),
      assertDirectory(profile.sqliteHome, "Codex 2 SQLite HOME"),
      assertDirectory(profile.desktopRoot, "Codex 2 Desktop clone"),
      assertDirectory(profile.desktopUserData, "Codex 2 Desktop user data"),
    ]);
    return profile;
  }

  #snapshotPath(target) {
    return path.join(this.stateRoot, `router-catalog-${target}.json`);
  }

  #leasePath(leaseId) {
    return path.join(this.leaseDirectory, `${safeLeaseId(leaseId)}.json`);
  }

  async #prepare(profile) {
    const config = await this.#config();
    await this.#assertConfiguredProfile(profile);
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
    await this.#assertConfiguredProfile(profile);
    const callerSecret = await readRouterCallerSecret(config.router.stateDir);
    const routerBaseUrl = routerCapabilityBaseUrl(config, callerSecret);
    let nativeCatalog = { models: [] };
    try {
      nativeCatalog = await this.nativeCatalogProvider({
        profile,
        config,
        sourceEnvironment: this.sourceEnvironment,
      });
    } catch {
      // 目录刷新必须失败关闭：账号失效时隐藏原生项，但仍发布 API/WebGPT。
      nativeCatalog = { models: [] };
    }
    const bridge = new RouterCatalogBridge({
      mergedModelsPath: path.join(config.router.stateDir, "merged-models.json"),
      modelPickerPath: path.join(config.router.stateDir, "model-picker.json"),
      routerModelsUrl: new URL("models", routerBaseUrl).href,
      fetchImpl: this.fetchImpl,
      nativeCatalog,
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

  async #terminateLaunchProcess(child, expectedExecutable, captured) {
    if (!Number.isInteger(child?.pid) || child.pid < 1) return;
    const current = await this.processInspector(child.pid);
    if (!current) return;
    if (captured) {
      assertOwnedProcess(current, captured);
    } else if (!samePath(current.executablePath, expectedExecutable)) {
      throw new Error(`launch_cleanup_process_ownership_conflict:${child.pid}`);
    }
    await this.processTerminator(current);
  }

  async #launch(profile) {
    const config = await this.#config();
    await this.#assertConfiguredProfile(profile);
    if ((await this.#activeLeaseFiles()).length > 0) {
      throw new Error("fusion_lease_already_active");
    }
    const codexSnapshotPath = this.#snapshotPath("codex");
    const externalSnapshotPath = this.#snapshotPath("external");
    const [codexSnapshot, externalSnapshot] = await Promise.all([
      readJsonRegular(codexSnapshotPath, "codex catalog snapshot")
        .then((value) => parseCatalogSnapshot(value, "codex")),
      readJsonRegular(externalSnapshotPath, "external catalog snapshot")
        .then((value) => parseCatalogSnapshot(value, "external")),
    ]);
    await this.#prepare(profile);

    const leaseId = safeLeaseId(this.randomId());
    const gatewayArgs = [
      config.runtime.gatewayDaemonPath,
      "--config",
      this.configPath,
      "--codex-catalog",
      codexSnapshotPath,
      "--external-catalog",
      externalSnapshotPath,
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
    let gatewayIdentity = null;
    let hostIdentity = null;
    let profileManager = null;
    let harnessConfigOwnership = null;
    try {
      const gatewayReadyPromise = waitForGatewayReady(
        gatewayChild,
        leaseId,
        this.readyTimeoutMs,
      );
      gatewayReadyPromise.catch(() => {});
      gatewayIdentity = await this.#captureProcess(
        gatewayChild,
        config.runtime.nodeExecutable,
        "gateway",
      );
      const gatewayReady = await gatewayReadyPromise;
      profileManager = new ProfileManager({ codexHome: profile.codexHome, stateDir: this.stateRoot });
      const profileReceipt = await profileManager.publish({
        gatewayBaseUrl: gatewayReady.codex.baseUrl,
        models: codexSnapshot.models,
      });
      const harnessConfig = await publishHarnessConfigs({
        root: path.join(this.leaseDirectory, leaseId, "harnesses"),
        gatewayBaseUrls: {
          pi: gatewayReady.harnesses.pi.baseUrl,
          omp: gatewayReady.harnesses.omp.baseUrl,
          "deepseek-harness": gatewayReady.harnesses["deepseek-harness"].baseUrl,
          grok: gatewayReady.harnesses.grok.baseUrl,
        },
        models: externalSnapshot.models,
        loopbackPortAllocator: this.loopbackPortAllocator,
      });
      harnessConfigOwnership = harnessConfig.ownership;

      const environment = {
        ...safeBaseEnvironment(this.sourceEnvironment),
        ...harnessConfig.environment,
        CODEX_HOME: profile.codexHome,
        CODEX_SQLITE_HOME: profile.sqliteHome,
        CODEXHOST_DATA_DIR: path.join(this.stateRoot, "codexhost", profile.name),
        CODEXHOST_CODEX_CONFIG_OVERRIDES: encodeCodexConfigOverrides({
          gatewayBaseUrl: gatewayReady.codex.baseUrl,
          catalogPath: profileReceipt.catalogPath,
        }),
        EVERYONE_CODEX_LEASE_CAPABILITY: gatewayReady.codex.capability,
        EVERYONE_CODEX_PI_LEASE_CAPABILITY: gatewayReady.harnesses.pi.capability,
        EVERYONE_CODEX_PI_BASE_URL: gatewayReady.harnesses.pi.baseUrl,
        EVERYONE_CODEX_OMP_LEASE_CAPABILITY: gatewayReady.harnesses.omp.capability,
        EVERYONE_CODEX_OMP_BASE_URL: gatewayReady.harnesses.omp.baseUrl,
        EVERYONE_CODEX_DSH_LEASE_CAPABILITY:
          gatewayReady.harnesses["deepseek-harness"].capability,
        EVERYONE_CODEX_DSH_BASE_URL:
          gatewayReady.harnesses["deepseek-harness"].baseUrl,
        EVERYONE_CODEX_GROK_LEASE_CAPABILITY: gatewayReady.harnesses.grok.capability,
        EVERYONE_CODEX_GROK_BASE_URL: gatewayReady.harnesses.grok.baseUrl,
        EVERYONE_CODEX_CLAUDE_LEASE_CAPABILITY:
          gatewayReady.harnesses["claude-code"].capability,
        EVERYONE_CODEX_CLAUDE_BASE_URL: gatewayReady.harnesses["claude-code"].baseUrl,
        EVERYONE_CODEX_HOST_CONTROL_URL: gatewayReady.control.baseUrl,
        EVERYONE_CODEX_HOST_CONTROL_CAPABILITY: gatewayReady.control.capability,
        CODEXHOST_FUSION_MODELS_JSON: JSON.stringify(
          codexHostFusionModels(externalSnapshot.models),
        ),
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
      const hostReadyPromise = waitForCodexHostReady(hostChild, this.readyTimeoutMs);
      hostReadyPromise.catch(() => {});
      hostIdentity = await this.#captureProcess(
        hostChild,
        config.runtime.codexHostExecutable,
        "codexHost",
      );
      await hostReadyPromise;

      const receiptPath = this.#leasePath(leaseId);
      const receipt = {
        schemaVersion: 1,
        leaseId,
        profile,
        gatewayBaseUrl: gatewayReady.codex.baseUrl,
        harnessGatewayBaseUrls: Object.fromEntries(ROUTED_HARNESS_IDS.map((harnessId) => [
          harnessId,
          gatewayReady.harnesses[harnessId].baseUrl,
        ])),
        catalogRevision: {
          codex: codexSnapshot.catalogRevision,
          external: externalSnapshot.catalogRevision,
        },
        profileOwnership: profileReceipt,
        harnessConfigOwnership,
        processes: [gatewayIdentity, hostIdentity],
      };
      await writeTextAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      return Object.freeze({
        leaseId,
        receiptPath,
        gatewayBaseUrl: gatewayReady.codex.baseUrl,
        catalogRevision: codexSnapshot.catalogRevision,
        modelCount: codexSnapshot.models.length,
        externalModelCount: externalSnapshot.models.length,
        harnessModelCounts: Object.fromEntries(ROUTED_HARNESS_IDS.map((harnessId) => [
          harnessId,
          gatewayReady.harnesses[harnessId].modelCount,
        ])),
        processes: Object.freeze({ gateway: gatewayChild.pid, codexHost: hostChild.pid }),
      });
    } catch (error) {
      const cleanupErrors = [];
      for (const [child, expectedExecutable, captured] of [
        [hostChild, config.runtime.codexHostExecutable, hostIdentity],
        [gatewayChild, config.runtime.nodeExecutable, gatewayIdentity],
      ]) {
        try {
          await this.#terminateLaunchProcess(child, expectedExecutable, captured);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
          await childKillBestEffort(child);
        }
      }
      try {
        if (harnessConfigOwnership) {
          await restoreHarnessConfigs(harnessConfigOwnership, {
            expectedRoot: path.join(this.leaseDirectory, leaseId, "harnesses"),
          });
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await profileManager?.restore();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "fusion_launch_failed_and_cleanup_was_incomplete",
          { cause: error },
        );
      }
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
    const stalePids = [];
    for (const owned of ordered) {
      const current = await this.processInspector(owned.pid);
      if (!current) continue;
      try {
        assertOwnedProcess(current, owned);
      } catch (error) {
        if (!String(error?.message).startsWith("process_ownership_conflict:")) throw error;
        // PID 已复用时绝不终止新进程；其旧 lease 已失效，仍可安全恢复受管文件。
        stalePids.push(owned.pid);
        continue;
      }
      const result = await this.processTerminator(current);
      if (result?.stopped !== false) stoppedPids.push(owned.pid);
    }

    const manager = new ProfileManager({
      codexHome: receipt.profile.codexHome,
      stateDir: this.stateRoot,
    });
    if (receipt.harnessConfigOwnership) {
      await restoreHarnessConfigs(receipt.harnessConfigOwnership, {
        expectedRoot: path.join(this.leaseDirectory, leaseId, "harnesses"),
      });
    }
    await manager.restore();
    await unlink(receiptPath);
    return { restored: true, leaseId, stoppedPids, stalePids };
  }
}

export function createLocalFusionRuntime(options = {}) {
  return new LocalFusionRuntime(options);
}
