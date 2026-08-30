import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionControl } from "../src/connection-control.mjs";

test("ConnectionControl 投影统一 wire、完成加密创建并仅异步触发 apply", async () => {
  const calls = [];
  let entries = [{
    id: "router:deepseek",
    label: "DeepSeek",
    scope: "shared-model-source",
    owner: "router",
    state: "connected",
    catalog: { state: "ready", modelCount: 2, consumers: ["codex", "pi"] },
    actionIds: ["apply"],
  }];
  const hub = {
    inspect: async () => entries,
    createCustom: async (draft) => {
      calls.push(["create", draft]);
      entries = [...entries, {
        id: "lab",
        label: draft.label,
        scope: "shared-model-source",
        owner: "router",
        state: "attention-required",
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        catalog: { state: "unpublished", modelCount: 1, consumers: [] },
        actionIds: ["set-secret", "apply", "remove"],
      }];
      return { id: "lab" };
    },
    startSecretEntry: async () => ({
      operationId: "key-1",
      expiresAt: 99_000,
      publicKeySpkiBase64: "QUJDRA==",
    }),
    submitSecret: async (input) => {
      calls.push(["secret", input]);
      entries[1] = { ...entries[1], state: "connected" };
      return { configured: true };
    },
    startLogin: async (id) => ({ target: id, command: "login" }),
    remove: async (id) => { calls.push(["remove", id]); return { removed: true }; },
  };
  const control = new ConnectionControl({
    hub,
    activity: { inspect: async () => ({ activeCount: 0 }) },
    securePrompt: async () => ({ configured: true }),
    interactiveLogin: async () => ({ state: "waiting-user", message: "Login opened" }),
    startApply: async () => { calls.push(["apply"]); },
  });

  assert.deepEqual(await control.inspect(), {
    connections: [{
      id: "router.deepseek",
      displayName: "DeepSeek",
      scope: "shared-model-source",
      owner: "router",
      kind: "router-provider",
      state: "connected",
      detail: null,
      consumers: ["codex", "pi"],
      modelCount: 2,
      pending: false,
      loginAvailable: false,
      removable: false,
    }],
    pendingCount: 0,
    applyRequired: false,
    activity: { activeTurnCount: 0 },
    operation: null,
  });
  assert.deepEqual(await control.startKeySession(), {
    id: "key-1",
    expiresAtMs: 99_000,
    publicKeySpkiBase64: "QUJDRA==",
  });
  const created = await control.createCustom({
    draft: {
      displayName: "Lab",
      baseUrl: "https://lab.example/v1",
      protocol: "openai-chat-completions",
      modelIds: ["lab-model"],
      keyless: false,
    },
    secret: {
      mode: "encrypted",
      keySessionId: "key-1",
      algorithm: "RSA-OAEP-256",
      ciphertextBase64: "Q0lQSEVS",
    },
  });
  assert.equal(created.connection.id, "lab");
  assert.equal(created.applyRequired, true);
  assert.deepEqual(await control.apply(), {
    operation: {
      id: "connections-apply",
      kind: "apply",
      state: "running",
      message: "Waiting for idle state before applying Connections",
    },
    applyRequired: true,
    publishedModelCount: 2,
  });
  assert.deepEqual(calls, [
    ["create", {
      label: "Lab",
      baseUrl: "https://lab.example/v1",
      protocol: "openai-chat-completions",
      keyless: false,
      models: [{ id: "lab-model" }],
    }],
    ["secret", { operationId: "key-1", ciphertext: "Q0lQSEVS", ownerId: "lab" }],
    ["apply"],
  ]);
});
