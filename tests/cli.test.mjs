import assert from "node:assert/strict";
import test from "node:test";

import { executeCli, parseCli } from "../src/cli.mjs";

test("CLI 将受支持命令解析为稳定的 Controller 调用参数", () => {
  assert.deepEqual(parseCli(["doctor"]), { command: "doctor" });
  assert.deepEqual(
    parseCli([
      "profile",
      "add",
      "secondary",
      "--codex-home",
      "C:\\Profiles\\second",
      "--sqlite-home",
      "C:\\Profiles\\second",
      "--desktop-root",
      "C:\\Desktop\\managed",
      "--desktop-user-data",
      "C:\\Desktop\\ui\\second",
    ]),
    {
      command: "profile.add",
      profile: {
        name: "secondary",
        codexHome: "C:\\Profiles\\second",
        sqliteHome: "C:\\Profiles\\second",
        desktopRoot: "C:\\Desktop\\managed",
        desktopUserData: "C:\\Desktop\\ui\\second",
      },
    },
  );
  assert.deepEqual(
    parseCli([
      "harness",
      "adopt",
      "pi",
      "--path",
      "C:\\Tools\\pi.cmd",
      "--version",
      "0.84.4",
    ]),
    {
      command: "harness.adopt",
      harness: {
        id: "pi",
        commandPath: "C:\\Tools\\pi.cmd",
        version: "0.84.4",
      },
    },
  );
  assert.deepEqual(parseCli(["models", "sync", "--target", "external"]), {
    command: "models.sync",
    target: "external",
  });
  assert.deepEqual(parseCli(["restore", "--lease", "fusion-1"]), {
    command: "restore",
    leaseId: "fusion-1",
  });
  assert.deepEqual(parseCli(["connections", "list"]), { command: "connections.list" });
  assert.deepEqual(parseCli(["connections", "login", "codex2"]), {
    command: "connections.login",
    target: "codex2",
  });
  assert.deepEqual(parseCli(["connections", "remove", "custom-lab"]), {
    command: "connections.remove",
    id: "custom-lab",
  });
  assert.deepEqual(parseCli(["connections", "apply"]), { command: "connections.apply" });
  assert.deepEqual(
    parseCli([
      "connections",
      "add",
      "--label",
      "Lab API",
      "--base-url",
      "https://models.example.test/v1",
      "--protocol",
      "anthropic-messages",
      "--models",
      "claude-lab,claude-fast",
    ]),
    {
      command: "connections.add",
      draft: {
        label: "Lab API",
        baseUrl: "https://models.example.test/v1",
        protocol: "anthropic-messages",
        models: [{ id: "claude-lab" }, { id: "claude-fast" }],
      },
    },
  );
});

test("CLI 拒绝未知命令、缺失参数和任何凭据参数", () => {
  assert.throws(() => parseCli(["profile", "use"]), /用法/);
  assert.throws(() => parseCli(["harness", "adopt", "pi", "--api-key", "secret"]), /凭据参数/);
  assert.throws(() => parseCli(["router", "restart"]), /未知命令/);
  assert.throws(
    () => parseCli(["connections", "add", "--api-key", "secret"]),
    /凭据参数/,
  );
});

test("executeCli 只委托 Controller；login 返回计划而不启动进程", async () => {
  const calls = [];
  const controller = {
    inspect: async () => ({ status: "ok" }),
    loginHarness: async (id) => {
      calls.push(["loginHarness", id]);
      return {
        id,
        interactive: true,
        command: "grok.exe",
        args: ["login"],
      };
    },
    syncModels: async (input) => {
      calls.push(["syncModels", input]);
      return { models: 10 };
    },
    listConnections: async () => {
      calls.push(["listConnections"]);
      return [{ id: "codex2", state: "connected" }];
    },
    applyConnections: async () => {
      calls.push(["applyConnections"]);
      return { applied: true };
    },
  };
  const output = [];
  const stdout = { write: (value) => output.push(value) };

  assert.deepEqual(
    await executeCli(["harness", "login", "grok"], { controller, stdout }),
    {
      id: "grok",
      interactive: true,
      command: "grok.exe",
      args: ["login"],
    },
  );
  assert.deepEqual(
    await executeCli(["models", "sync", "--target", "external"], {
      controller,
      stdout,
    }),
    { models: 10 },
  );
  assert.deepEqual(
    await executeCli(["connections", "list"], { controller, stdout }),
    [{ id: "codex2", state: "connected" }],
  );
  assert.deepEqual(
    await executeCli(["connections", "apply"], { controller, stdout }),
    { applied: true },
  );
  assert.deepEqual(calls, [
    ["loginHarness", "grok"],
    ["syncModels", { target: "external" }],
    ["listConnections"],
    ["applyConnections"],
  ]);
  assert.equal(output.length, 4);
  assert.equal(JSON.parse(output[0]).interactive, true);
});
