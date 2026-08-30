import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

const NATIVE_MODEL_PATTERN = /^(?:gpt|o\d|chatgpt)-/i;
const SOL_MODEL_ID = "gpt-5.6-sol";
const SOL_1M_MODEL_ID = "gpt-5.6-sol-1m";
const NATIVE_CATALOG_SCRIPT = fileURLToPath(new URL("./fetch-native-catalog.ps1", import.meta.url));
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

function modelId(model) {
  return typeof model?.id === "string"
    ? model.id
    : typeof model?.slug === "string"
      ? model.slug
      : null;
}

function catalogModels(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.models)) return document.models;
  if (Array.isArray(document?.data)) return document.data;
  return [];
}

function liveIds(document) {
  const entries = Array.isArray(document?.live)
    ? document.live
    : Array.isArray(document?.live_model_ids)
      ? document.live_model_ids
      : [];
  return new Set(entries.map((entry) => (
    typeof entry === "string" ? entry : modelId(entry)
  )).filter(Boolean));
}

function isLive(model, liveSet, explicitLiveState) {
  // `codex debug models` 已经是当前账号的实时目录，正式输出并不带 live 字段。
  // 只有 fixture/上游显式提供 live 状态时才额外收紧，避免把缺失误判为离线。
  return !explicitLiveState || model?.live === true || liveSet.has(modelId(model));
}

function sol1mModel(base) {
  // 1M 是账号已有 Sol 的能力叠加项，不能脱离基础模型单独出现。
  return {
    ...base,
    id: SOL_1M_MODEL_ID,
    slug: SOL_1M_MODEL_ID,
    display_name: "GPT-5.6 Sol 1M",
    description: "GPT-5.6 Sol with the documented 1M-token context window.",
    context_window: 1_000_000,
    max_context_window: 1_000_000,
    source: "native-openai",
  };
}

/**
 * 从调用方已取得的 Codex 2 目录文档中筛选可发布的原生 OpenAI 模型。
 * 本模块不读取文件，因此不会意外回退到默认 CODEX_HOME 或 Codex 1。
 */
export function selectCodex2NativeModels(document) {
  const candidates = catalogModels(document);
  const liveSet = liveIds(document);
  const explicitLiveState = liveSet.size > 0 || candidates.some((model) => model?.live !== undefined);
  const selected = [];
  const seen = new Set();

  for (const candidate of candidates) {
    const id = modelId(candidate);
    if (
      !id
      || id.includes("/")
      || !NATIVE_MODEL_PATTERN.test(id)
      || candidate.visibility !== "list"
      || candidate.supported_in_api !== true
      || !isLive(candidate, liveSet, explicitLiveState)
      || seen.has(id)
      || id === SOL_1M_MODEL_ID
    ) {
      continue;
    }

    const model = Object.freeze({ ...candidate, id, source: "native-openai" });
    selected.push(model);
    seen.add(id);

    if (id === SOL_MODEL_ID) {
      selected.push(Object.freeze(sol1mModel(model)));
      seen.add(SOL_1M_MODEL_ID);
    }
  }

  return Object.freeze(selected);
}

function parseJson(text) {
  if (typeof text !== "string") throw new Error("codex2_auth_invalid");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("codex2_auth_invalid", { cause: error });
  }
}

function jwtExpiration(token) {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(parsed?.exp) ? parsed.exp * 1_000 : null;
  } catch {
    return null;
  }
}

function explicitExpiration(document) {
  const value = document?.tokens?.expires_at
    ?? document?.tokens?.expiresAt
    ?? document?.expires_at
    ?? document?.expiresAt
    ?? null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!Number.isFinite(value)) return null;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function authSession(token, kind, accountId = "") {
  const session = Object.create(null);
  Object.defineProperties(session, {
    available: { enumerable: true, value: true },
    kind: { enumerable: true, value: kind },
    applyToHeaders: {
      value(headers) {
        if (headers?.set instanceof Function) {
          headers.set("authorization", `Bearer ${token}`);
          if (accountId) headers.set("chatgpt-account-id", accountId);
          return headers;
        }
        if (headers && typeof headers === "object") {
          headers.authorization = `Bearer ${token}`;
          if (accountId) headers["chatgpt-account-id"] = accountId;
          return headers;
        }
        throw new TypeError("headers must be a Headers instance or object");
      },
    },
    toJSON: {
      // 序列化结果只暴露可用性，凭据始终留在闭包中。
      value: () => ({ available: true, kind }),
    },
    [inspect.custom]: {
      value: () => `Codex2AuthSession { available: true, kind: '${kind}' }`,
    },
  });
  return Object.freeze(session);
}

/**
 * 解析调用方显式注入的 Codex 2 auth.json 文本，并返回不可序列化凭据的会话句柄。
 * OAuth token 必须带有可验证的过期时间；静态 API key 没有到期字段。
 */
export function parseCodex2AuthJson(text, { now = Date.now() } = {}) {
  const document = parseJson(text);
  const apiKey = typeof document?.OPENAI_API_KEY === "string"
    ? document.OPENAI_API_KEY.trim()
    : "";
  if (apiKey) return authSession(apiKey, "api-key");

  const accessToken = typeof document?.tokens?.access_token === "string"
    ? document.tokens.access_token.trim()
    : typeof document?.access_token === "string"
      ? document.access_token.trim()
      : "";
  if (!accessToken) throw new Error("codex2_auth_missing");

  const expiration = explicitExpiration(document) ?? jwtExpiration(accessToken);
  if (!Number.isFinite(expiration)) throw new Error("codex2_auth_expiration_missing");
  if (Number(now) >= expiration) throw new Error("codex2_auth_expired");
  const accountId = typeof document?.tokens?.account_id === "string"
    ? document.tokens.account_id.trim()
    : typeof document?.account_id === "string"
      ? document.account_id.trim()
      : "";
  return authSession(accessToken, "oauth", accountId);
}

function runNativeCatalogHelper({
  authorization,
  accountId,
  clientVersion,
  spawnImpl = spawn,
  powershellExecutable = "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  timeoutMs = 45_000,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(powershellExecutable, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-File",
      NATIVE_CATALOG_SCRIPT,
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const append = (target, chunk) => {
      const next = `${target}${chunk.toString("utf8")}`;
      if (Buffer.byteLength(next) > MAX_CATALOG_BYTES) {
        child.kill?.("SIGTERM");
        finish(reject, new Error("codex2_native_catalog_too_large"));
        return target;
      }
      return next;
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", () => finish(reject, new Error("codex2_native_catalog_helper_failed")));
    child.once("exit", (code) => {
      if (code !== 0) {
        const status = (() => {
          try { return JSON.parse(stdout)?.status; } catch { return null; }
        })();
        finish(reject, new Error(
          status === 401 || status === 403
            ? "codex2_native_auth_rejected"
            : "codex2_native_catalog_fetch_failed",
        ));
        return;
      }
      if (stderr.trim()) {
        finish(reject, new Error("codex2_native_catalog_helper_failed"));
        return;
      }
      finish(resolve, stdout);
    });
    timeout = setTimeout(() => {
      child.kill?.("SIGTERM");
      finish(reject, new Error("codex2_native_catalog_timeout"));
    }, timeoutMs);
    timeout.unref?.();
    child.stdin?.end(JSON.stringify({ authorization, accountId, clientVersion }));
  });
}

/**
 * 使用 Codex 2 OAuth 实时读取账号模型目录。凭据只经子进程 stdin 传递，
 * 不进入命令行、环境变量、错误正文或目录快照。
 */
export async function fetchCodex2NativeCatalog(session, {
  clientVersion,
  runHelper = runNativeCatalogHelper,
} = {}) {
  if (session?.kind !== "oauth" || typeof session.applyToHeaders !== "function") {
    throw new Error("codex2_native_oauth_required");
  }
  if (typeof clientVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(clientVersion)) {
    throw new Error("codex2_native_client_version_invalid");
  }
  const headers = {};
  session.applyToHeaders(headers);
  const stdout = await runHelper({
    authorization: headers.authorization,
    accountId: headers["chatgpt-account-id"] ?? "",
    clientVersion,
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
