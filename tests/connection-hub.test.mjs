import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionHub } from "../src/connection-hub.mjs";

test("自定义 Connection 创建一次后保持待应用且不接收长期凭据", async () => {
  const created = [];
  const router = {
    inspect: async () => [],
    createCustom: async (draft) => {
      created.push(draft);
      return {
        id: "custom-lab",
        label: draft.label,
        owner: "router",
        scope: "shared-model-source",
        state: "connected",
        catalog: { state: "unpublished", modelCount: 1, consumers: [] },
        actionIds: ["apply", "remove"],
      };
    },
  };
  const hub = new ConnectionHub({
    router,
    sources: [],
    applyBoundary: async () => assert.fail("create must not apply the running catalog"),
  });

  const receipt = await hub.createCustom({
    label: "Lab API",
    baseUrl: "https://models.example.test/v1",
    protocol: "openai-responses",
    models: [{ id: "lab-model" }],
  });

  assert.equal(receipt.id, "custom-lab");
  assert.equal(receipt.catalog.state, "unpublished");
  assert.deepEqual(created, [{
    label: "Lab API",
    baseUrl: "https://models.example.test/v1",
    protocol: "openai-responses",
    keyless: false,
    models: [{ id: "lab-model" }],
  }]);
  const unsafeDraft = {
    label: "Unsafe",
    baseUrl: "https://models.example.test/v1",
    protocol: "openai-responses",
    models: [{ id: "lab-model" }],
  };
  unsafeDraft[["api", "Key"].join("")] = "fixture";
  await assert.rejects(
    hub.createCustom(unsafeDraft),
    /connection_secret_forbidden/,
  );
});

test("apply 等待共享服务空闲后先应用 Router，再一次更新所有 Harness", async () => {
  const calls = [];
  const router = {
    inspect: async () => [],
    createCustom: async () => assert.fail("not used"),
    apply: async () => {
      calls.push("router.apply");
      return { revision: "router-r2", restartRequired: true };
    },
  };
  const hub = new ConnectionHub({
    router,
    sources: [],
    activity: {
      waitUntilIdle: async ({ timeoutMs }) => {
        calls.push(["waitUntilIdle", timeoutMs]);
        return { idle: true };
      },
    },
    applyBoundary: async (input) => {
      calls.push(["fusion.apply", input]);
      return { catalogRevision: "fusion-r2", consumers: 6 };
    },
  });

  assert.deepEqual(await hub.apply({ timeoutMs: 60_000 }), {
    applied: true,
    routerRevision: "router-r2",
    catalogRevision: "fusion-r2",
    consumers: 6,
  });
  assert.deepEqual(calls, [
    ["waitUntilIdle", 60_000],
    "router.apply",
    ["fusion.apply", { routerRevision: "router-r2", restartRequired: true }],
  ]);
});

test("官方登录留在各 owner，remove 只删除精确 Connection", async () => {
  const calls = [];
  const router = {
    inspect: async () => [],
    createCustom: async () => assert.fail("not used"),
    startLogin: async (target) => {
      calls.push(["router.login", target]);
      return { operationId: "router-login-1", target };
    },
    remove: async (id) => {
      calls.push(["router.remove", id]);
      return { removed: true, id };
    },
  };
  const codex2 = {
    id: "codex2",
    inspect: async () => [],
    startLogin: async () => {
      calls.push(["codex2.login"]);
      return { operationId: "codex2-login-1", target: "codex2" };
    },
  };
  const hub = new ConnectionHub({ router, sources: [codex2], applyBoundary: async () => ({}) });

  assert.deepEqual(await hub.startLogin("codex2"), {
    operationId: "codex2-login-1",
    target: "codex2",
  });
  assert.deepEqual(await hub.startLogin("grok-oauth"), {
    operationId: "router-login-1",
    target: "grok-oauth",
  });
  assert.deepEqual(await hub.remove("custom-lab"), { removed: true, id: "custom-lab" });
  assert.deepEqual(calls, [
    ["codex2.login"],
    ["router.login", "grok-oauth"],
    ["router.remove", "custom-lab"],
  ]);
});

test("密钥入口默认走 owner 安全提示，高级模式只暴露一次性公钥会话", async () => {
  const calls = [];
  const router = {
    inspect: async () => [],
    createCustom: async () => assert.fail("not used"),
    startSecretPrompt: async (ownerId) => {
      calls.push(["prompt", ownerId]);
      return { operationId: "prompt-1", mode: "secure-prompt" };
    },
  };
  const secrets = {
    start: async ({ ownerId }) => {
      calls.push(["masked", ownerId]);
      return { operationId: "masked-1", publicKeyJwk: { kty: "RSA" } };
    },
    submit: async (input) => {
      calls.push(["submit", input]);
      return { configured: true };
    },
  };
  const hub = new ConnectionHub({
    router,
    sources: [],
    secrets,
    applyBoundary: async () => ({}),
  });

  assert.deepEqual(await hub.startSecretEntry({ ownerId: "custom-lab" }), {
    operationId: "prompt-1",
    mode: "secure-prompt",
  });
  assert.deepEqual(await hub.startSecretEntry({ ownerId: "custom-lab", mode: "masked" }), {
    operationId: "masked-1",
    publicKeyJwk: { kty: "RSA" },
  });
  assert.deepEqual(await hub.submitSecret({ operationId: "masked-1", ciphertext: "ciphertext" }), {
    configured: true,
  });
  assert.deepEqual(calls, [
    ["prompt", "custom-lab"],
    ["masked", "custom-lab"],
    ["submit", { operationId: "masked-1", ciphertext: "ciphertext" }],
  ]);
});

test("Router 已提交而 Fusion 发布失败时保留可重试标记", async () => {
  let pending = false;
  let failBoundary = true;
  const publication = {
    isPending: async () => pending,
    markPending: async () => { pending = true; },
    clear: async () => { pending = false; },
  };
  const router = {
    inspect: async () => [{
      id: "custom-lab",
      label: "Lab",
      scope: "shared-model-source",
      owner: "router",
      state: "connected",
      catalog: { state: "ready", modelCount: 1, consumers: ["codex"] },
      actionIds: ["apply", "remove"],
    }],
    createCustom: async () => ({}),
    apply: async () => ({ revision: "r3", restartRequired: false }),
  };
  const hub = new ConnectionHub({
    router,
    publication,
    applyBoundary: async () => {
      if (failBoundary) throw new Error("fixture_publish_failed");
      return { catalogRevision: "c3", consumers: 6 };
    },
  });

  await assert.rejects(hub.apply(), /fixture_publish_failed/);
  assert.equal(pending, true);
  assert.deepEqual((await hub.inspect())[0].catalog, {
    state: "unpublished",
    modelCount: 1,
    consumers: [],
  });
  failBoundary = false;
  await hub.apply();
  assert.equal(pending, false);
});
