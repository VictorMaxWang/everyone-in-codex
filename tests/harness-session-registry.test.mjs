import assert from "node:assert/strict";
import test from "node:test";

import { HarnessSessionRegistry } from "../src/harness-session-registry.mjs";

const CONTEXT = Object.freeze({
  harnessId: "pi",
  sessionId: "pi-session-1",
  cwd: "D:\\fixture",
  workspaceRoots: ["D:\\fixture"],
  permissionMode: "read-only",
});

test("host capability 是注册 Harness 会话的唯一入口", () => {
  const registry = new HarnessSessionRegistry({
    hostCapability: "host-capability-for-test",
    randomToken: () => "session-token-for-test",
  });

  assert.throws(
    () => registry.register({ hostCapability: "wrong", consumerId: "pi", context: CONTEXT }),
    /invalid_host_capability/,
  );

  const receipt = registry.register({
    hostCapability: "host-capability-for-test",
    consumerId: "pi",
    context: CONTEXT,
  });
  assert.equal(receipt.sessionToken, "session-token-for-test");
  assert.equal(JSON.stringify(receipt).includes("session-token-for-test"), false);
  assert.equal(registry.authorize({
    sessionToken: receipt.sessionToken,
    consumerId: "pi",
    harnessId: "pi",
  }).context.sessionId, "pi-session-1");
});

test("会话 token 绑定 consumer/harness，撤销和到期后失败关闭", () => {
  let now = 1_000;
  const registry = new HarnessSessionRegistry({
    hostCapability: "host-capability-for-test",
    ttlMs: 500,
    now: () => now,
    randomToken: () => "session-token-for-test",
  });
  const receipt = registry.register({
    hostCapability: "host-capability-for-test",
    consumerId: "pi",
    context: CONTEXT,
  });

  assert.throws(() => registry.authorize({
    sessionToken: receipt.sessionToken,
    consumerId: "omp",
    harnessId: "pi",
  }), /invalid_session/);
  assert.throws(() => registry.authorize({
    sessionToken: receipt.sessionToken,
    consumerId: "pi",
    harnessId: "grok",
  }), /invalid_session/);

  now = 1_501;
  assert.throws(() => registry.authorize({
    sessionToken: receipt.sessionToken,
    consumerId: "pi",
    harnessId: "pi",
  }), /session_expired/);

  now = 2_000;
  const replacement = registry.register({
    hostCapability: "host-capability-for-test",
    consumerId: "pi",
    context: { ...CONTEXT, sessionId: "pi-session-2" },
  });
  registry.revoke({
    hostCapability: "host-capability-for-test",
    sessionToken: replacement.sessionToken,
  });
  assert.throws(() => registry.authorize({
    sessionToken: replacement.sessionToken,
    consumerId: "pi",
    harnessId: "pi",
  }), /invalid_session/);
});

test("默认 Session token 随 Harness Session 撤销，不因固定 30 分钟过期", () => {
  let now = 1_000;
  const registry = new HarnessSessionRegistry({
    hostCapability: "host-capability-for-test",
    now: () => now,
    randomToken: () => "session-lifetime-token",
  });
  const receipt = registry.register({
    hostCapability: "host-capability-for-test",
    consumerId: "pi",
    context: CONTEXT,
  });

  now += 24 * 60 * 60 * 1_000;
  assert.equal(registry.authorize({
    sessionToken: receipt.sessionToken,
    consumerId: "pi",
    harnessId: "pi",
  }).context.sessionId, CONTEXT.sessionId);
});
