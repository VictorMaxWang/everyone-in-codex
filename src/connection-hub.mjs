const PROTOCOLS = new Set([
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
]);
const SECRET_FIELD = /^(?:api[_-]?key|key|token|secret|password|authorization|cookie)$/iu;

function containsSecretField(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsSecretField);
  return Object.entries(value).some(([key, nested]) => (
    SECRET_FIELD.test(key) || containsSecretField(nested)
  ));
}

function nonBlank(value, label, maximum = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`connection_${label}_invalid`);
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("connection_base_url_invalid");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("connection_base_url_invalid");
  }
  return url.href.replace(/\/$/u, "");
}

function normalizeCustomDraft(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("connection_draft_invalid");
  }
  if (containsSecretField(input)) throw new Error("connection_secret_forbidden");
  if (!PROTOCOLS.has(input.protocol)) throw new Error("connection_protocol_invalid");
  if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > 200) {
    throw new Error("connection_models_invalid");
  }
  const ids = new Set();
  const models = input.models.map((model) => {
    const id = nonBlank(model?.id, "model_id", 256);
    if (ids.has(id)) throw new Error("connection_models_invalid");
    ids.add(id);
    return { ...model, id };
  });
  return Object.freeze({
    label: nonBlank(input.label, "label"),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    protocol: input.protocol,
    keyless: input.keyless === true,
    models: Object.freeze(models),
  });
}

/**
 * 聚合连接状态与应用流程；长期凭据始终由具体 owner 保存，绝不进入本 Interface。
 */
export class ConnectionHub {
  constructor({ router, sources = [], activity = null, secrets = null, applyBoundary } = {}) {
    if (
      !router
      || typeof router.inspect !== "function"
      || typeof router.createCustom !== "function"
      || !Array.isArray(sources)
      || sources.some((source) => typeof source?.inspect !== "function")
      || (activity !== null && typeof activity?.waitUntilIdle !== "function")
      || (secrets !== null && (
        typeof secrets?.start !== "function" || typeof secrets?.submit !== "function"
      ))
      || typeof applyBoundary !== "function"
    ) {
      throw new Error("connection_hub_dependency_invalid");
    }
    this.router = router;
    this.sources = [...sources];
    this.sourcesById = new Map(
      this.sources
        .filter((source) => typeof source.id === "string" && source.id)
        .map((source) => [source.id, source]),
    );
    this.activity = activity;
    this.secrets = secrets;
    this.applyBoundary = applyBoundary;
  }

  async inspect() {
    const groups = await Promise.all([
      this.router.inspect(),
      ...this.sources.map((source) => source.inspect()),
    ]);
    return Object.freeze(groups.flat().map((entry) => Object.freeze({ ...entry })));
  }

  async createCustom(input) {
    return this.router.createCustom(normalizeCustomDraft(input));
  }

  async startLogin(target) {
    const id = nonBlank(target, "login_target", 128);
    const source = this.sourcesById.get(id);
    if (source) {
      if (typeof source.startLogin !== "function") throw new Error("connection_login_unsupported");
      return source.startLogin();
    }
    if (typeof this.router.startLogin !== "function") throw new Error("connection_login_unsupported");
    return this.router.startLogin(id);
  }

  async remove(id) {
    if (typeof this.router.remove !== "function") throw new Error("connection_remove_unsupported");
    return this.router.remove(nonBlank(id, "id", 128));
  }

  async startSecretEntry({ ownerId, mode = "secure-prompt" } = {}) {
    const id = nonBlank(ownerId, "secret_owner", 128);
    if (mode === "secure-prompt") {
      if (typeof this.router.startSecretPrompt !== "function") {
        throw new Error("connection_secret_prompt_unsupported");
      }
      return this.router.startSecretPrompt(id);
    }
    if (mode !== "masked" || !this.secrets) throw new Error("connection_secret_mode_invalid");
    return this.secrets.start({ ownerId: id });
  }

  async submitSecret(input) {
    if (!this.secrets) throw new Error("connection_secret_mode_invalid");
    return this.secrets.submit(input);
  }

  async apply({ signal, timeoutMs = 30 * 60_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30 * 60_000) {
      throw new Error("connection_apply_timeout_invalid");
    }
    const idle = this.activity
      ? await this.activity.waitUntilIdle({ signal, timeoutMs })
      : { idle: true };
    if (!idle?.idle) throw new Error("connection_apply_busy");
    const routerReceipt = typeof this.router.apply === "function"
      ? await this.router.apply({ signal })
      : { revision: null, restartRequired: false };
    const applied = await this.applyBoundary({
      routerRevision: routerReceipt.revision,
      restartRequired: routerReceipt.restartRequired === true,
    });
    return Object.freeze({
      applied: true,
      routerRevision: routerReceipt.revision,
      catalogRevision: applied.catalogRevision,
      consumers: applied.consumers,
    });
  }
}
