const WIRE_ID_PATTERN = /^[A-Za-z0-9._~-]+$/u;
const VALID_CONSUMERS = new Set([
  "codex",
  "pi",
  "omp",
  "deepseek-harness",
  "grok",
  "claude-code",
]);

function wireId(rawId) {
  const value = String(rawId ?? "").replaceAll(":", ".");
  if (!WIRE_ID_PATTERN.test(value)) throw new Error("connection_wire_id_invalid");
  return value;
}

function kindOf(entry) {
  if (entry.kind) return entry.kind;
  if (entry.owner === "codex2") return "codex2";
  if (entry.owner === "webgpt") return "webgpt";
  if (entry.owner === "harness") return "harness-login";
  if (entry.actionIds?.includes("remove")) return "custom-api";
  return "router-provider";
}

function stateOf(entry) {
  if (entry.state === "connected") return "connected";
  if (entry.state === "checking") return "checking";
  if (entry.state === "unavailable" || entry.state === "error") return "error";
  return "needs-login";
}

function project(entry) {
  const consumers = [...new Set(entry.catalog?.consumers ?? [])]
    .filter((consumer) => VALID_CONSUMERS.has(consumer));
  const pending = entry.catalog?.state === "unpublished"
    && entry.actionIds?.includes("apply") === true
    && kindOf(entry) === "custom-api";
  return Object.freeze({
    id: wireId(entry.id),
    displayName: String(entry.label ?? entry.id),
    scope: entry.scope,
    owner: entry.owner,
    kind: kindOf(entry),
    state: stateOf(entry),
    detail: typeof entry.detail === "string" ? entry.detail : null,
    consumers: Object.freeze(consumers),
    modelCount: Number.isSafeInteger(entry.catalog?.modelCount)
      ? entry.catalog.modelCount
      : 0,
    pending,
    loginAvailable: entry.actionIds?.some((id) => id === "login" || id === "connect") === true,
    removable: entry.actionIds?.includes("remove") === true,
    ...(entry.protocol ? { protocol: entry.protocol } : {}),
    ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
  });
}

/** Renderer 与本机 ConnectionHub 之间的无凭据控制面。 */
export class ConnectionControl {
  constructor({ hub, activity, securePrompt, interactiveLogin, startApply } = {}) {
    if (
      !hub
      || typeof hub.inspect !== "function"
      || typeof hub.createCustom !== "function"
      || typeof hub.startSecretEntry !== "function"
      || typeof hub.submitSecret !== "function"
      || typeof activity?.inspect !== "function"
      || typeof securePrompt !== "function"
      || typeof interactiveLogin !== "function"
      || typeof startApply !== "function"
    ) {
      throw new Error("connection_control_dependency_invalid");
    }
    this.hub = hub;
    this.activity = activity;
    this.securePrompt = securePrompt;
    this.interactiveLogin = interactiveLogin;
    this.startApply = startApply;
    this.operation = null;
    this.rawIdByWireId = new Map();
  }

  async #snapshot() {
    const raw = await this.hub.inspect();
    const projected = raw.map(project);
    this.rawIdByWireId = new Map(raw.map((entry, index) => [projected[index].id, entry.id]));
    if (this.rawIdByWireId.size !== projected.length) {
      throw new Error("connection_wire_id_collision");
    }
    return projected;
  }

  async inspect() {
    const [connections, activity] = await Promise.all([
      this.#snapshot(),
      this.activity.inspect(),
    ]);
    const pendingCount = connections.filter(({ pending }) => pending).length;
    return Object.freeze({
      connections: Object.freeze(connections),
      pendingCount,
      applyRequired: pendingCount > 0,
      activity: Object.freeze({ activeTurnCount: activity.activeCount }),
      operation: this.operation,
    });
  }

  async startKeySession() {
    const receipt = await this.hub.startSecretEntry({
      ownerId: "pending-custom-connection",
      mode: "masked",
    });
    return Object.freeze({
      id: receipt.operationId,
      publicKeySpkiBase64: receipt.publicKeySpkiBase64,
      expiresAt: receipt.expiresAt,
    });
  }

  async createCustom({ draft, secret } = {}) {
    const receipt = await this.hub.createCustom({
      label: draft.displayName,
      baseUrl: draft.baseUrl,
      protocol: draft.protocol,
      keyless: draft.keyless,
      models: draft.modelIds.map((id) => ({ id })),
    });
    if (secret.mode === "encrypted") {
      await this.hub.submitSecret({
        operationId: secret.keySessionId,
        ciphertext: secret.ciphertextBase64,
        ownerId: receipt.id,
      });
    } else if (secret.mode === "secure-prompt") {
      await this.securePrompt(receipt.id);
    }

    const inspection = await this.inspect();
    const connection = inspection.connections.find(({ id }) => id === wireId(receipt.id));
    if (!connection) throw new Error("connection_create_receipt_missing");
    return Object.freeze({ connection, applyRequired: inspection.applyRequired });
  }

  async startLogin({ id } = {}) {
    await this.#snapshot();
    const rawId = this.rawIdByWireId.get(id);
    if (!rawId) throw new Error("connection_login_target_missing");
    const plan = await this.hub.startLogin(rawId);
    const started = await this.interactiveLogin(plan);
    this.operation = Object.freeze({
      id: `login-${id}`,
      kind: "login",
      state: started?.state ?? "waiting-user",
      message: started?.message ?? null,
    });
    return this.operation;
  }

  async remove({ id } = {}) {
    await this.#snapshot();
    const rawId = this.rawIdByWireId.get(id);
    if (!rawId) throw new Error("connection_remove_target_missing");
    await this.hub.remove(rawId);
    return Object.freeze({ id, pending: true });
  }

  async apply() {
    const before = await this.inspect();
    this.operation = Object.freeze({
      id: "connections-apply",
      kind: "apply",
      state: "running",
      message: "Waiting for idle state before applying Connections",
    });
    await this.startApply();
    return Object.freeze({
      operation: this.operation,
      applyRequired: before.applyRequired,
      publishedModelCount: before.connections
        .filter(({ pending }) => !pending)
        .reduce((total, { modelCount }) => total + modelCount, 0),
    });
  }
}
