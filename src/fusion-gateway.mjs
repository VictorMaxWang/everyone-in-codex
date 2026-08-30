import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  anthropicToResponsesRequest,
  countAnthropicTokens,
  createResponsesSseToAnthropicTransform,
  responsesToAnthropicResponse,
} from "./anthropic-facade.mjs";
import { HarnessSessionRegistry, harnessIds } from "./harness-session-registry.mjs";

const DEFAULT_LEASE_TTL_MS = null;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const SESSION_HEADER = "x-everyone-codex-session";
const MODEL_SOURCES = new Set(["router-provider", "webgpt", "native-openai"]);
const PROTOCOLS = new Set(["openai-responses", "anthropic-messages"]);
const CONNECTION_ROUTES = Object.freeze(new Map([
  ["inspect", "inspect"],
  ["key-session", "startKeySession"],
  ["custom/create", "createCustom"],
  ["login", "startLogin"],
  ["remove", "remove"],
  ["apply", "apply"],
]));
const PRODUCT_UPDATE_ROUTES = Object.freeze(new Set(["check", "start", "status"]));

function writeJson(response, statusCode, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left ?? ""));
  const rightBytes = Buffer.from(String(right ?? ""));
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length);
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request_too_large");
      error.code = "request_too_large";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function inferModelSource(model) {
  if (MODEL_SOURCES.has(model.source)) return model.source;
  if (model.id.startsWith("chatgpt-web/")) return "webgpt";
  return "router-provider";
}

function normalizeModels(models) {
  if (!Array.isArray(models)) throw new TypeError("models must be an array");
  const byId = new Map();
  for (const model of models) {
    if (!model || typeof model.id !== "string" || !model.id) {
      throw new TypeError("every model must have a non-empty id");
    }
    if (!byId.has(model.id)) {
      byId.set(model.id, Object.freeze({ ...model, source: inferModelSource(model) }));
    }
  }
  return Object.freeze([...byId.values()]);
}

function grokSseSequenceTransform() {
  let pending = "";
  let sequenceNumber = 0;
  let currentMessageId = null;
  let currentOutputIndex = null;
  let currentContentIndex = null;
  let currentReasoningId = null;
  let currentReasoningOutputIndex = null;
  let currentSummaryIndex = 0;
  let currentSummaryText = "";
  let currentOutputText = "";
  const rewriteLine = (line) => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice("data:".length).trimStart();
    if (!data || data === "[DONE]") return line;
    try {
      const event = JSON.parse(data);
      if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") {
        return line;
      }
      // Grok 1.0.13 严格要求单调递增；混用上游序号与本地补号会产生重复值。
      event.sequence_number = sequenceNumber++;
      if (event.type === "response.output_item.added" && event.item?.type === "message") {
        currentMessageId = typeof event.item.id === "string" ? event.item.id : currentMessageId;
        currentOutputIndex = Number.isInteger(event.output_index)
          ? event.output_index
          : currentOutputIndex;
      }
      if (event.type === "response.output_item.added" && event.item?.type === "reasoning") {
        currentReasoningId = typeof event.item.id === "string"
          ? event.item.id
          : currentReasoningId;
        currentReasoningOutputIndex = Number.isInteger(event.output_index)
          ? event.output_index
          : currentReasoningOutputIndex;
      }
      if (event.type === "response.reasoning_summary_part.added"
        || event.type === "response.reasoning_summary_part.done") {
        if (!event.item_id && currentReasoningId) event.item_id = currentReasoningId;
        if (!Number.isInteger(event.output_index) && currentReasoningOutputIndex !== null) {
          event.output_index = currentReasoningOutputIndex;
        }
        if (!Number.isInteger(event.summary_index)) event.summary_index = currentSummaryIndex;
        if (typeof event.item_id === "string") currentReasoningId = event.item_id;
        if (Number.isInteger(event.output_index)) currentReasoningOutputIndex = event.output_index;
        if (Number.isInteger(event.summary_index)) currentSummaryIndex = event.summary_index;
      }
      if (event.type === "response.reasoning_summary_text.delta"
        || event.type === "response.reasoning_summary_text.done") {
        if (!event.item_id && currentReasoningId) event.item_id = currentReasoningId;
        if (!Number.isInteger(event.output_index) && currentReasoningOutputIndex !== null) {
          event.output_index = currentReasoningOutputIndex;
        }
        if (!Number.isInteger(event.summary_index)) event.summary_index = currentSummaryIndex;
        if (event.type.endsWith(".delta") && typeof event.delta === "string") {
          currentSummaryText += event.delta;
        }
        if (event.type.endsWith(".done")) {
          if (typeof event.text !== "string") event.text = currentSummaryText;
          else currentSummaryText = event.text;
        }
      }
      if (event.type === "response.reasoning_text.delta"
        || event.type === "response.reasoning_text.done") {
        if (!event.item_id && currentReasoningId) event.item_id = currentReasoningId;
        if (!Number.isInteger(event.output_index) && currentReasoningOutputIndex !== null) {
          event.output_index = currentReasoningOutputIndex;
        }
        if (!Number.isInteger(event.content_index)) event.content_index = 0;
      }
      if (event.type === "response.content_part.added"
        || event.type === "response.content_part.done") {
        if (!event.item_id && currentMessageId) event.item_id = currentMessageId;
        if (!Number.isInteger(event.output_index) && currentOutputIndex !== null) {
          event.output_index = currentOutputIndex;
        }
        if (!Number.isInteger(event.content_index) && currentContentIndex !== null) {
          event.content_index = currentContentIndex;
        }
        if (typeof event.item_id === "string") currentMessageId = event.item_id;
        if (Number.isInteger(event.output_index)) currentOutputIndex = event.output_index;
        if (Number.isInteger(event.content_index)) currentContentIndex = event.content_index;
      }
      if (event.type === "response.output_text.delta"
        || event.type === "response.output_text.done") {
        if (!event.item_id && currentMessageId) event.item_id = currentMessageId;
        if (!Number.isInteger(event.output_index) && currentOutputIndex !== null) {
          event.output_index = currentOutputIndex;
        }
        if (!Number.isInteger(event.content_index) && currentContentIndex !== null) {
          event.content_index = currentContentIndex;
        }
        if (!Array.isArray(event.logprobs)) event.logprobs = [];
        if (event.type.endsWith(".delta") && typeof event.delta === "string") {
          currentOutputText += event.delta;
        }
        if (event.type.endsWith(".done")) {
          if (typeof event.text !== "string") event.text = currentOutputText;
          else currentOutputText = event.text;
        }
      }
      const pendingValues = [event];
      while (pendingValues.length > 0) {
        const value = pendingValues.pop();
        if (!value || typeof value !== "object") continue;
        if (value.type === "reasoning" && !Object.hasOwn(value, "summary")) value.summary = [];
        if (value.type === "output_text") {
          if (typeof value.text !== "string") value.text = currentOutputText;
          if (!Array.isArray(value.annotations)) value.annotations = [];
          if (!Array.isArray(value.logprobs)) value.logprobs = [];
        }
        if (value.type === "summary_text" && typeof value.text !== "string") {
          value.text = currentSummaryText;
        }
        if (Object.hasOwn(value, "text") && value.text && typeof value.text === "object"
          && !Array.isArray(value.text) && !Object.hasOwn(value.text, "format")) {
          value.text.format = { type: "text" };
        }
        for (const nested of Object.values(value)) {
          if (nested && typeof nested === "object") pendingValues.push(nested);
        }
      }
      return `data: ${JSON.stringify(event)}`;
    } catch {
      return line;
    }
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      this.push(lines.map((line) => rewriteLine(line.replace(/\r$/u, ""))).join("\n"));
      if (lines.length > 0) this.push("\n");
      callback();
    },
    flush(callback) {
      if (pending) this.push(rewriteLine(pending.replace(/\r$/u, "")));
      callback();
    },
  });
}

function inputEndsWithToolResult(input) {
  if (!Array.isArray(input) || input.length === 0) return false;
  // Anthropic 每次会发送完整历史；是否处于同一工具往返应看最后一个语义项，而不是整段历史。
  const item = input.at(-1);
  return item?.type === "function_call_output" || item?.type === "tool_result" || item?.role === "tool";
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function contextSandboxMode(context) {
  const permission = String(context.permissionMode).trim().toLowerCase();
  return context.harnessId === "omp" || permission.includes("read")
    ? "read-only"
    : "workspace-write";
}

function environmentMessage(context, sandboxMode) {
  const roots = context.workspaceRoots
    .map((root) => `    <root>${escapeXml(root)}</root>`)
    .join("\n");
  return [
    "<environment_context>",
    `  <cwd>${escapeXml(context.cwd)}</cwd>`,
    "  <workspace_roots>",
    roots,
    "  </workspace_roots>",
    `  <sandbox_mode>${sandboxMode}</sandbox_mode>`,
    "</environment_context>",
  ].join("\n");
}

function isRealUserItem(item) {
  if (item?.role !== "user") return false;
  if (typeof item.content === "string") return true;
  return Array.isArray(item.content) && item.content.some((block) => (
    block?.type === "input_text" || block?.type === "text" || block?.type === "input_image"
  ));
}

function canonicalRoleMessage(item) {
  if (!item || !["developer", "system", "user", "assistant"].includes(item.role)) {
    return { ...item };
  }
  const role = item.role === "system" ? "developer" : item.role;
  const textType = role === "assistant" ? "output_text" : "input_text";
  const content = typeof item.content === "string"
    ? [{ type: textType, text: item.content }]
    : Array.isArray(item.content)
      ? item.content.map((part) => (
        part?.type === "text" && typeof part.text === "string"
          ? { ...part, type: textType }
          : part
      ))
      : [];
  return { ...item, type: "message", role, content };
}

function inputWithTrustedEnvironment(
  input,
  context,
  turnId,
  sandboxMode,
  serverOwnedMessageIds,
) {
  const items = typeof input === "string"
    ? [{ role: "user", content: [{ type: "input_text", text: input }] }]
    : Array.isArray(input) ? input.map(canonicalRoleMessage) : [];
  let userIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isRealUserItem(items[index])) {
      userIndex = index;
      break;
    }
  }
  if (userIndex >= 0) {
    const bindTurn = (item, id) => ({
      ...item,
      type: "message",
      ...(serverOwnedMessageIds ? { id } : {}),
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
    items[userIndex] = bindTurn(items[userIndex], `eic-user-${turnId}`);
    items.splice(userIndex, 0, {
      type: "message",
      ...(serverOwnedMessageIds ? { id: `eic-env-${turnId}` } : {}),
      role: "user",
      content: [{ type: "input_text", text: environmentMessage(context, sandboxMode) }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
  }
  return items;
}

export function normalizeWebGptRequest(payload, session, {
  randomId = randomUUID,
  serverOwnedMessageIds = true,
} = {}) {
  if (!inputEndsWithToolResult(payload.input) || !session.activeTurnId) {
    session.activeTurnId = randomId();
  }
  const context = session.context;
  const sandboxMode = contextSandboxMode(context);
  const result = { ...payload };
  for (const untrusted of [
    "thread_id", "turn_id", "cwd", "workspace_roots", "permission_mode", "environment",
  ]) delete result[untrusted];
  const metadata = {
    thread_id: session.threadId,
    turn_id: session.activeTurnId,
    harness_id: context.harnessId,
    session_id: context.sessionId,
    cwd: context.cwd,
    workspace_roots: [...context.workspaceRoots],
    permission_mode: context.permissionMode,
    workspaces: Object.fromEntries(context.workspaceRoots.map((root) => [root, {}])),
    sandbox_mode: sandboxMode,
  };
  result.client_metadata = {
    ...(payload.client_metadata && typeof payload.client_metadata === "object"
      ? payload.client_metadata
      : {}),
    "x-codex-turn-metadata": JSON.stringify(metadata),
  };
  result.input = inputWithTrustedEnvironment(
    payload.input,
    context,
    session.activeTurnId,
    sandboxMode,
    serverOwnedMessageIds,
  );
  const originalInstructions = typeof payload.instructions === "string"
    ? payload.instructions.replace(/<environment_context>[\s\S]*?<\/environment_context>/giu, "").trim()
    : "";
  // 部分外部 Responses 客户端不会保留每个 input item 的内部 metadata。
  // 同一份受信环境也进入 Gateway 拥有的 instructions，给 WebGPT 一个严格只读的回退锚点。
  result.instructions = [originalInstructions, environmentMessage(context, sandboxMode)]
    .filter(Boolean)
    .join("\n");
  const effort = result.reasoning?.effort;
  if (effort === "ultra" && result.model !== "chatgpt-web/pro") {
    result.reasoning = { ...result.reasoning, effort: "max" };
  } else if (effort === "max" && result.model === "chatgpt-web/pro") {
    result.reasoning = { ...result.reasoning, effort: "ultra" };
  }
  return result;
}

function normalizeNativeOAuthRequest(payload, session) {
  const result = normalizeWebGptRequest(payload, session, {
    serverOwnedMessageIds: false,
  });
  const turnId = session.activeTurnId;
  result.input = result.input.map((item) => (
    item?.type === "message" && ["developer", "user", "assistant"].includes(item.role)
      ? {
        ...item,
        id: `msg_${randomUUID()}`,
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }
      : item
  ));
  const immediateTools = Array.isArray(result.tools) ? result.tools : [];
  if (immediateTools.length > 0) {
    result.input.unshift({
      type: "additional_tools",
      role: "developer",
      tools: [{
        type: "namespace",
        name: "functions",
        description: "Tools provided by the active external Harness.",
        tools: immediateTools,
      }],
    });
  }
  result.tools = [];
  delete result.instructions;
  delete result.max_output_tokens;
  result.parallel_tool_calls = false;
  result.tool_choice = "auto";
  result.store = false;
  result.prompt_cache_key = session.threadId;
  result.reasoning = {
    effort: result.reasoning?.effort ?? "medium",
    summary: result.reasoning?.summary ?? "auto",
    context: "all_turns",
  };
  result.include = ["reasoning.encrypted_content"];
  result.text = { verbosity: "low" };
  result.client_metadata = {
    ...result.client_metadata,
    session_id: session.threadId,
    thread_id: session.threadId,
    turn_id: turnId,
    "x-codex-installation-id": session.threadId,
    "x-codex-window-id": `w_${session.threadId}`,
  };
  return result;
}

class GatewayLease {
  #capability;
  #hostCapability;
  #close;
  #closed = false;

  constructor({ baseUrl, capability, hostCapability, models, consumerId, harnessId, protocol, close }) {
    this.baseUrl = baseUrl;
    this.models = models;
    this.consumerId = consumerId;
    this.harnessId = harnessId;
    this.protocol = protocol;
    this.#capability = capability;
    this.#hostCapability = hostCapability;
    this.#close = close;
  }

  authorizationHeaders() {
    if (this.#closed) throw new Error("gateway_lease_closed");
    return { authorization: `Bearer ${this.#capability}` };
  }

  controlAuthorizationHeaders() {
    if (this.#closed) throw new Error("gateway_lease_closed");
    return { authorization: `Bearer ${this.#hostCapability}` };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#close();
  }

  toJSON() {
    return {
      baseUrl: this.baseUrl,
      modelCount: this.models.length,
      consumerId: this.consumerId,
      harnessId: this.harnessId,
      protocol: this.protocol,
      active: !this.#closed,
    };
  }
}

function requestError(response, status, code, message = "Request failed") {
  writeJson(response, status, { error: { code, type: code, message } });
}

export class FusionGateway {
  #routerBaseUrl;
  #hostCapability;
  #sessions;
  #nativeOpenAiBaseUrl;
  #activeRequestCount = 0;
  #connectionControl;
  #productUpdateControl;

  constructor({
    routerBaseUrl,
    fetchImpl = globalThis.fetch,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    sessionTtlMs = leaseTtlMs,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    hostCapability = randomBytes(32).toString("base64url"),
    nativeOpenAiSessionProvider = () => null,
    nativeOpenAiBaseUrl = null,
    nativeFetch = globalThis.fetch,
    connectionControl = null,
    productUpdateControl = null,
  }) {
    if (!routerBaseUrl) throw new TypeError("routerBaseUrl is required");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    const parsedRouterBaseUrl = new URL(routerBaseUrl);
    if (parsedRouterBaseUrl.protocol !== "http:" || parsedRouterBaseUrl.hostname !== "127.0.0.1"
      || parsedRouterBaseUrl.username || parsedRouterBaseUrl.password
      || parsedRouterBaseUrl.search || parsedRouterBaseUrl.hash) {
      throw new TypeError("routerBaseUrl must be a plain loopback HTTP URL");
    }
    if (!parsedRouterBaseUrl.pathname.endsWith("/v1/")) {
      parsedRouterBaseUrl.pathname = `${parsedRouterBaseUrl.pathname.replace(/\/$/u, "")}/`;
      if (!parsedRouterBaseUrl.pathname.endsWith("/v1/")) {
        throw new TypeError("routerBaseUrl must end with /v1/");
      }
    }
    this.#routerBaseUrl = parsedRouterBaseUrl;
    this.fetchImpl = fetchImpl;
    this.leaseTtlMs = leaseTtlMs == null ? null : Math.max(1, Number(leaseTtlMs) || 1);
    this.maxBodyBytes = Math.max(1, Number(maxBodyBytes) || DEFAULT_MAX_BODY_BYTES);
    this.#hostCapability = hostCapability;
    this.#sessions = new HarnessSessionRegistry({ hostCapability, ttlMs: sessionTtlMs });
    if (connectionControl !== null && [...CONNECTION_ROUTES.values()].some(
      (method) => typeof connectionControl?.[method] !== "function",
    )) {
      throw new TypeError("connection_control_dependency_invalid");
    }
    this.#connectionControl = connectionControl;
    if (productUpdateControl !== null && [...PRODUCT_UPDATE_ROUTES].some(
      (method) => typeof productUpdateControl?.[method] !== "function",
    )) {
      throw new TypeError("product_update_control_dependency_invalid");
    }
    this.#productUpdateControl = productUpdateControl;
    if (typeof nativeOpenAiSessionProvider !== "function" || typeof nativeFetch !== "function") {
      throw new TypeError("native_openai_dependency_invalid");
    }
    this.nativeOpenAiSessionProvider = nativeOpenAiSessionProvider;
    this.nativeFetch = nativeFetch;
    this.#nativeOpenAiBaseUrl = nativeOpenAiBaseUrl ? new URL(nativeOpenAiBaseUrl) : null;
    if (this.#nativeOpenAiBaseUrl && (
      this.#nativeOpenAiBaseUrl.protocol !== "https:"
      || this.#nativeOpenAiBaseUrl.hostname !== "api.openai.com"
      || this.#nativeOpenAiBaseUrl.username
      || this.#nativeOpenAiBaseUrl.password
      || this.#nativeOpenAiBaseUrl.search
      || this.#nativeOpenAiBaseUrl.hash
    )) {
      throw new TypeError("native_openai_base_url_invalid");
    }
    if (this.#nativeOpenAiBaseUrl) {
      this.#nativeOpenAiBaseUrl.pathname = `${this.#nativeOpenAiBaseUrl.pathname.replace(/\/$/u, "")}/`;
      if (!this.#nativeOpenAiBaseUrl.pathname.endsWith("/v1/")) {
        throw new TypeError("native_openai_base_url_invalid");
      }
    }
  }

  async start({
    models,
    consumerId = "codex",
    harnessId = consumerId,
    protocol = "openai-responses",
  }) {
    const isCodexConsumer = consumerId === "codex" && harnessId === "codex";
    if ((!isCodexConsumer && !harnessIds.includes(harnessId)) || consumerId !== harnessId) {
      throw new TypeError("gateway_consumer_invalid");
    }
    if (!PROTOCOLS.has(protocol)) throw new TypeError("gateway_protocol_invalid");
    const publishedModels = normalizeModels(models);
    const modelsById = new Map(publishedModels.map((model) => [model.id, model]));
    const leaseCapability = randomBytes(32).toString("base64url");
    let active = true;
    const server = createServer(async (request, response) => {
      response.setHeader("cache-control", "no-store");
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const token = bearerToken(request);

      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        // 仅公开聚合计数，供独立 CLI 在应用连接前等待空闲；不暴露会话或正文。
        writeJson(response, 200, {
          status: "ok",
          activity: { activeCount: this.#activeRequestCount },
        });
        return;
      }

      const connectionMatch = request.method === "POST"
        ? /^\/v1\/connections\/(.+)$/u.exec(requestUrl.pathname)
        : null;
      if (connectionMatch) {
        if (!token || !safeEqual(token, this.#hostCapability)) {
          requestError(response, 401, "invalid_host", "Unauthorized");
          return;
        }
        const method = CONNECTION_ROUTES.get(connectionMatch[1]);
        if (!method || !this.#connectionControl) {
          requestError(response, 404, "connection_endpoint_unavailable", "Not found");
          return;
        }
        try {
          const params = JSON.parse(await readBody(request, this.maxBodyBytes));
          const result = await this.#connectionControl[method](params);
          writeJson(response, 200, result);
        } catch (error) {
          const tooLarge = error?.code === "request_too_large";
          requestError(
            response,
            tooLarge ? 413 : 400,
            tooLarge ? "request_too_large" : "connection_operation_failed",
          );
        }
        return;
      }

      const productUpdateMatch = request.method === "POST"
        ? /^\/v1\/product-update\/(check|start|status)$/u.exec(requestUrl.pathname)
        : null;
      if (productUpdateMatch) {
        if (!token || !safeEqual(token, this.#hostCapability)) {
          requestError(response, 401, "invalid_host", "Unauthorized");
          return;
        }
        const method = productUpdateMatch[1];
        if (!PRODUCT_UPDATE_ROUTES.has(method) || !this.#productUpdateControl) {
          requestError(response, 404, "product_update_endpoint_unavailable", "Not found");
          return;
        }
        try {
          const params = JSON.parse(await readBody(request, this.maxBodyBytes));
          const result = await this.#productUpdateControl[method](params);
          writeJson(response, 200, result);
        } catch (error) {
          const tooLarge = error?.code === "request_too_large";
          requestError(
            response,
            tooLarge ? 413 : 400,
            tooLarge ? "request_too_large" : "product_update_operation_failed",
          );
        }
        return;
      }

      if (requestUrl.pathname === "/v1/sessions" && request.method === "POST") {
        if (!token || !safeEqual(token, this.#hostCapability)) {
          requestError(response, 401, "invalid_host", "Unauthorized");
          return;
        }
        if (Object.keys(request.headers).some((name) => name.startsWith("x-everyone-codex-native-"))) {
          requestError(response, 400, "native_credentials_transport_forbidden", "Invalid session request");
          return;
        }
        try {
          const payload = JSON.parse(await readBody(request, this.maxBodyBytes));
          const context = payload?.context && typeof payload.context === "object"
            ? payload.context
            : payload;
          const receipt = this.#sessions.register({
            hostCapability: token,
            // 控制面是 Gateway 级而非 lease 级；一个 host capability 可为任一已知 Harness 注册会话。
            consumerId: context?.harnessId,
            context,
          });
          writeJson(response, 201, receipt, { [SESSION_HEADER]: receipt.sessionToken });
        } catch (error) {
          const tooLarge = error?.code === "request_too_large";
          requestError(response, tooLarge ? 413 : 400, tooLarge ? "request_too_large" : "invalid_session_context");
        }
        return;
      }

      const deleteMatch = request.method === "DELETE"
        ? /^\/v1\/sessions\/([^/]+)$/u.exec(requestUrl.pathname)
        : null;
      if (deleteMatch) {
        if (!token || !safeEqual(token, this.#hostCapability)) {
          requestError(response, 401, "invalid_host", "Unauthorized");
          return;
        }
        try {
          this.#sessions.revoke({ hostCapability: token, sessionToken: decodeURIComponent(deleteMatch[1]) });
          response.writeHead(204, { "cache-control": "no-store" });
          response.end();
        } catch {
          requestError(response, 404, "invalid_session", "Session not found");
        }
        return;
      }

      const leaseAuthorized = active && token && safeEqual(token, leaseCapability);
      let bearerSession = null;
      if (!isCodexConsumer && active && token && !leaseAuthorized) {
        try {
          bearerSession = this.#sessions.authorize({
            sessionToken: token,
            consumerId,
            harnessId,
          });
        } catch {
          bearerSession = null;
        }
      }
      if (!active || !token || (!leaseAuthorized && !bearerSession)) {
        requestError(response, 401, "invalid_lease", "Unauthorized");
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
        writeJson(response, 200, {
          object: "list",
          data: publishedModels.map((model) => ({ object: "model", ...model })),
        });
        return;
      }
      if (requestUrl.pathname.startsWith("/v1/messages/")
        && requestUrl.pathname !== "/v1/messages/count_tokens") {
        requestError(response, 501, "unsupported_endpoint", "Endpoint is not supported");
        return;
      }
      const isResponses = request.method === "POST" && requestUrl.pathname === "/v1/responses";
      const isAnthropicMessage = request.method === "POST" && requestUrl.pathname === "/v1/messages";
      const isCountTokens = request.method === "POST" && requestUrl.pathname === "/v1/messages/count_tokens";
      if (!isResponses && !isAnthropicMessage && !isCountTokens) {
        requestError(response, 404, "not_found", "Not found");
        return;
      }
      if ((isAnthropicMessage || isCountTokens) && protocol !== "anthropic-messages") {
        requestError(response, 404, "not_found", "Not found");
        return;
      }

      let session = bearerSession;
      if (!isCodexConsumer) {
        if (!session) {
          try {
            session = this.#sessions.authorize({
              sessionToken: request.headers[SESSION_HEADER], consumerId, harnessId,
            });
          } catch {
            requestError(response, 401, "invalid_session", "Unauthorized");
            return;
          }
        }
      }
      let clientPayload;
      try {
        clientPayload = JSON.parse(await readBody(request, this.maxBodyBytes));
      } catch (error) {
        const tooLarge = error?.code === "request_too_large";
        requestError(response, tooLarge ? 413 : 400, tooLarge ? "request_too_large" : "invalid_json");
        return;
      }
      const model = modelsById.get(clientPayload?.model);
      if (!model) {
        requestError(response, 403, "model_not_allowed", "Model is not allowed");
        return;
      }
      if (isCountTokens) {
        writeJson(response, 200, countAnthropicTokens(clientPayload));
        return;
      }

      let upstreamPayload;
      try {
        upstreamPayload = isAnthropicMessage ? anthropicToResponsesRequest(clientPayload) : clientPayload;
        if (model.source === "webgpt" && session) {
          upstreamPayload = normalizeWebGptRequest(upstreamPayload, session);
        } else if (upstreamPayload?.reasoning?.effort === "ultra") {
          upstreamPayload = { ...upstreamPayload, reasoning: { ...upstreamPayload.reasoning, effort: "max" } };
        }
      } catch {
        requestError(response, 400, "invalid_request", "Invalid request");
        return;
      }
      let nativeSession = null;
      if (model.source === "native-openai") {
        try {
          nativeSession = await this.nativeOpenAiSessionProvider({
            consumerId,
            harnessId,
            context: session?.context ?? null,
            modelId: model.id,
          });
        } catch {
          nativeSession = null;
        }
        if (!nativeSession?.available || !["api-key", "oauth"].includes(nativeSession.kind)
          || typeof nativeSession.applyToHeaders !== "function") {
          requestError(response, 401, "native_openai_session_required", "Native OpenAI session is unavailable");
          return;
        }
        if (model.id === "gpt-5.6-sol-1m" && nativeSession.kind === "api-key") {
          upstreamPayload = { ...upstreamPayload, model: "gpt-5.6-sol" };
        }
        if (nativeSession.kind === "oauth" && session) {
          // ChatGPT Codex 的原生 Responses 端点要求 native turn envelope；外部
          // Harness 的标准 OpenAI 请求必须由受信会话上下文补齐后才能转发。
          upstreamPayload = normalizeNativeOAuthRequest(upstreamPayload, session);
        }
      }

      this.#activeRequestCount += 1;
      const abortController = new AbortController();
      request.once("aborted", () => abortController.abort());
      response.once("close", () => {
        if (!response.writableEnded) abortController.abort();
      });
      try {
        const directNative = model.source === "native-openai" && nativeSession.kind === "api-key";
        if (directNative && !this.#nativeOpenAiBaseUrl) {
          requestError(response, 503, "native_openai_endpoint_unavailable", "Native OpenAI endpoint is unavailable");
          return;
        }
        const upstreamUrl = new URL(
          "responses",
          directNative ? this.#nativeOpenAiBaseUrl : this.#routerBaseUrl,
        );
        const upstreamHeaders = {
          "content-type": "application/json",
          accept: upstreamPayload.stream ? "text/event-stream" : request.headers.accept ?? "application/json",
        };
        if (model.source === "native-openai") {
          nativeSession.applyToHeaders(upstreamHeaders);
          if (nativeSession.kind === "oauth") {
            // ChatGPT Codex 后端要求与官方 Codex 客户端一致的原生标记。
            upstreamHeaders.originator = "codex_app";
            upstreamHeaders["openai-beta"] = "responses=v1";
          }
        }
        const upstream = await (directNative ? this.nativeFetch : this.fetchImpl)(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
          body: JSON.stringify(upstreamPayload),
          signal: abortController.signal,
        });
        if (!upstream.ok) {
          await upstream.body?.cancel().catch(() => {});
          requestError(response, upstream.status, "router_request_failed", "Router request failed");
          return;
        }
        if (isAnthropicMessage && !upstreamPayload.stream) {
          try {
            writeJson(response, 200, responsesToAnthropicResponse(await upstream.json()));
          } catch {
            requestError(response, 502, "router_response_invalid", "Router response is invalid");
          }
          return;
        }
        response.statusCode = upstream.status;
        for (const headerName of ["content-type", "cache-control", "x-request-id"]) {
          const value = upstream.headers.get(headerName);
          if (value) response.setHeader(headerName, value);
        }
        if (isAnthropicMessage && upstreamPayload.stream) {
          response.setHeader("content-type", "text/event-stream; charset=utf-8");
        }
        if (!upstream.body) {
          response.end();
          return;
        }
        const upstreamStream = Readable.fromWeb(upstream.body);
        if (isAnthropicMessage && upstreamPayload.stream) {
          await pipeline(upstreamStream, createResponsesSseToAnthropicTransform(), response);
        } else if (harnessId === "grok"
          && upstream.headers.get("content-type")?.includes("text/event-stream")) {
          await pipeline(upstreamStream, grokSseSequenceTransform(), response);
        } else {
          await pipeline(upstreamStream, response);
        }
      } catch {
        if (!response.headersSent) requestError(response, 502, "router_unavailable", "Router is unavailable");
        else response.destroy();
      } finally {
        this.#activeRequestCount -= 1;
      }
    });

    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const closeGateway = async () => {
      if (!active) return;
      active = false;
      if (expiry) clearTimeout(expiry);
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    };
    const expiry = this.leaseTtlMs === null
      ? null
      : setTimeout(() => void closeGateway(), this.leaseTtlMs);
    expiry?.unref?.();
    return new GatewayLease({
      baseUrl, capability: leaseCapability, hostCapability: this.#hostCapability,
      models: publishedModels, consumerId, harnessId, protocol, close: closeGateway,
    });
  }
}
