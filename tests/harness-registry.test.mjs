import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_HARNESS_SPECS,
  HarnessRegistry,
} from "../src/harness-registry.mjs";

test("内置 Harness 清单公开锁定的兼容等级和启动环境映射", () => {
  assert.deepEqual(
    DEFAULT_HARNESS_SPECS.map(({ id, version, compatibility }) => ({
      id,
      version,
      compatibility,
    })),
    [
      { id: "pi", version: "0.84.4", compatibility: "full" },
      { id: "omp", version: "18.0.10", compatibility: "inference-only" },
      {
        id: "deepseek-harness",
        version: "0.1.1-rc.2",
        compatibility: "full-preview",
      },
      { id: "grok", version: "1.0.13", compatibility: "probe-required" },
      { id: "claude-code", version: "2.1.220", compatibility: "native-only" },
    ],
  );

  assert.deepEqual(
    Object.fromEntries(
      DEFAULT_HARNESS_SPECS.map((spec) => [spec.id, spec.commandEnvironment]),
    ),
    {
      pi: "CODEXHOST_PI_COMMAND",
      omp: "CODEXHOST_OMP_COMMAND",
      "deepseek-harness": "CODEXHOST_DEEPSEEK_HARNESS_COMMAND",
      grok: "CODEXHOST_GROK_COMMAND",
      "claude-code": "CODEXHOST_CLAUDE_COMMAND",
    },
  );
});

test("adopt 只登记现有命令，不移动命令文件或接管更新", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "everyone-harness-"));
  const commandPath = path.join(fixture, "pi.cmd");
  const stateFile = path.join(fixture, "state", "harnesses.json");
  await writeFile(commandPath, "@echo off\r\n", "utf8");

  const registry = new HarnessRegistry({ stateFile });
  const adopted = await registry.adopt({
    id: "pi",
    version: "0.84.4",
    commandPath,
  });

  assert.equal(adopted.id, "pi");
  assert.equal(adopted.commandPath, commandPath);
  assert.equal(adopted.managed, false);
  assert.equal(await readFile(commandPath, "utf8"), "@echo off\r\n");
  assert.deepEqual(await registry.list(), [adopted]);

  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.harnesses.pi.commandPath, commandPath);
  assert.equal(persisted.harnesses.pi.version, "0.84.4");
  assert.equal("credential" in persisted.harnesses.pi, false);
});

test("login 只返回可见交互终端计划，remove 只删除登记记录", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "everyone-harness-"));
  const commandPath = path.join(fixture, "grok.exe");
  const stateFile = path.join(fixture, "harnesses.json");
  await writeFile(commandPath, "fixture", "utf8");

  const registry = new HarnessRegistry({ stateFile });
  await registry.adopt({ id: "grok", version: "1.0.13", commandPath });

  assert.deepEqual(await registry.login("grok"), {
    id: "grok",
    interactive: true,
    visibleTerminalRequired: true,
    command: commandPath,
    args: ["login"],
    instruction: "请在可见交互终端中完成 Grok 登录。",
  });
  assert.deepEqual(await registry.remove("grok"), {
    id: "grok",
    removed: true,
    commandPath,
  });
  assert.deepEqual(await registry.list(), []);
  assert.equal(await readFile(commandPath, "utf8"), "fixture");
});

test("adopt 拒绝未知 Harness、版本漂移和非绝对命令路径", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "everyone-harness-"));
  const registry = new HarnessRegistry({
    stateFile: path.join(fixture, "harnesses.json"),
  });

  await assert.rejects(
    registry.adopt({ id: "unknown", version: "1.0.0", commandPath: "x.exe" }),
    /未知 Harness/,
  );
  await assert.rejects(
    registry.adopt({ id: "pi", version: "latest", commandPath: "x.exe" }),
    /锁定版本 0\.84\.4/,
  );
  await assert.rejects(
    registry.adopt({ id: "pi", version: "0.84.4", commandPath: "pi.cmd" }),
    /绝对路径/,
  );
});
