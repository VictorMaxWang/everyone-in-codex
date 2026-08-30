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

const SESSION_CONTEXT = Object.freeze({
  harnessId: "pi",
  sessionId: "pi-session-1",
  cwd: "D:\\fixture",
  workspaceRoots: ["D:\\fixture"],
  permissionMode: "read-only",
});

async function startLease(gateway, options = {}) {
  const harnessId = options.harnessId ?? "pi";
  const lease = await gateway.start({
    consumerId: harnessId,
    harnessId,
    protocol: options.protocol ?? "openai-responses",
    models: options.models ?? [{ id: "provider/allowed", source: "router-provider" }],
  });
  return lease;
}

async function registerSession(lease, {
  context = SESSION_CONTEXT,
} = {}) {
  const headers = {
    ...lease.controlAuthorizationHeaders(),
    "content-type": "application/json",
  };
  const response = await fetch(`${lease.baseUrl}/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ context }),
  });
  assert.equal(response.status, 201);
  const sessionToken = response.headers.get("x-everyone-codex-session");
  assert.ok(sessionToken);
  const serialized = JSON.stringify(await response.json());
  assert.equal(serialized.includes(sessionToken), false);
  return sessionToken;
}

function sessionHeaders(lease, sessionToken) {
  return {
    ...lease.authorizationHeaders(),
    "x-everyone-codex-session": sessionToken,
    "content-type": "application/json",
  };
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
  const lease = await startLease(gateway, {
    models: [{
      id: "zai-api-cn/glm-5.3-flash",
      context_window: 1_000_000,
      source: "router-provider",
    }],
  });
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease);

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
    headers: sessionHeaders(lease, sessionToken),
    body: JSON.stringify({ model: "chatgpt-web/pro", input: "do-not-forward" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(upstreamRequests.length, 0);

  const allowedBody = { model: "zai-api-cn/glm-5.3-flash", input: "gateway-sentinel" };
  const allowed = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
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
  const lease = await startLease(gateway);
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease);

  const response = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
    body: JSON.stringify({ model: "provider/allowed", input: "private-request-body" }),
  });
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.equal(body.includes("upstream-secret-value"), false);
  assert.equal(body.includes("private-router-debug-body"), false);
  assert.equal(body.includes("private-request-body"), false);
  assert.equal(JSON.parse(body).error.code, "router_request_failed");
});

test("Gateway 健康面只公开总活动计数并在请求结束后归零", async (t) => {
  let releaseUpstream;
  const release = new Promise((resolve) => { releaseUpstream = resolve; });
  t.after(() => releaseUpstream());
  const router = createServer(async (_request, response) => {
    await release;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "done", output: [] }));
  });
  const routerBaseUrl = `${await listen(router)}/_codex-router/private/v1/`;
  t.after(() => close(router));

  const gateway = new FusionGateway({ routerBaseUrl });
  const lease = await startLease(gateway);
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease);
  const request = fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
    body: JSON.stringify({ model: "provider/allowed", input: "sentinel" }),
  });

  let active;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    active = await fetch(`${lease.baseUrl}/healthz`).then((response) => response.json());
    if (active.activity.activeCount === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(active, { status: "ok", activity: { activeCount: 1 } });

  releaseUpstream();
  assert.equal((await request).status, 200);
  assert.deepEqual(
    await fetch(`${lease.baseUrl}/healthz`).then((response) => response.json()),
    { status: "ok", activity: { activeCount: 0 } },
  );
});

test("Gateway Connections 控制面只接受 host capability 并严格路由六个动作", async (t) => {
  const calls = [];
  const connectionControl = Object.fromEntries([
    ["inspect", { connections: [], pendingCount: 0, applyRequired: false, activity: { activeTurnCount: 0 }, operation: null }],
    ["startKeySession", { id: "key-1", publicKeySpkiBase64: "QUJDRA==", expiresAtMs: 99 }],
    ["createCustom", { connection: { id: "lab" }, applyRequired: true }],
    ["startLogin", { id: "login", kind: "login", state: "waiting-user", message: null }],
    ["remove", { id: "lab", pending: true }],
    ["apply", { operation: { id: "apply", kind: "apply", state: "running", message: null }, applyRequired: true, publishedModelCount: 1 }],
  ].map(([method, result]) => [method, async (params) => { calls.push([method, params]); return result; }]));
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:9/_codex-router/private/v1/",
    connectionControl,
  });
  const lease = await startLease(gateway);
  t.after(() => lease.close());

  const unauthorized = await fetch(`${lease.baseUrl}/v1/connections/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);

  const routes = [
    ["inspect", {}],
    ["key-session", {}],
    ["custom/create", { draft: { displayName: "Lab" }, secret: { mode: "keyless" } }],
    ["login", { id: "codex2" }],
    ["remove", { id: "lab" }],
    ["apply", {}],
  ];
  for (const [route, body] of routes) {
    const response = await fetch(`${lease.baseUrl}/v1/connections/${route}`, {
      method: "POST",
      headers: { ...lease.controlAuthorizationHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, route);
  }
  assert.deepEqual(calls.map(([method]) => method), [
    "inspect", "startKeySession", "createCustom", "startLogin", "remove", "apply",
  ]);
});

test("Gateway 产品更新控制面只接受 host capability，且不复用上游组件更新入口", async (t) => {
  const calls = [];
  const productUpdateControl = Object.fromEntries([
    ["check", { currentVersion: "0.3.1", latestVersion: "0.3.1", updateAvailable: false }],
    ["start", { status: { version: "0.3.2", phase: "waiting-for-exit" } }],
    ["status", { status: null }],
  ].map(([method, result]) => [method, async (params) => { calls.push([method, params]); return result; }]));
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:9/_codex-router/private/v1/",
    productUpdateControl,
  });
  const lease = await startLease(gateway);
  t.after(() => lease.close());

  const unauthorized = await fetch(`${lease.baseUrl}/v1/product-update/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(unauthorized.status, 401);

  for (const method of ["check", "start", "status"]) {
    const response = await fetch(`${lease.baseUrl}/v1/product-update/${method}`, {
      method: "POST",
      headers: { ...lease.controlAuthorizationHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ launcherPid: 1234, leaseId: "lease-one" }),
    });
    assert.equal(response.status, 200, method);
  }
  assert.deepEqual(calls.map(([method]) => method), ["check", "start", "status"]);
});

test("Gateway 为 Grok 补全严格 Responses SSE 文本字段并重排 sequence_number", async (t) => {
  const router = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'data: {"type":"response.output_item.added","sequence_number":0,"output_index":0,"item":{"type":"reasoning","id":"r1"}}\n',
    );
    response.write(
      'data: {"type":"response.reasoning_summary_part.added","part":{"type":"summary_text"}}\n',
    );
    response.write(
      'data: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n',
    );
    response.write(
      'data: {"type":"response.output_item.added","item":{"type":"message","id":"m1","content":[]}}\n',
    );
    response.write(
      'data: {"type":"response.content_part.added","output_index":1,"content_index":0,"part":{"type":"output_text","text":""}}\n',
    );
    response.write(
      'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"hello"}\n',
    );
    response.write(
      'data: {"type":"response.output_text.done","text":"hello"}\n',
    );
    response.end(
      'data: {"type":"response.completed","sequence_number":7,"response":{"text":{}}}\n\n',
    );
  });
  const routerBaseUrl = `${await listen(router)}/_codex-router/upstream-secret-value/v1/`;
  t.after(() => close(router));
  const gateway = new FusionGateway({ routerBaseUrl });
  const lease = await startLease(gateway, { harnessId: "grok" });
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease, {
    context: { ...SESSION_CONTEXT, harnessId: "grok", sessionId: "grok-session-1" },
  });

  const response = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      ...sessionHeaders(lease, sessionToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "provider/allowed", input: "sentinel" }),
  });
  const events = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice("data:".length)));

  assert.deepEqual(events.map((event) => event.sequence_number), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(events[0].item.summary, []);
  assert.deepEqual(events[1], {
    type: "response.reasoning_summary_part.added",
    sequence_number: 1,
    item_id: "r1",
    output_index: 0,
    summary_index: 0,
    part: { type: "summary_text", text: "" },
  });
  assert.deepEqual(events[2], {
    type: "response.reasoning_summary_text.delta",
    sequence_number: 2,
    item_id: "r1",
    output_index: 0,
    summary_index: 0,
    delta: "think",
  });
  assert.equal(events[4].item_id, "m1");
  assert.deepEqual(events[4].part.annotations, []);
  assert.deepEqual(events[4].part.logprobs, []);
  assert.deepEqual(events[5], {
    type: "response.output_text.delta",
    sequence_number: 5,
    item_id: "m1",
    output_index: 1,
    content_index: 0,
    delta: "hello",
    logprobs: [],
  });
  assert.deepEqual(events[6], {
    type: "response.output_text.done",
    sequence_number: 6,
    item_id: "m1",
    output_index: 1,
    content_index: 0,
    text: "hello",
    logprobs: [],
  });
  assert.deepEqual(events[7].response.text.format, { type: "text" });
});

test("上游 SSE 异步报错只终止当前请求，不会杀死 Gateway", async (t) => {
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"response.created","sequence_number":0}\n\n',
        ));
        setTimeout(() => controller.error(new Error("synthetic upstream stream failure")), 5);
      },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const lease = await startLease(gateway, { harnessId: "omp" });
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease, {
    context: { ...SESSION_CONTEXT, harnessId: "omp", sessionId: "omp-stream-session" },
  });

  const streamed = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      ...sessionHeaders(lease, sessionToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "provider/allowed", input: "sentinel", stream: true }),
  });
  await streamed.text().catch(() => "");

  const models = await fetch(`${lease.baseUrl}/v1/models`, {
    headers: lease.authorizationHeaders(),
  });
  assert.equal(models.status, 200);
  assert.deepEqual((await models.json()).data.map((model) => model.id), ["provider/allowed"]);
});

test("Responses 同时验证 consumer lease 与绑定的 Harness session", async (t) => {
  let upstreamCalls = 0;
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ id: "ok", output: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const piLease = await startLease(gateway);
  const ompLease = await startLease(gateway, { harnessId: "omp" });
  t.after(() => Promise.all([piLease.close(), ompLease.close()]));
  const piSession = await registerSession(piLease);

  const missing = await fetch(`${piLease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: { ...piLease.authorizationHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ model: "provider/allowed", input: "sentinel" }),
  });
  assert.equal(missing.status, 401);

  const crossed = await fetch(`${ompLease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(ompLease, piSession),
    body: JSON.stringify({ model: "provider/allowed", input: "sentinel" }),
  });
  assert.equal(crossed.status, 401);
  const ompSession = await registerSession(piLease, {
    context: { ...SESSION_CONTEXT, harnessId: "omp", sessionId: "omp-session-1" },
  });
  const allowed = await fetch(`${ompLease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(ompLease, ompSession),
    body: JSON.stringify({ model: "provider/allowed", input: "sentinel" }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(upstreamCalls, 1);
});

test("DSH 可用进程内 Session token 作为 Bearer，不把动态 header 写入磁盘", async (t) => {
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
    fetchImpl: async () => new Response(JSON.stringify({ id: "ok", output: [] }), {
      headers: { "content-type": "application/json" },
    }),
  });
  const lease = await gateway.start({
    models: [{ id: "provider/model", source: "router-provider" }],
    consumerId: "deepseek-harness",
    harnessId: "deepseek-harness",
  });
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease, {
    context: { ...SESSION_CONTEXT, harnessId: "deepseek-harness", sessionId: "dsh-session" },
  });

  const models = await fetch(`${lease.baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(models.status, 200);
  const response = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "provider/model", input: "sentinel" }),
  });
  assert.equal(response.status, 200);
});

test("Session 控制面拒绝通过 HTTP header 搬运原生凭据且不回显", async (t) => {
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
  });
  const lease = await startLease(gateway);
  t.after(() => lease.close());
  const secret = "native-secret-must-not-echo";
  const response = await fetch(`${lease.baseUrl}/v1/sessions`, {
    method: "POST",
    headers: {
      ...lease.controlAuthorizationHeaders(),
      "content-type": "application/json",
      "x-everyone-codex-native-authorization": `Bearer ${secret}`,
    },
    body: JSON.stringify({ context: SESSION_CONTEXT }),
  });
  const body = await response.text();
  assert.equal(response.status, 400);
  assert.equal(body.includes(secret), false);
  assert.equal(JSON.parse(body).error.code, "native_credentials_transport_forbidden");
});

test("WebGPT 覆盖伪造环境，新用户轮换 turn，工具结果复用 turn", async (t) => {
  const bodies = [];
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "ok", output: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const lease = await startLease(gateway, {
    models: [{ id: "chatgpt-web/pro", source: "webgpt" }],
  });
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease);

  const send = (input) => fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
    body: JSON.stringify({
      model: "chatgpt-web/pro",
      input,
      thread_id: "forged-thread",
      turn_id: "forged-turn",
      cwd: "C:\\forged",
      workspace_roots: ["C:\\forged"],
      permission_mode: "full-access",
      instructions: "system preface\n<environment_context><cwd>C:\\forged</cwd></environment_context>",
      reasoning: { effort: "max" },
    }),
  });
  assert.equal((await send("first user message")).status, 200);
  assert.equal((await send([
    { role: "user", content: [{ type: "input_text", text: "first user message" }] },
    { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "ok" },
  ])).status, 200);
  assert.equal((await send([{ role: "user", content: [{ type: "input_text", text: "next" }] }])).status, 200);

  const metadata = bodies.map((body) => JSON.parse(
    body.client_metadata["x-codex-turn-metadata"],
  ));
  assert.equal(metadata[0].thread_id, metadata[1].thread_id);
  assert.notEqual(metadata[0].thread_id, "forged-thread");
  assert.equal(metadata[0].turn_id, metadata[1].turn_id);
  assert.notEqual(metadata[0].turn_id, metadata[2].turn_id);
  assert.equal(metadata[0].cwd, SESSION_CONTEXT.cwd);
  assert.deepEqual(metadata[0].workspace_roots, SESSION_CONTEXT.workspaceRoots);
  assert.equal(metadata[0].permission_mode, "read-only");
  assert.deepEqual(Object.keys(metadata[0].workspaces), SESSION_CONTEXT.workspaceRoots);
  assert.equal(metadata[0].sandbox_mode, "read-only");
  assert.equal(Object.hasOwn(bodies[0], "thread_id"), false);
  assert.match(bodies[0].input[0].content[0].text, /^<environment_context>/);
  assert.equal(bodies[0].input[0].type, "message");
  assert.match(bodies[0].input[0].content[0].text, /<sandbox_mode>read-only<\/sandbox_mode>/);
  assert.equal(
    bodies[0].input[0].internal_chat_message_metadata_passthrough.turn_id,
    metadata[0].turn_id,
  );
  assert.equal(
    bodies[0].input[1].internal_chat_message_metadata_passthrough.turn_id,
    metadata[0].turn_id,
  );
  assert.equal(bodies[0].input[0].id, `eic-env-${metadata[0].turn_id}`);
  assert.equal(bodies[0].input[1].id, `eic-user-${metadata[0].turn_id}`);
  assert.equal(Object.hasOwn(bodies[0].input[1], "turn_id"), false);
  assert.match(bodies[0].instructions, /system preface/);
  assert.match(bodies[0].instructions, /<cwd>D:\\fixture<\/cwd>/);
  assert.doesNotMatch(bodies[0].instructions, /C:\\forged/);
  assert.equal(bodies[0].reasoning.effort, "ultra");
});

test("native-openai API key 直连注入端点，Sol 1M 只改写上游 model", async (t) => {
  const routerRequests = [];
  const nativeRequests = [];
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
    fetchImpl: async (_url, init) => {
      routerRequests.push(init);
      return new Response(JSON.stringify({ id: "router-ok", output: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
    nativeOpenAiBaseUrl: "https://api.openai.com/v1/",
    nativeOpenAiSessionProvider: ({ context }) => (
      context?.sessionId === "pi-native-session"
        ? {
            available: true,
            kind: "api-key",
            applyToHeaders(headers) {
              headers.authorization = "Bearer native-test-secret";
            },
          }
        : null
    ),
    nativeFetch: async (url, init) => {
      nativeRequests.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "ok", output: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const lease = await startLease(gateway, {
    models: [{ id: "gpt-5.6-sol-1m", source: "native-openai" }],
  });
  t.after(() => lease.close());
  const missingAuthSession = await registerSession(lease);
  const denied = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(lease, missingAuthSession),
    body: JSON.stringify({ model: "gpt-5.6-sol-1m", input: "sentinel" }),
  });
  assert.equal(denied.status, 401);
  assert.equal(routerRequests.length, 0);
  assert.equal(nativeRequests.length, 0);

  const authorizedSession = await registerSession(lease, {
    context: { ...SESSION_CONTEXT, sessionId: "pi-native-session" },
  });
  const allowed = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(lease, authorizedSession),
    body: JSON.stringify({ model: "gpt-5.6-sol-1m", input: "sentinel" }),
  });
  assert.equal(allowed.status, 200);
  assert.equal(routerRequests.length, 0);
  assert.equal(nativeRequests[0].url, "https://api.openai.com/v1/responses");
  assert.equal(nativeRequests[0].init.headers.authorization, "Bearer native-test-secret");
  assert.equal(JSON.parse(nativeRequests[0].init.body).model, "gpt-5.6-sol");
});

test("native-openai OAuth 通过 Router 保留官方 Codex 原生请求头", async (t) => {
  const routerRequests = [];
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
    nativeOpenAiSessionProvider: () => ({
      available: true,
      kind: "oauth",
      applyToHeaders(headers) {
        headers.authorization = "Bearer oauth-test-secret";
        headers["chatgpt-account-id"] = "account-test";
      },
    }),
    fetchImpl: async (url, init) => {
      routerRequests.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "ok", output: [] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const lease = await startLease(gateway, {
    models: [{ id: "gpt-5.6-sol-1m", source: "native-openai" }],
  });
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease);
  const response = await fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
    body: JSON.stringify({
      model: "gpt-5.6-sol-1m",
      input: [
        { role: "developer", content: "system preface" },
        { role: "user", content: "sentinel" },
      ],
      tools: [{
        type: "function",
        name: "read_file",
        description: "Read one file",
        parameters: { type: "object", properties: {} },
      }],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(routerRequests[0].init.headers.authorization, "Bearer oauth-test-secret");
  assert.equal(routerRequests[0].init.headers["chatgpt-account-id"], "account-test");
  assert.equal(routerRequests[0].init.headers.originator, "codex_app");
  assert.equal(routerRequests[0].init.headers["openai-beta"], "responses=v1");
  const routedBody = JSON.parse(routerRequests[0].init.body);
  assert.equal(routedBody.model, "gpt-5.6-sol-1m");
  assert.equal(typeof routedBody.client_metadata["x-codex-turn-metadata"], "string");
  assert.match(routedBody.client_metadata.session_id, /^[0-9a-f-]{36}$/);
  assert.equal(routedBody.client_metadata.thread_id, routedBody.client_metadata.session_id);
  assert.match(routedBody.client_metadata.turn_id, /^[0-9a-f-]{36}$/);
  assert.equal(Object.hasOwn(routedBody, "instructions"), false);
  assert.equal(routedBody.input[0].type, "additional_tools");
  assert.equal(routedBody.input[0].tools[0].type, "namespace");
  assert.equal(routedBody.input[0].tools[0].tools[0].name, "read_file");
  assert.deepEqual(routedBody.input[1], {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "system preface" }],
    id: routedBody.input[1].id,
    internal_chat_message_metadata_passthrough: {
      turn_id: routedBody.client_metadata.turn_id,
    },
  });
  assert.match(routedBody.input[1].id, /^msg_[0-9a-f-]{36}$/);
  assert.deepEqual(routedBody.tools, []);
  assert.equal(routedBody.parallel_tool_calls, false);
  assert.equal(routedBody.tool_choice, "auto");
  assert.equal(routedBody.reasoning.context, "all_turns");
  assert.deepEqual(routedBody.text, { verbosity: "low" });
});

test("Anthropic messages 使用同一会话门禁，count_tokens 本地完成，未支持端点明确失败", async (t) => {
  let upstreamCalls = 0;
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
    fetchImpl: async (_url, init) => {
      upstreamCalls += 1;
      const request = JSON.parse(init.body);
      assert.equal(request.input[0].content[0].text, "question");
      return new Response(JSON.stringify({
        id: "resp-1",
        model: request.model,
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }],
        usage: { input_tokens: 5, output_tokens: 2 },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  const lease = await startLease(gateway, { protocol: "anthropic-messages" });
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease);

  const count = await fetch(`${lease.baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
    body: JSON.stringify({ model: "provider/allowed", messages: [{ role: "user", content: "question" }] }),
  });
  assert.equal(count.status, 200);
  assert.ok((await count.json()).input_tokens > 0);
  assert.equal(upstreamCalls, 0);

  const message = await fetch(`${lease.baseUrl}/v1/messages`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
    body: JSON.stringify({ model: "provider/allowed", messages: [{ role: "user", content: "question" }] }),
  });
  assert.equal(message.status, 200);
  assert.deepEqual((await message.json()).content, [{ type: "text", text: "answer" }]);
  assert.equal(upstreamCalls, 1);

  const unsupported = await fetch(`${lease.baseUrl}/v1/messages/batches`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
    body: "{}",
  });
  assert.equal(unsupported.status, 501);
  assert.equal((await unsupported.json()).error.type, "unsupported_endpoint");
});

test("客户端取消会中止唯一一次 upstream，不会重提请求", async (t) => {
  let upstreamCalls = 0;
  let upstreamAborted = false;
  let notifyStarted;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const gateway = new FusionGateway({
    routerBaseUrl: "http://127.0.0.1:43123/_codex-router/private/v1/",
    fetchImpl: async (_url, init) => {
      upstreamCalls += 1;
      notifyStarted();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          upstreamAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  const lease = await startLease(gateway);
  t.after(() => lease.close());
  const sessionToken = await registerSession(lease);
  const controller = new AbortController();
  const pending = fetch(`${lease.baseUrl}/v1/responses`, {
    method: "POST",
    headers: sessionHeaders(lease, sessionToken),
    body: JSON.stringify({ model: "provider/allowed", input: "sentinel" }),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(pending, /abort/iu);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(upstreamCalls, 1);
  assert.equal(upstreamAborted, true);
});
