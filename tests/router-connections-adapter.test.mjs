import assert from "node:assert/strict";
import test from "node:test";

import { RouterConnectionAdapter } from "../src/router-connections-adapter.mjs";

test("Router Adapter 通过 stdin 创建 Connection 与设置密钥，参数和快照不含明文", async () => {
  const calls = [];
  const run = async (args, options = {}) => {
    calls.push({ args, stdin: options.stdin?.toString("utf8") ?? null });
    if (args.join(" ") === "providers list --json") {
      return { providers: [{ id: "deepseek", name: "DeepSeek API", visible: true, configured: true }] };
    }
    if (args.join(" ") === "connections list") {
      return { active: [], candidate: [], pending: false, restartRequired: false };
    }
    if (args.join(" ") === "connections create") {
      return { id: "lab-api", displayName: "Lab API", models: [{ id: "lab-model" }] };
    }
    if (args.join(" ") === "connections secret-set lab-api") {
      return { id: "lab-api", configured: true };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const adapter = new RouterConnectionAdapter({
    run,
    restart: async () => {
      calls.push({ args: ["service", "restart"], stdin: null });
      return { state: "running", healthy: true };
    },
  });

  const inspected = await adapter.inspect();
  assert.equal(inspected[0].id, "router:deepseek");
  const created = await adapter.createCustom({
    label: "Lab API",
    baseUrl: "https://models.example.test/v1",
    protocol: "openai-chat-completions",
    models: [{ id: "lab-model" }],
  });
  assert.equal(created.id, "lab-api");
  const secret = Buffer.from("fixture-value", "utf8");
  await adapter.submitSecret({ ownerId: "lab-api", secret });
  await adapter.restart();

  assert.deepEqual(calls.map(({ args }) => args), [
    ["providers", "list", "--json"],
    ["connections", "list"],
    ["connections", "create"],
    ["connections", "secret-set", "lab-api"],
    ["service", "restart"],
  ]);
  assert.equal(calls[2].stdin.includes("models.example.test"), true);
  assert.equal(JSON.parse(calls[2].stdin).protocol, "openai-chat");
  assert.equal(calls[3].stdin, "fixture-value");
  assert.equal(JSON.stringify(calls.map(({ args }) => args)).includes("fixture-value"), false);
});
