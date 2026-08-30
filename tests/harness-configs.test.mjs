import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  publishHarnessConfigs,
  restoreHarnessConfigs,
} from "../src/harness-configs.mjs";

const GATEWAY_BASE_URLS = Object.freeze({
  pi: "http://127.0.0.1:45101/pi-lease",
  omp: "http://127.0.0.1:45102/omp-lease",
  "deepseek-harness": "http://127.0.0.1:45103/dsh-lease",
  grok: "http://127.0.0.1:45104/grok-lease",
});

const MODELS = Object.freeze([
  {
    id: "provider/api-model",
    display_name: "API Model",
    context_window: 100_000,
    supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
  },
  {
    id: "chatgpt-web/pro",
    display_name: "ChatGPT Pro",
    context_window: 336_579,
    supported_reasoning_levels: [{ effort: "ultra" }],
  },
  {
    id: "gpt-5.6-sol",
    display_name: "GPT-5.6 Sol",
    context_window: 1_050_000,
    supported_reasoning_levels: ["high", "max", "ultra"],
  },
]);

async function publish(root) {
  return publishHarnessConfigs({
    root,
    gatewayBaseUrls: GATEWAY_BASE_URLS,
    models: MODELS,
    loopbackPortAllocator: async () => 52_321,
  });
}

async function configTexts(root) {
  return {
    pi: await readFile(path.join(root, "pi", "models.json"), "utf8"),
    omp: await readFile(path.join(root, "omp", "models.yml"), "utf8"),
    dsh: await readFile(path.join(root, "dsh", "settings.yaml"), "utf8"),
    grok: await readFile(path.join(root, "grok", "config.toml"), "utf8"),
  };
}

test("四个 Harness 使用各自 Gateway 与固定 capability 引用，并发布 WebGPT/原生模型", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eic-harness-configs-"));
  const published = await publish(root);
  const texts = await configTexts(root);

  assert.match(texts.pi, /http:\/\/127\.0\.0\.1:45101\/v1/);
  assert.match(texts.omp, /http:\/\/127\.0\.0\.1:45102\/v1/);
  assert.match(texts.dsh, /http:\/\/127\.0\.0\.1:45103\/v1/);
  assert.match(texts.grok, /http:\/\/127\.0\.0\.1:45104\/v1/);

  assert.match(texts.pi, /EVERYONE_CODEX_PI_LEASE_CAPABILITY/);
  assert.match(texts.omp, /EVERYONE_CODEX_OMP_LEASE_CAPABILITY/);
  assert.match(texts.dsh, /EVERYONE_CODEX_DSH_LEASE_CAPABILITY/);
  assert.match(texts.grok, /EVERYONE_CODEX_GROK_LEASE_CAPABILITY/);
  for (const text of Object.values(texts)) {
    assert.doesNotMatch(text, /EVERYONE_CODEX_SESSION_TOKEN/);
    assert.match(text, /chatgpt-web\/pro/);
    assert.match(text, /gpt-5\.6-sol/);
    assert.doesNotMatch(text, /EVERYONE_CODEX_EXTERNAL_LEASE_CAPABILITY/);
  }
  assert.match(texts.grok, /"x-everyone-codex-harness" = "grok"/);

  const restored = await restoreHarnessConfigs(published.ownership, { expectedRoot: root });
  assert.equal(restored.removed.length, 4);
  assert.deepEqual(restored.preserved, []);
});

test("外部 Harness 将 ultra 折叠为 max，且 WebGPT Pro 只显示 max", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eic-harness-reasoning-"));
  const published = await publish(root);
  const texts = await configTexts(root);

  for (const text of [texts.pi, texts.omp, texts.dsh]) {
    assert.doesNotMatch(text, /ultra/);
    assert.match(text, /max/);
  }
  const grokModels = JSON.parse(published.environment.CODEXHOST_GROK_MODELS_JSON);
  assert.equal(grokModels.some((model) => model.reasoningLevels.includes("ultra")), false);
  assert.equal(grokModels.every((model) => model.reasoningLevels.includes("max")), true);

  const pi = JSON.parse(texts.pi);
  const pro = pi.providers["everyone-in-codex"].models.find(
    (model) => model.id === "chatgpt-web/pro",
  );
  assert.equal(pro.reasoning, true);
  assert.deepEqual(pro.thinkingLevelMap, { max: "max" });

  await restoreHarnessConfigs(published.ownership, { expectedRoot: root });
});

test("缺少任一 Harness Gateway 时失败关闭且不留下受管文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eic-harness-invalid-"));
  await assert.rejects(
    publishHarnessConfigs({
      root,
      gatewayBaseUrls: { ...GATEWAY_BASE_URLS, grok: undefined },
      models: MODELS,
    }),
    /external_gateway_urls_invalid/,
  );
});
