import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseCodex2AuthJson } from "./codex2-native-catalog.mjs";

const CONSUMERS = Object.freeze([
  "codex",
  "pi",
  "omp",
  "deepseek-harness",
  "grok",
  "claude-code",
]);
const HARNESS_NAMES = Object.freeze(new Map([
  ["pi", "Pi"],
  ["omp", "OMP"],
  ["deepseek-harness", "DeepSeek Harness"],
  ["grok", "Grok"],
  ["claude-code", "Claude Code"],
]));

function catalog(state) {
  return Object.freeze({
    state: state === "connected" ? "ready" : "unpublished",
    modelCount: 0,
    consumers: state === "connected" ? CONSUMERS : Object.freeze([]),
  });
}

function codex2Snapshot(state, authenticationKind = null) {
  return Object.freeze({
    id: "codex2",
    label: "Codex 2 OpenAI / ChatGPT",
    scope: "shared-model-source",
    owner: "codex2",
    state,
    ...(authenticationKind ? { authenticationKind } : {}),
    catalog: catalog(state),
    actionIds: Object.freeze(["login"]),
  });
}

/**
 * 只检查调用方显式给出的 Codex 2 Profile。这里没有默认 Home 或环境变量回退，
 * 以免 Connections 在 Codex 2 失效时误用 Codex 1 会话。
 */
export function createCodex2ConnectionSource({ profile, readAuth = readFile } = {}) {
  if (!path.isAbsolute(profile?.codexHome ?? "") || typeof readAuth !== "function") {
    throw new Error("connection_codex2_source_invalid");
  }
  const authPath = path.join(path.resolve(profile.codexHome), "auth.json");
  const isolatedCommand = path.isAbsolute(profile.desktopRoot ?? "")
    ? path.join(path.resolve(profile.desktopRoot), "app", "resources", "codex.exe")
    : "codex.cmd";
  const isolatedEnvironment = path.isAbsolute(profile.sqliteHome ?? "")
    ? Object.freeze({
      CODEX_HOME: path.resolve(profile.codexHome),
      CODEX_SQLITE_HOME: path.resolve(profile.sqliteHome),
    })
    : null;
  return Object.freeze({
    id: "codex2",
    async inspect() {
      try {
        const session = parseCodex2AuthJson(await readAuth(authPath, "utf8"));
        return Object.freeze([codex2Snapshot("connected", session.kind)]);
      } catch (error) {
        const state = error?.code === "ENOENT" ? "not-configured" : "attention-required";
        return Object.freeze([codex2Snapshot(state)]);
      }
    },
    async startLogin() {
      const methods = Object.freeze([
        Object.freeze({ id: "browser", command: isolatedCommand, args: Object.freeze(["login"]) }),
        Object.freeze({
          id: "device-auth",
          command: isolatedCommand,
          args: Object.freeze(["login", "--device-auth"]),
        }),
      ]);
      // 返回可见交互计划而非执行结果；UI 决定浏览器登录还是 device auth。
      return Object.freeze({
        operationId: "codex2-login",
        target: "codex2",
        owner: "codex2",
        interactive: true,
        visibleTerminalRequired: true,
        executed: false,
        command: methods[0].command,
        args: methods[0].args,
        ...(isolatedEnvironment ? { environment: isolatedEnvironment } : {}),
        methods,
      });
    },
  });
}

function normalizeHealthUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("connection_webgpt_health_url_invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/healthz"
  ) {
    throw new Error("connection_webgpt_health_url_invalid");
  }
  return url.href;
}

function webGptSnapshot(document = null) {
  const connected = document?.status === "ok" && document?.accepting_turns === true;
  const state = connected ? "connected" : "unavailable";
  const mode = typeof document?.mode === "string" && document.mode.length <= 32
    ? document.mode
    : null;
  return Object.freeze({
    id: "webgpt",
    label: "ChatGPT Web (WebGPT)",
    scope: "shared-model-source",
    owner: "webgpt",
    state,
    service: Object.freeze({
      status: connected ? "ok" : "unavailable",
      acceptingTurns: connected,
      ...(mode ? { mode } : {}),
    }),
    catalog: catalog(state),
    actionIds: Object.freeze(["login"]),
  });
}

/** WebGPT 的连接状态只来自只读 healthz；响应中的其他字段不会进入快照。 */
export function createWebGptConnectionSource({ healthUrl, fetchImpl = globalThis.fetch } = {}) {
  const url = normalizeHealthUrl(healthUrl);
  if (typeof fetchImpl !== "function") throw new Error("connection_webgpt_source_invalid");
  return Object.freeze({
    id: "webgpt",
    async inspect() {
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          headers: { accept: "application/json" },
        });
        if (!response?.ok || typeof response.json !== "function") {
          return Object.freeze([webGptSnapshot()]);
        }
        return Object.freeze([webGptSnapshot(await response.json())]);
      } catch {
        return Object.freeze([webGptSnapshot()]);
      }
    },
    async startLogin() {
      return Object.freeze({
        operationId: "webgpt-login",
        target: "webgpt",
        owner: "webgpt",
        interactive: true,
        visibleBrowserRequired: true,
        executed: false,
        action: "open-webgpt-login",
      });
    },
  });
}

function harnessSnapshot(id, record) {
  const adopted = Boolean(record);
  return Object.freeze({
    id: `harness:${id}`,
    harnessId: id,
    label: HARNESS_NAMES.get(id),
    scope: "harness-identity",
    owner: "harness",
    // adopt 仅证明命令已登记，不能据此声称官方账号已经登录。
    state: adopted ? "ready-to-login" : "not-adopted",
    ...(adopted && typeof record.version === "string" ? { version: record.version } : {}),
    actionIds: Object.freeze(["login"]),
  });
}

/** 为五个内置 Harness 建立独立登录 target；Registry 仍是命令与登录计划 owner。 */
export function createHarnessIdentitySources({ registry } = {}) {
  if (typeof registry?.list !== "function" || typeof registry?.login !== "function") {
    throw new Error("connection_harness_registry_invalid");
  }
  return Object.freeze([...HARNESS_NAMES].map(([id]) => Object.freeze({
    id: `harness:${id}`,
    async inspect() {
      const adopted = (await registry.list()).find((record) => record?.id === id);
      return Object.freeze([harnessSnapshot(id, adopted)]);
    },
    async startLogin() {
      const plan = await registry.login(id);
      return Object.freeze({
        id,
        target: `harness:${id}`,
        owner: "harness",
        scope: "harness-identity",
        interactive: plan?.interactive === true,
        visibleTerminalRequired: plan?.visibleTerminalRequired === true,
        command: plan?.command,
        args: Object.freeze(Array.isArray(plan?.args) ? [...plan.args] : []),
        ...(typeof plan?.instruction === "string" ? { instruction: plan.instruction } : {}),
        executed: false,
      });
    },
  })));
}

/** 产出 ConnectionHub 可直接消费的一维 source 数组。 */
export function createConnectionSources({
  profile,
  webgptHealthUrl,
  registry,
  readAuth = readFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  return Object.freeze([
    createCodex2ConnectionSource({ profile, readAuth }),
    createWebGptConnectionSource({ healthUrl: webgptHealthUrl, fetchImpl }),
    ...createHarnessIdentitySources({ registry }),
  ]);
}
