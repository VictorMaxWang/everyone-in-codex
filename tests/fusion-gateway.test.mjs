import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { FusionGateway } from "../src/fusion-gateway.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("Gateway 用回环 lease 发布模型并只转发 allowlist 内的请求", async (t) => {
  const upstreamRequests = [];
  const router = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    upstreamRequests.push({
      path: request.url,
      authorization: request.headers.authorization,
      body,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "response-ok", output: [] }));
  });
  const routerBaseUrl = `${await listen(router)}/_codex-router/upstream-secret-value/v1/`;
  t.after(() => close(router));

  const gateway = new FusionGateway({ routerBaseUrl });
  const lease = await gateway.start({
    models: [{ id: "zai-api-cn/glm-5.3-flash", context_window: 1_000_000 }],
  });
  t.after(() => lease.close());

  assert.match(lease.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(JSON.stringify(lease).includes("upstream-secret-value"), false);

  const unauthorized = await fetch(`${lease.baseUrl}/v1/models`);
  assert.equal(unauthorized.status, 401);

  const modelsResponse = await fetch(`${lease.baseUrl}/v1/models`, {
    headers: lease.authorizationHeaders(),
  });
  assert.equal(modelsResponse.status, 200);
  assert.deepEqual((await modelsResponse.json()).data.map((model) => model.id), [
    "zai-api-cn/glm-5.3-flash",
  ]);

  const denied = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { ...lease.authorizationHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/pro", input: "do-not-forward" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(upstreamRequests.length, 0);

  const allowedBody = { model: "zai-api-cn/glm-5.3-flash", input: "gateway-sentinel" };
  const allowed = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { ...lease.authorizationHeaders(), "content-type": "application/json" },
    body: JSON.stringify(allowedBody),
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).id, "response-ok");
  assert.deepEqual(upstreamRequests, [{
    path: "/_codex-router/upstream-secret-value/v1/responses",
    authorization: undefined,
    body: JSON.stringify(allowedBody),
  }]);
});

test("Gateway 不向调用方透出 Router 错误正文或 capability", async (t) => {
  const router = createServer((_request, response) => {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({
      error: "upstream-secret-value",
      debug: "private-router-debug-body",
    }));
  });
  const routerBaseUrl = `${await listen(router)}/_codex-router/upstream-secret-value/v1/`;
  t.after(() => close(router));

  const gateway = new FusionGateway({ routerBaseUrl });
  const lease = await gateway.start({ models: [{ id: "provider/allowed" }] });
  t.after(() => lease.close());

  const response = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { ...lease.authorizationHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ model: "provider/allowed", input: "private-request-body" }),
  });
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.equal(body.includes("upstream-secret-value"), false);
  assert.equal(body.includes("private-router-debug-body"), false);
  assert.equal(body.includes("private-request-body"), false);
  assert.equal(JSON.parse(body).error.code, "router_request_failed");
});

test("Gateway 只为 Grok 补全 Responses SSE sequence_number", async (t) => {
  const router = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"type":"response.created","response":{"id":"r1"}}\n');
    response.write("\n");
    response.end('data: {"type":"response.completed","sequence_number":7}\n\n');
  });
  const routerBaseUrl = `${await listen(router)}/_codex-router/upstream-secret-value/v1/`;
  t.after(() => close(router));
  const gateway = new FusionGateway({ routerBaseUrl });
  const lease = await gateway.start({ models: [{ id: "provider/allowed" }] });
  t.after(() => lease.close());

  const response = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      ...lease.authorizationHeaders(),
      "content-type": "application/json",
      "x-everyone-codex-harness": "grok",
    },
    body: JSON.stringify({ model: "provider/allowed", input: "sentinel" }),
  });
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)));

  assert.deepEqual(events.map((event) => event.sequence_number), [0, 7]);
});
