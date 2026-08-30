import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalFusionRuntime } from "../src/local-runtime.mjs";

test("本机 runtime 从每个精确租约的非敏感健康面汇总活动数", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eic-activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const leaseDirectory = path.join(root, "leases");
  await mkdir(leaseDirectory, { recursive: true });
  await writeFile(path.join(leaseDirectory, "lease-one.json"), JSON.stringify({
    schemaVersion: 1,
    leaseId: "lease-one",
    gatewayBaseUrl: "http://127.0.0.1:40123",
  }));
  const seen = [];
  const runtime = new LocalFusionRuntime({
    configPath: path.join(root, "fusion.json"),
    validationPolicyPath: path.join(root, "policy.json"),
    stateRoot: root,
    harnesses: { list: async () => [] },
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ status: "ok", activity: { activeCount: 2 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(await runtime.activity.inspect(), { activeCount: 2 });
  assert.deepEqual(seen, ["http://127.0.0.1:40123/healthz"]);
});
