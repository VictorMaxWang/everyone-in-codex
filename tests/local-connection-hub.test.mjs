import assert from "node:assert/strict";
import test from "node:test";

import { createLocalConnectionHub } from "../src/local-connection-hub.mjs";

test("本机 apply 只在空闲后重启所需 Router，并精确替换当前 Fusion lease", async () => {
  const calls = [];
  const profile = { name: "second" };
  const router = {
    inspect: async () => [],
    createCustom: async () => assert.fail("not used"),
    apply: async () => ({ revision: "router-r3", restartRequired: true }),
    restart: async () => { calls.push("router.restart"); },
  };
  const runtime = {
    catalogBridge: {
      activate: async ({ target, profile: selected }) => {
        calls.push(["sync", target, selected]);
        return { target, catalogRevision: `${target}-r3` };
      },
    },
    launcher: {
      inspect: async () => ({ running: true, leases: [{ leaseId: "lease-v2" }] }),
      restore: async ({ leaseId }) => { calls.push(["restore", leaseId]); },
      launch: async ({ profile: selected }) => {
        calls.push(["launch", selected]);
        return { leaseId: "lease-v3" };
      },
    },
  };
  const hub = createLocalConnectionHub({
    router,
    sources: [],
    activity: { waitUntilIdle: async () => ({ idle: true, waitedMs: 0 }) },
    profiles: { getActive: async () => profile },
    runtime,
  });

  const applied = await hub.apply({ timeoutMs: 60_000 });
  assert.equal(applied.applied, true);
  assert.equal(applied.consumers, 6);
  assert.deepEqual(calls, [
    "router.restart",
    ["sync", "codex", profile],
    ["sync", "external", profile],
    ["restore", "lease-v2"],
    ["launch", profile],
  ]);
});
