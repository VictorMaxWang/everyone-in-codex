import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { createConfiguredConnectionHub } from "./configured-connection-hub.mjs";
import { createConnectionSources } from "./connection-sources.mjs";
import { verifyCodexAppServerSchema } from "./codex-schema-contract.mjs";
import { HarnessRegistry } from "./harness-registry.mjs";
import { LocalFusionRuntime, createLocalFusionRuntime } from "./local-runtime.mjs";

/** 返回当前用户 LOCALAPPDATA 下由融合层拥有的全部状态路径。 */
export function defaultFusionPaths({ localAppData = process.env.LOCALAPPDATA } = {}) {
  if (!localAppData || !path.isAbsolute(localAppData)) {
    throw new Error("LOCALAPPDATA 必须是绝对路径");
  }
  const root = path.join(path.resolve(localAppData), "EveryoneCodex");
  return Object.freeze({
    root,
    profileConfigFile: path.join(root, "profiles.json"),
    harnessStateFile: path.join(root, "harnesses.json"),
    leaseDirectory: path.join(root, "leases"),
    modelCatalogFile: path.join(root, "codex2-models.json"),
  });
}

async function readProfiles(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.profiles !== "object" ||
      Array.isArray(parsed.profiles)
    ) {
      throw new Error("Profile 配置格式不受支持");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { schemaVersion: 1, active: null, profiles: {} };
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function normalizeProfile(input) {
  if (!input || typeof input !== "object") {
    throw new Error("Profile 参数缺失");
  }
  const name = String(input.name ?? "").trim();
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error("Profile name 必须是小写字母开头的安全标识符");
  }

  const pathFields = ["codexHome", "sqliteHome", "desktopRoot", "desktopUserData"];
  const normalized = { name };
  for (const field of pathFields) {
    const value = input[field];
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      throw new Error(`Profile ${field} 必须是绝对路径`);
    }
    normalized[field] = path.resolve(value);
  }
  return normalized;
}

/**
 * 小型 Profile 注册表。它只持久化隔离启动所需路径，不接触基础 Codex 配置。
 */
export class JsonProfileStore {
  constructor({ filePath } = {}) {
    if (!filePath || !path.isAbsolute(filePath)) {
      throw new Error("Profile filePath 必须是绝对路径");
    }
    this.filePath = path.resolve(filePath);
  }

  async add(input) {
    const profile = normalizeProfile(input);
    const state = await readProfiles(this.filePath);
    const current = state.profiles[profile.name];
    if (current && JSON.stringify(current) !== JSON.stringify(profile)) {
      throw new Error(`Profile ${profile.name} 已存在且内容不同`);
    }
    state.profiles[profile.name] = profile;
    await writeJsonAtomic(this.filePath, state);
    return profile;
  }

  async list() {
    const state = await readProfiles(this.filePath);
    return Object.values(state.profiles).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  async use(name) {
    const state = await readProfiles(this.filePath);
    if (!state.profiles[name]) {
      throw new Error(`Profile 不存在：${name}`);
    }
    state.active = name;
    await writeJsonAtomic(this.filePath, state);
    return state.profiles[name];
  }

  async getActive() {
    const state = await readProfiles(this.filePath);
    return state.active ? state.profiles[state.active] ?? null : null;
  }

  async get(name) {
    const state = await readProfiles(this.filePath);
    return state.profiles[name] ?? null;
  }
}

export function createDefaultStores({ localAppData } = {}) {
  const paths = defaultFusionPaths({ localAppData });
  return {
    paths,
    profiles: new JsonProfileStore({ filePath: paths.profileConfigFile }),
    harnesses: new HarnessRegistry({ stateFile: paths.harnessStateFile }),
  };
}

function normalizedPathKey(value) {
  return path.resolve(value).replaceAll("/", "\\").toLowerCase();
}

/**
 * 创建本机验证门禁。调用方应显式传入允许的隔离 Profile 与受保护路径。
 */
export function createLocalValidationPolicy({
  allowedProfileNames = ["secondary"],
  deniedCodexHomes = [],
  deniedDesktopRoots = [],
} = {}) {
  const allowed = new Set(allowedProfileNames);
  const deniedNames = new Set(["primary", "default", "codex1", "codex-1"]);
  const deniedHomes = new Set(deniedCodexHomes.map(normalizedPathKey));
  const deniedDesktops = new Set(deniedDesktopRoots.map(normalizedPathKey));

  return Object.freeze({
    assert(profile) {
      if (!profile || deniedNames.has(profile.name) || !allowed.has(profile.name)) {
        throw new Error(
          `本机验证不允许 Profile ${profile?.name ?? "<none>"}；仅允许显式隔离的 Profile`,
        );
      }
      if (
        deniedHomes.has(normalizedPathKey(profile.codexHome)) ||
        deniedDesktops.has(normalizedPathKey(profile.desktopRoot))
      ) {
        throw new Error(`本机验证拒绝受保护的 Codex 1 路径：${profile.name}`);
      }
      return profile;
    },
  });
}

function requireBoundary(boundary, method, label) {
  if (!boundary || typeof boundary[method] !== "function") {
    throw new Error(`${label} 尚未配置，无法执行 ${method}`);
  }
  return boundary[method].bind(boundary);
}

/**
 * 融合编排的唯一公共入口；外部服务与进程生命周期均由构造器边界注入。
 */
export class FusionController {
  constructor({
    profiles,
    harnesses,
    preparer = null,
    catalogBridge = null,
    launcher = null,
    connections = null,
    validationPolicy = createLocalValidationPolicy(),
  } = {}) {
    if (!profiles || !harnesses) {
      throw new Error("FusionController 需要 profiles 与 harnesses 依赖");
    }
    this.profiles = profiles;
    this.harnesses = harnesses;
    this.preparer = preparer;
    this.catalogBridge = catalogBridge;
    this.launcher = launcher;
    this.connections = connections;
    this.validationPolicy = validationPolicy;
  }

  async #activeValidationProfile() {
    const profile = await this.profiles.getActive();
    await this.validationPolicy.assert(profile);
    return profile;
  }

  async inspect() {
    const [activeProfile, profiles, harnesses, catalog, launcher] = await Promise.all([
      this.profiles.getActive(),
      this.profiles.list(),
      this.harnesses.list(),
      this.catalogBridge?.inspect?.() ?? null,
      this.launcher?.inspect?.() ?? null,
    ]);
    return { activeProfile, profiles, harnesses, catalog, launcher };
  }

  async prepare() {
    const profile = await this.#activeValidationProfile();
    const prepare = requireBoundary(this.preparer, "prepare", "Preparation boundary");
    return prepare({ profile });
  }

  async syncModels({ target = "codex" } = {}) {
    if (!new Set(["codex", "external"]).has(target)) {
      throw new Error(`未知模型发布目标：${target}`);
    }
    const profile = await this.#activeValidationProfile();
    const activate = requireBoundary(
      this.catalogBridge,
      "activate",
      "RouterCatalogBridge",
    );
    return activate({ target, profile });
  }

  async launch() {
    const profile = await this.#activeValidationProfile();
    const launch = requireBoundary(this.launcher, "launch", "Launcher boundary");
    return launch({ profile });
  }

  async restore({ leaseId } = {}) {
    if (typeof leaseId !== "string" || leaseId.trim() === "") {
      throw new Error("restore 需要精确 leaseId");
    }
    const restore = requireBoundary(this.launcher, "restore", "Launcher boundary");
    return restore({ leaseId });
  }

  async addProfile(profile) {
    return this.profiles.add(profile);
  }

  async listProfiles() {
    return this.profiles.list();
  }

  async useProfile(name) {
    const profile = await this.profiles.get(name);
    await this.validationPolicy.assert(profile);
    return this.profiles.use(name);
  }

  async adoptHarness(input) {
    return this.harnesses.adopt(input);
  }

  async installHarness(id) {
    return this.harnesses.install(id);
  }

  async loginHarness(id) {
    return this.harnesses.login(id);
  }

  async listHarnesses() {
    return this.harnesses.list();
  }

  async removeHarness(id) {
    return this.harnesses.remove(id);
  }

  async listConnections() {
    return requireBoundary(this.connections, "inspect", "ConnectionHub")();
  }

  async createConnection(draft) {
    return requireBoundary(this.connections, "createCustom", "ConnectionHub")(draft);
  }

  async loginConnection(target) {
    return requireBoundary(this.connections, "startLogin", "ConnectionHub")(target);
  }

  async removeConnection(id) {
    return requireBoundary(this.connections, "remove", "ConnectionHub")(id);
  }

  async applyConnections() {
    return requireBoundary(this.connections, "apply", "ConnectionHub")();
  }

  async startConnectionSecretEntry(input) {
    return requireBoundary(this.connections, "startSecretEntry", "ConnectionHub")(input);
  }

  async submitConnectionSecret(input) {
    return requireBoundary(this.connections, "submitSecret", "ConnectionHub")(input);
  }

  async openConnections() {
    return requireBoundary(this.connections, "open", "ConnectionHub")();
  }
}

/** 使用 LOCALAPPDATA 状态存储创建适合 CLI 的本机 Controller。 */
export function createLocalFusionController({
  localAppData,
  configPath,
  runtime = null,
  runtimeOptions = {},
  preparer,
  catalogBridge,
  launcher,
  connections,
  validationPolicy,
} = {}) {
  const stores = createDefaultStores({ localAppData });
  // CLI 默认装配可运行的本机边界；显式注入仍优先，保持测试与嵌入调用的隔离能力。
  const localRuntime = runtime ?? createLocalFusionRuntime({
    ...runtimeOptions,
    ...(configPath === undefined ? {} : { configPath }),
    stateRoot: runtimeOptions.stateRoot ?? stores.paths.root,
    harnesses: stores.harnesses,
    schemaVerifier: runtimeOptions.schemaVerifier ?? verifyCodexAppServerSchema,
  });
  const localConnections = connections
    ?? localRuntime.connections
    ?? (localRuntime instanceof LocalFusionRuntime
      ? createConfiguredConnectionHub({
        runtime: localRuntime,
        profiles: stores.profiles,
        configPath: localRuntime.configPath,
        sourceFactory: (config) => createConnectionSources({
          profile: config.profile,
          webgptHealthUrl: config.webgpt.healthUrl,
          registry: stores.harnesses,
        }),
      })
      : null);
  return new FusionController({
    profiles: stores.profiles,
    harnesses: stores.harnesses,
    preparer: preparer ?? localRuntime.preparer,
    catalogBridge: catalogBridge ?? localRuntime.catalogBridge,
    launcher: launcher ?? localRuntime.launcher,
    connections: localConnections,
    validationPolicy: validationPolicy ?? localRuntime.validationPolicy,
  });
}
