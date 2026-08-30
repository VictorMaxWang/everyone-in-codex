import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";

import { ConnectionHub } from "../src/connection-hub.mjs";
import {
  createCodex2ConnectionSource,
  createConnectionSources,
  createHarnessIdentitySources,
  createWebGptConnectionSource,
} from "../src/connection-sources.mjs";

const CONSUMERS = ["codex", "pi", "omp", "deepseek-harness", "grok", "claude-code"];

test("Codex 2 source 只读取显式 Profile，快照和登录计划不复制认证", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "everyone-connections-codex2-"));
  const codex2Home = path.join(fixture, "codex2");
  const unrelatedHome = path.join(fixture, "codex1");
  const secret = "fixture-secret-must-not-escape";
  await mkdir(codex2Home, { recursive: true });
  await mkdir(unrelatedHome, { recursive: true });
  await writeFile(path.join(codex2Home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: secret }));
  await writeFile(path.join(unrelatedHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "wrong" }));

  const source = createCodex2ConnectionSource({ profile: { codexHome: codex2Home } });
  assert.deepEqual(await source.inspect(), [{
    id: "codex2",
    label: "Codex 2 OpenAI / ChatGPT",
    scope: "shared-model-source",
    owner: "codex2",
    state: "connected",
    authenticationKind: "api-key",
    catalog: { state: "ready", modelCount: 0, consumers: CONSUMERS },
    actionIds: ["login"],
  }]);
  assert.equal(JSON.stringify(await source.inspect()).includes(secret), false);

  assert.deepEqual(await source.startLogin(), {
    operationId: "codex2-login",
    target: "codex2",
    owner: "codex2",
    interactive: true,
    visibleTerminalRequired: true,
    executed: false,
    command: "codex.cmd",
    args: ["login"],
    methods: [
      { id: "browser", command: "codex.cmd", args: ["login"] },
      { id: "device-auth", command: "codex.cmd", args: ["login", "--device-auth"] },
    ],
  });
});

test("Codex 2 source 将缺失与失效认证收敛为状态，不回退其他 Home", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "everyone-connections-codex2-"));
  const source = createCodex2ConnectionSource({ profile: { codexHome: fixture } });

  assert.equal((await source.inspect())[0].state, "not-configured");
  await writeFile(path.join(fixture, "auth.json"), "{}", "utf8");
  const invalid = (await source.inspect())[0];
  assert.equal(invalid.state, "attention-required");
  assert.equal("error" in invalid, false);
});

test("WebGPT source 只读 healthz，丢弃健康响应中的额外正文", async () => {
  const calls = [];
  const source = createWebGptConnectionSource({
    healthUrl: "http://127.0.0.1:17841/healthz",
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          accepting_turns: true,
          mode: "full",
          credential: "fixture-must-not-escape",
        }),
      };
    },
  });

  assert.deepEqual(await source.inspect(), [{
    id: "webgpt",
    label: "ChatGPT Web (WebGPT)",
    scope: "shared-model-source",
    owner: "webgpt",
    state: "connected",
    service: { status: "ok", acceptingTurns: true, mode: "full" },
    catalog: { state: "ready", modelCount: 0, consumers: CONSUMERS },
    actionIds: ["login"],
  }]);
  assert.deepEqual(calls, [["http://127.0.0.1:17841/healthz", {
    method: "GET",
    headers: { accept: "application/json" },
  }]]);
  assert.equal(JSON.stringify(await source.inspect()).includes("fixture-must-not-escape"), false);
  assert.deepEqual(await source.startLogin(), {
    operationId: "webgpt-login",
    target: "webgpt",
    owner: "webgpt",
    interactive: true,
    visibleBrowserRequired: true,
    executed: false,
    action: "open-webgpt-login",
  });
});

test("Harness identity source 只把 adopted 标记为待登录，并复用 Registry 登录计划", async () => {
  const loginCalls = [];
  const registry = {
    list: async () => [
      { id: "pi", commandPath: "C:\\tools\\pi.cmd", version: "0.84.4" },
      { id: "grok", commandPath: "C:\\tools\\grok.exe", version: "1.0.13" },
    ],
    login: async (id) => {
      loginCalls.push(id);
      return {
        id,
        interactive: true,
        visibleTerminalRequired: true,
        command: `C:\\tools\\${id}.cmd`,
        args: ["login"],
      };
    },
  };
  const sources = createHarnessIdentitySources({ registry });
  assert.equal(sources.length, 5);

  const snapshots = (await Promise.all(sources.map((source) => source.inspect()))).flat();
  assert.deepEqual(snapshots.map(({ id, owner, scope, state }) => ({ id, owner, scope, state })), [
    { id: "harness:pi", owner: "harness", scope: "harness-identity", state: "ready-to-login" },
    { id: "harness:omp", owner: "harness", scope: "harness-identity", state: "not-adopted" },
    { id: "harness:deepseek-harness", owner: "harness", scope: "harness-identity", state: "not-adopted" },
    { id: "harness:grok", owner: "harness", scope: "harness-identity", state: "ready-to-login" },
    { id: "harness:claude-code", owner: "harness", scope: "harness-identity", state: "not-adopted" },
  ]);
  assert.equal(snapshots.some(({ state }) => state === "connected"), false);

  const grok = sources.find(({ id }) => id === "harness:grok");
  assert.deepEqual(await grok.startLogin(), {
    id: "grok",
    target: "harness:grok",
    owner: "harness",
    scope: "harness-identity",
    interactive: true,
    visibleTerminalRequired: true,
    command: "C:\\tools\\grok.cmd",
    args: ["login"],
    executed: false,
  });
  assert.deepEqual(loginCalls, ["grok"]);
});

test("聚合工厂产出的 sources 数组可直接交给 ConnectionHub", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "everyone-connections-all-"));
  const registry = { list: async () => [], login: async () => ({}) };
  const sources = createConnectionSources({
    profile: { codexHome: fixture },
    webgptHealthUrl: "http://127.0.0.1:17841/healthz",
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
    registry,
  });
  const hub = new ConnectionHub({
    router: { inspect: async () => [], createCustom: async () => ({}) },
    sources,
    applyBoundary: async () => ({}),
  });

  assert.equal(Array.isArray(sources), true);
  assert.equal(Object.isFrozen(sources), true);
  assert.equal((await hub.inspect()).length, 7);
});
