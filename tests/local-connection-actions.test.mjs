import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createInteractiveLoginAction } from "../src/local-connection-actions.mjs";

test("交互登录通过可见子窗口 helper 启动，并保留隔离 Profile 环境", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => { calls.push(["unref"]); };
  const start = createInteractiveLoginAction({
    powershellExecutable: "pwsh-fixture.exe",
    launcherScript: "C:\\fixture\\start-interactive-login.ps1",
    sourceEnvironment: { PATH: "fixture-path" },
    spawnImpl: (command, args, options) => {
      calls.push(["spawn", command, args, options]);
      return child;
    },
  });

  assert.deepEqual(await start({
    command: "C:\\Codex 2\\codex.exe",
    args: ["login", "--device-auth"],
    environment: { CODEX_HOME: "C:\\Profiles\\second" },
  }), { state: "waiting-user", message: "Login window opened" });
  const encoded = calls[0][2].at(-1);
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")), {
    command: "C:\\Codex 2\\codex.exe",
    args: ["login", "--device-auth"],
    environment: { CODEX_HOME: "C:\\Profiles\\second" },
  });
  assert.equal(calls[0][3].windowsHide, true);
  assert.deepEqual(calls[1], ["unref"]);
});
