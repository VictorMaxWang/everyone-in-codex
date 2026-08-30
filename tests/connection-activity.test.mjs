import assert from "node:assert/strict";
import test from "node:test";

import { ConnectionActivityProbe } from "../src/connection-activity.mjs";

test("Connection apply 等到 Router 与 Fusion 同时空闲且不泄露活动正文", async () => {
  let routerChecks = 0;
  let fusionChecks = 0;
  let clock = 0;
  const probe = new ConnectionActivityProbe({
    routerHealthUrl: "http://127.0.0.1:4202/health",
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      activity: { activeCount: routerChecks++ === 0 ? 1 : 0, sessionName: "private title" },
    })),
    fusionActivity: async () => ({ activeCount: fusionChecks++ === 0 ? 1 : 0 }),
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
    intervalMs: 100,
  });

  const result = await probe.waitUntilIdle({ timeoutMs: 1_000 });
  assert.deepEqual(result, { idle: true, waitedMs: 100 });
  assert.equal(JSON.stringify(result).includes("private title"), false);
});

test("Connection activity 单次检查只返回聚合活动数", async () => {
  const probe = new ConnectionActivityProbe({
    routerHealthUrl: "http://127.0.0.1:4202/health",
    fetchImpl: async () => new Response(JSON.stringify({ activity: { activeCount: 3 } })),
    fusionActivity: async () => ({ activeCount: 2 }),
  });
  assert.deepEqual(await probe.inspect(), { activeCount: 3 });
});
