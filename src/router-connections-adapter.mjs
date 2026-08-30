import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function safeId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error("connection_id_invalid");
  return id;
}

function idFromLabel(label) {
  const id = String(label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 63);
  return safeId(id || "custom");
}

function parseJsonOutput(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("router_connection_output_invalid", { cause: error });
  }
}

export function createRouterCommandRunner({
  routerScript,
  powershellExecutable = "pwsh.exe",
  spawnImpl = spawn,
} = {}) {
  if (typeof routerScript !== "string" || !routerScript) {
    throw new Error("router_connection_script_invalid");
  }
  return (args, { stdin = null } = {}) => new Promise((resolve, reject) => {
    const child = spawnImpl(powershellExecutable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      routerScript,
      ...args,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => {
      const next = `${current}${chunk.toString("utf8")}`;
      if (Buffer.byteLength(next) > MAX_OUTPUT_BYTES) {
        child.kill?.("SIGTERM");
        throw new Error("router_connection_output_too_large");
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      try { stdout = append(stdout, chunk); } catch (error) { reject(error); }
    });
    child.stderr.on("data", (chunk) => {
      try { stderr = append(stderr, chunk); } catch (error) { reject(error); }
    });
    child.once("error", () => reject(new Error("router_connection_command_failed")));
    child.once("exit", (code) => {
      if (code !== 0) {
        // secret-set 的 stderr 也不得进入上层日志；公开错误只保留动作分类。
        reject(new Error("router_connection_command_failed"));
        return;
      }
      if (stderr.trim()) {
        reject(new Error("router_connection_command_failed"));
        return;
      }
      resolve(parseJsonOutput(stdout));
    });
    child.stdin.end(stdin ?? undefined);
  });
}

export function createRouterServiceRestarter({
  routerRoot,
  nodeExecutable = process.execPath,
  spawnImpl = spawn,
} = {}) {
  if (typeof routerRoot !== "string" || !path.isAbsolute(routerRoot)) {
    throw new Error("router_connection_root_invalid");
  }
  const serviceScript = path.join(path.resolve(routerRoot), "src", "service.mjs");
  return () => new Promise((resolve, reject) => {
    const child = spawnImpl(nodeExecutable, [serviceScript, "restart"], {
      cwd: path.resolve(routerRoot),
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => reject(new Error("router_restart_failed")));
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error("router_restart_failed"));
      else resolve(Object.freeze({ healthy: true }));
    });
  });
}

/** Router 是连接与凭据 owner；本 Adapter 只传递非敏感 metadata 与 stdin。 */
export class RouterConnectionAdapter {
  constructor({ run, restart = null, loginPlan = null, secretPrompt = null } = {}) {
    if (typeof run !== "function") throw new Error("router_connection_dependency_invalid");
    if (restart !== null && typeof restart !== "function") {
      throw new Error("router_connection_restart_dependency_invalid");
    }
    if (loginPlan !== null && typeof loginPlan !== "function") {
      throw new Error("router_connection_login_dependency_invalid");
    }
    if (secretPrompt !== null && typeof secretPrompt !== "function") {
      throw new Error("router_connection_secret_prompt_dependency_invalid");
    }
    this.run = run;
    this.restartBoundary = restart;
    this.loginPlan = loginPlan;
    this.secretPrompt = secretPrompt;
    this.customIds = new Set();
  }

  async inspect() {
    const [providers, custom] = await Promise.all([
      this.run(["providers", "list", "--json"]),
      this.run(["connections", "list"]),
    ]);
    const selectedCustom = custom.pending ? custom.candidate : custom.active;
    this.customIds = new Set((selectedCustom ?? []).map((entry) => entry.id));
    const consumers = ["codex", "pi", "omp", "deepseek-harness", "grok", "claude-code"];
    return Object.freeze([
      ...(providers.providers ?? [])
        .filter((provider) => provider.id !== "chatgpt-web")
        .map((provider) => {
        const oauth = provider.id.endsWith("-oauth")
          || new Set(["devin-cli", "github-copilot"]).has(provider.id);
        return Object.freeze({
        id: `router:${provider.id}`,
        label: provider.name,
        scope: "shared-model-source",
        owner: "router",
        kind: oauth ? "router-oauth" : "router-provider",
        state: provider.configured ? "connected" : "not-configured",
        catalog: {
          state: provider.visible ? "ready" : "unpublished",
          modelCount: 0,
          consumers: provider.visible ? consumers : [],
        },
        actionIds: oauth
          ? ["login", "apply"]
          : provider.configured ? ["apply"] : ["connect"],
      });
      }),
      ...(selectedCustom ?? []).map((connection) => Object.freeze({
        id: connection.id,
        label: connection.displayName,
        scope: "shared-model-source",
        owner: "router",
        state: connection.credentialConfigured || connection.keyless
          ? "connected"
          : "attention-required",
        catalog: {
          state: custom.pending ? "unpublished" : "ready",
          modelCount: connection.models?.length ?? 0,
          consumers: custom.pending ? [] : consumers,
        },
        kind: "custom-api",
        protocol: connection.protocol === "openai-chat"
          ? "openai-chat-completions"
          : connection.protocol,
        baseUrl: connection.baseUrl,
        actionIds: [
          ...(connection.keyless || connection.credentialConfigured ? [] : ["set-secret"]),
          "apply",
          "remove",
        ],
      })),
    ]);
  }

  async createCustom(draft) {
    const base = idFromLabel(draft.label);
    const suffix = createHash("sha256").update(draft.baseUrl).digest("hex").slice(0, 8);
    const id = this.customIds.has(base) ? `${base.slice(0, 54)}-${suffix}` : base;
    const payload = {
      id,
      displayName: draft.label,
      baseUrl: draft.baseUrl,
      // Renderer 使用完整公开名称；Router 内部继续使用已发布的短协议 ID。
      protocol: draft.protocol === "openai-chat-completions" ? "openai-chat" : draft.protocol,
      keyless: draft.keyless === true,
      models: draft.models,
    };
    const result = await this.run(["connections", "create"], {
      stdin: Buffer.from(JSON.stringify(payload), "utf8"),
    });
    this.customIds.add(result.id ?? id);
    return Object.freeze({
      ...result,
      owner: "router",
      scope: "shared-model-source",
      state: payload.keyless ? "connected" : "attention-required",
      catalog: { state: "unpublished", modelCount: payload.models.length, consumers: [] },
      actionIds: payload.keyless ? ["apply", "remove"] : ["set-secret", "apply", "remove"],
    });
  }

  async submitSecret({ ownerId, secret }) {
    const id = safeId(ownerId);
    if (!Buffer.isBuffer(secret) || secret.length < 1) throw new Error("connection_secret_invalid");
    return this.run(["connections", "secret-set", id], { stdin: secret });
  }

  async startSecretPrompt(ownerId) {
    if (!this.secretPrompt) throw new Error("router_connection_secret_prompt_unavailable");
    return this.secretPrompt(safeId(ownerId));
  }

  async remove(id) {
    return this.run(["connections", "remove", safeId(id)]);
  }

  async apply() {
    const result = await this.run(["connections", "apply"]);
    return {
      revision: result.revision ?? result.activeRevision ?? null,
      restartRequired: result.restartRequired === true,
      ...result,
    };
  }

  async restart() {
    if (!this.restartBoundary) throw new Error("router_restart_unavailable");
    const result = await this.restartBoundary();
    if (result?.healthy === false) throw new Error("router_restart_unhealthy");
    return result;
  }

  async startLogin(target) {
    const id = String(target).replace(/^router:/u, "");
    if (this.loginPlan) return this.loginPlan(id);
    return Object.freeze({
      operationId: `router-login:${id}`,
      target: id,
      interactive: true,
      command: "router-login",
    });
  }
}
