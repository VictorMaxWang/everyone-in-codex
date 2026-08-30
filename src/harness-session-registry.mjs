import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const HARNESS_IDS = new Set(["pi", "omp", "deepseek-harness", "grok", "claude-code"]);
const DEFAULT_SESSION_TTL_MS = null;

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""));
  const rightBytes = Buffer.from(String(right ?? ""));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireIdentifier(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new TypeError(`${name}_invalid`);
  }
  return value;
}

function normalizeContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new TypeError("session_context_invalid");
  }
  const harnessId = requireIdentifier(context.harnessId, "harness_id");
  if (!HARNESS_IDS.has(harnessId)) throw new TypeError("harness_id_invalid");
  const sessionId = requireIdentifier(context.sessionId, "session_id");
  if (typeof context.cwd !== "string" || context.cwd.trim() === "") {
    throw new TypeError("session_cwd_invalid");
  }
  if (
    !Array.isArray(context.workspaceRoots)
    || context.workspaceRoots.length < 1
    || context.workspaceRoots.some((root) => typeof root !== "string" || root.trim() === "")
  ) {
    throw new TypeError("session_workspace_roots_invalid");
  }
  if (typeof context.permissionMode !== "string" || context.permissionMode.trim() === "") {
    throw new TypeError("session_permission_mode_invalid");
  }
  return Object.freeze({
    harnessId,
    sessionId,
    cwd: context.cwd,
    workspaceRoots: Object.freeze([...context.workspaceRoots]),
    permissionMode: context.permissionMode,
  });
}

class HarnessSessionReceipt {
  #sessionToken;

  constructor({ sessionToken, consumerId, harnessId, expiresAt }) {
    this.#sessionToken = sessionToken;
    this.consumerId = consumerId;
    this.harnessId = harnessId;
    this.expiresAt = expiresAt;
    Object.freeze(this);
  }

  get sessionToken() {
    return this.#sessionToken;
  }

  toJSON() {
    // session token 只允许进入进程内 header，不进入 receipt、日志或错误正文。
    return {
      consumerId: this.consumerId,
      harnessId: this.harnessId,
      expiresAt: this.expiresAt,
    };
  }
}

export class HarnessSessionRegistry {
  #hostCapability;
  #sessions = new Map();

  constructor({
    hostCapability,
    ttlMs = DEFAULT_SESSION_TTL_MS,
    now = Date.now,
    randomToken = () => randomBytes(32).toString("base64url"),
  } = {}) {
    if (typeof hostCapability !== "string" || hostCapability.length < 16) {
      throw new TypeError("host_capability_invalid");
    }
    if (typeof now !== "function" || typeof randomToken !== "function") {
      throw new TypeError("session_registry_dependency_invalid");
    }
    this.#hostCapability = hostCapability;
    this.ttlMs = ttlMs == null ? null : Math.max(1, Number(ttlMs) || 1);
    this.now = now;
    this.randomToken = randomToken;
  }

  #authorizeHost(hostCapability) {
    if (!safeEqual(hostCapability, this.#hostCapability)) throw new Error("invalid_host_capability");
  }

  register({ hostCapability, consumerId, context } = {}) {
    this.#authorizeHost(hostCapability);
    const normalizedConsumerId = requireIdentifier(consumerId, "consumer_id");
    const normalizedContext = normalizeContext(context);
    if (normalizedConsumerId !== normalizedContext.harnessId) {
      throw new TypeError("consumer_harness_mismatch");
    }
    let sessionToken;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      sessionToken = this.randomToken();
      if (typeof sessionToken === "string" && sessionToken.length >= 16 && !this.#sessions.has(sessionToken)) {
        break;
      }
      sessionToken = null;
    }
    if (!sessionToken) throw new Error("session_token_generation_failed");
    const expiresAt = this.ttlMs === null ? null : this.now() + this.ttlMs;
    this.#sessions.set(sessionToken, {
      consumerId: normalizedConsumerId,
      context: normalizedContext,
      expiresAt,
      threadId: randomUUID(),
      activeTurnId: null,
    });
    return new HarnessSessionReceipt({
      sessionToken,
      consumerId: normalizedConsumerId,
      harnessId: normalizedContext.harnessId,
      expiresAt,
    });
  }

  authorize({ sessionToken, consumerId, harnessId } = {}) {
    const session = typeof sessionToken === "string" ? this.#sessions.get(sessionToken) : null;
    if (!session) throw new Error("invalid_session");
    if (session.expiresAt !== null && this.now() >= session.expiresAt) {
      this.#sessions.delete(sessionToken);
      throw new Error("session_expired");
    }
    if (
      !safeEqual(session.consumerId, consumerId)
      || !safeEqual(session.context.harnessId, harnessId)
    ) {
      throw new Error("invalid_session");
    }
    return session;
  }

  revoke({ hostCapability, sessionToken } = {}) {
    this.#authorizeHost(hostCapability);
    if (typeof sessionToken !== "string" || !this.#sessions.delete(sessionToken)) {
      throw new Error("invalid_session");
    }
  }

  close() {
    this.#sessions.clear();
  }
}

export const harnessIds = Object.freeze([...HARNESS_IDS]);
