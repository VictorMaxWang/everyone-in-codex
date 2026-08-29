import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;

function writeJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
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

function normalizeModels(models) {
  if (!Array.isArray(models)) throw new TypeError("models must be an array");
  const byId = new Map();
  for (const model of models) {
    if (!model || typeof model.id !== "string" || !model.id) {
      throw new TypeError("every model must have a non-empty id");
    }
    if (!byId.has(model.id)) byId.set(model.id, Object.freeze({ ...model }));
  }
  return Object.freeze([...byId.values()]);
}

function grokSseSequenceTransform() {
  let pending = "";
  let sequenceNumber = 0;
  const rewriteLine = (line) => {
    if (!line.startsWith("data:")) return line;
    const data = line.slice("data:".length).trimStart();
    if (!data || data === "[DONE]") return line;
    try {
      const event = JSON.parse(data);
      if (
        !event
        || typeof event !== "object"
        || Array.isArray(event)
        || typeof event.type !== "string"
      ) return line;
      if (Number.isInteger(event.sequence_number) && event.sequence_number >= 0) {
        sequenceNumber = Math.max(sequenceNumber, event.sequence_number + 1);
        return line;
      }
      return `data: ${JSON.stringify({ ...event, sequence_number: sequenceNumber++ })}`;
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

class GatewayLease {
  #capability;
  #close;
  #closed = false;

  constructor({ baseUrl, capability, models, close }) {
    this.baseUrl = baseUrl;
    this.models = models;
    this.#capability = capability;
    this.#close = close;
    Object.freeze(this.models);
  }

  authorizationHeaders() {
    if (this.#closed) throw new Error("gateway_lease_closed");
    return { authorization: `Bearer ${this.#capability}` };
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#close();
  }

  toJSON() {
    // capability 有意不进入 receipt、日志或 JSON 序列化结果。
    return { baseUrl: this.baseUrl, modelCount: this.models.length, active: !this.#closed };
  }
}

export class FusionGateway {
  #routerBaseUrl;

  constructor({
    routerBaseUrl,
    fetchImpl = globalThis.fetch,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  }) {
    if (!routerBaseUrl) throw new TypeError("routerBaseUrl is required");
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

    const parsedRouterBaseUrl = new URL(routerBaseUrl);
    if (
      parsedRouterBaseUrl.protocol !== "http:"
      || parsedRouterBaseUrl.hostname !== "127.0.0.1"
      || parsedRouterBaseUrl.username
      || parsedRouterBaseUrl.password
      || parsedRouterBaseUrl.search
      || parsedRouterBaseUrl.hash
    ) {
      throw new TypeError("routerBaseUrl must be a plain loopback HTTP URL");
    }
    if (!parsedRouterBaseUrl.pathname.endsWith("/v1/")) {
      parsedRouterBaseUrl.pathname = `${parsedRouterBaseUrl.pathname.replace(/\/$/, "")}/`;
      if (!parsedRouterBaseUrl.pathname.endsWith("/v1/")) {
        throw new TypeError("routerBaseUrl must end with /v1/");
      }
    }
    // Router caller capability保留在私有URL路径中；绝不能复制到Authorization头。
    this.#routerBaseUrl = parsedRouterBaseUrl;
    this.fetchImpl = fetchImpl;
    this.leaseTtlMs = Math.max(1, Number(leaseTtlMs) || DEFAULT_LEASE_TTL_MS);
    this.maxBodyBytes = Math.max(1, Number(maxBodyBytes) || DEFAULT_MAX_BODY_BYTES);
  }

  async start({ models }) {
    const publishedModels = normalizeModels(models);
    const allowedIds = new Set(publishedModels.map((model) => model.id));
    const leaseCapability = randomBytes(32).toString("base64url");
    let active = true;

    const server = createServer(async (request, response) => {
      response.setHeader("cache-control", "no-store");

      const token = bearerToken(request);
      if (!active || !token || !safeEqual(token, leaseCapability)) {
        writeJson(response, 401, { error: { code: "invalid_lease", message: "Unauthorized" } });
        return;
      }

      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
        writeJson(response, 200, {
          object: "list",
          data: publishedModels.map((model) => ({ object: "model", ...model })),
        });
        return;
      }

      if (request.method !== "POST" || requestUrl.pathname !== "/v1/responses") {
        writeJson(response, 404, { error: { code: "not_found", message: "Not found" } });
        return;
      }

      let body;
      let payload;
      try {
        body = await readBody(request, this.maxBodyBytes);
        payload = JSON.parse(body);
      } catch (error) {
        const tooLarge = error?.code === "request_too_large";
        writeJson(response, tooLarge ? 413 : 400, {
          error: {
            code: tooLarge ? "request_too_large" : "invalid_json",
            message: tooLarge ? "Request body is too large" : "Invalid JSON body",
          },
        });
        return;
      }

      if (typeof payload?.model !== "string" || !allowedIds.has(payload.model)) {
        writeJson(response, 403, { error: { code: "model_not_allowed", message: "Model is not allowed" } });
        return;
      }

      const abortController = new AbortController();
      request.once("aborted", () => abortController.abort());

      try {
        const upstreamUrl = new URL("responses", this.#routerBaseUrl);
        const upstream = await this.fetchImpl(upstreamUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: request.headers.accept ?? "text/event-stream, application/json",
          },
          body,
          signal: abortController.signal,
        });

        if (!upstream.ok) {
          // 上游正文可能含调试详情或敏感信息，只保留状态码和稳定错误码。
          await upstream.body?.cancel().catch(() => {});
          writeJson(response, upstream.status, {
            error: { code: "router_request_failed", message: "Router request failed" },
          });
          return;
        }

        response.statusCode = upstream.status;
        for (const headerName of ["content-type", "cache-control", "x-request-id"]) {
          const value = upstream.headers.get(headerName);
          if (value) response.setHeader(headerName, value);
        }
        if (!upstream.body) {
          response.end();
          return;
        }
        const upstreamStream = Readable.fromWeb(upstream.body);
        const grokCompatibility = request.headers["x-everyone-codex-harness"] === "grok"
          && upstream.headers.get("content-type")?.includes("text/event-stream");
        if (grokCompatibility) {
          upstreamStream.pipe(grokSseSequenceTransform()).pipe(response);
        } else {
          upstreamStream.pipe(response);
        }
      } catch {
        if (!response.headersSent) {
          writeJson(response, 502, {
            error: { code: "router_unavailable", message: "Router is unavailable" },
          });
        } else {
          response.destroy();
        }
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
      clearTimeout(expiry);
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    };
    const expiry = setTimeout(() => {
      void closeGateway();
    }, this.leaseTtlMs);
    expiry.unref?.();

    return new GatewayLease({
      baseUrl,
      capability: leaseCapability,
      models: publishedModels,
      close: closeGateway,
    });
  }
}
