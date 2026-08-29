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
});

test("CLI 拒绝未知命令、缺失参数和任何凭据参数", () => {
  assert.throws(() => parseCli(["profile", "use"]), /用法/);
  assert.throws(() => parseCli(["harness", "adopt", "pi", "--api-key", "secret"]), /凭据参数/);
  assert.throws(() => parseCli(["router", "restart"]), /未知命令/);
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
  assert.deepEqual(calls, [
    ["loginHarness", "grok"],
    ["syncModels", { target: "external" }],
  ]);
  assert.equal(output.length, 2);
  assert.equal(JSON.parse(output[0]).interactive, true);
});
