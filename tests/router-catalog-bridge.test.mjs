import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RouterCatalogBridge } from "../src/router-catalog-bridge.mjs";

const API_MODEL_IDS = [
  "zai-api-cn/glm-5.3-flash",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "nvidia-nim/kimi-k3",
  "nvidia-nim/deepseek-v4-flash-0731",
  "nvidia-nim/deepseek-v4-pro-0813",
  "magicai/gpt-5-6-sol-a",
  "magicai/gpt-5-6-terra-b",
  "magicai/gpt-image-2-c",
  "gmi-cloud/MiniMaxAI/MiniMax-M3",
];

const WEBGPT_MODEL_IDS = [
  "chatgpt-web/light",
  "chatgpt-web/medium",
  "chatgpt-web/high",
  "chatgpt-web/extra-high",
  "chatgpt-web/pro",
];

const NATIVE_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-sol-1m",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-daybreak-blue-latest",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.2",
];

function nativeCatalogFixture() {
  const baseModels = NATIVE_MODEL_IDS.filter((id) => id !== "gpt-5.6-sol-1m");
  return {
    models: [
      ...baseModels.map((slug, priority) => ({
        slug,
        display_name: slug,
        context_window: 256_000,
        priority,
        visibility: "list",
        supported_in_api: true,
        live: true,
      })),
      {
        slug: "gpt-5.3-codex-spark",
        visibility: "list",
        supported_in_api: false,
        live: true,
      },
      {
        slug: "gpt-daybreak-red-latest",
        visibility: "hide",
        supported_in_api: true,
        live: true,
      },
      {
        slug: "gpt-reserve",
        visibility: "list",
        supported_in_api: true,
        live: false,
      },
    ],
  };
}

async function withCatalogFiles(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "everyone-catalog-"));
  const mergedModelsPath = path.join(directory, "merged-models.json");
  const modelPickerPath = path.join(directory, "model-picker.json");
  const visible = [...API_MODEL_IDS, ...WEBGPT_MODEL_IDS, "gpt-5.6-sol-1m"];
  const models = [
    ...visible.map((id) => ({ id, context_window: 1_000_000 })),
    { id: "hidden/provider-model", context_window: 128_000 },
    { id: "offline/provider-model", context_window: 128_000 },
  ];

  await writeFile(mergedModelsPath, JSON.stringify({ models }), "utf8");
  await writeFile(modelPickerPath, JSON.stringify({ visible }), "utf8");

  try {
    await run({ mergedModelsPath, modelPickerPath, models });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("目录桥接向所有 consumer 发布 10 API、5 WebGPT 和 9 个 Codex 2 原生模型", async () => {
  await withCatalogFiles(async ({ mergedModelsPath, modelPickerPath, models }) => {
    const liveIds = models
      .map((model) => model.id)
      .filter((id) => id !== "offline/provider-model");
    const bridge = new RouterCatalogBridge({
      mergedModelsPath,
      modelPickerPath,
      routerModelsUrl: "http://127.0.0.1:4202/v1/models",
      nativeCatalog: nativeCatalogFixture(),
      fetchImpl: async () => new Response(JSON.stringify({ data: liveIds.map((id) => ({ id })) })),
    });

    const codexLease = await bridge.activate({ target: "codex" });
    const harnessLease = await bridge.activate({ target: "external", harnessId: "pi" });

    assert.deepEqual(codexLease.models.map((model) => model.id), [
      ...API_MODEL_IDS,
      ...WEBGPT_MODEL_IDS,
      ...NATIVE_MODEL_IDS,
    ]);
    assert.deepEqual(harnessLease.models.map((model) => model.id), [
      ...API_MODEL_IDS,
      ...WEBGPT_MODEL_IDS,
      ...NATIVE_MODEL_IDS,
    ]);
    assert.equal(codexLease.models.length, 24);
    assert.equal(harnessLease.models.length, 24);
    assert.deepEqual(
      harnessLease.models.map((model) => model.source),
      [
        ...API_MODEL_IDS.map(() => "router-provider"),
        ...WEBGPT_MODEL_IDS.map(() => "webgpt"),
        ...NATIVE_MODEL_IDS.map(() => "native-openai"),
      ],
    );
    assert.equal(codexLease.models.some((model) => model.id === "hidden/provider-model"), false);
    assert.equal(codexLease.models.some((model) => model.id === "gpt-5.3-codex-spark"), false);
  });
});

test("API 和 WebGPT 仍必须同时存在于 picker、merged 和 Router live 目录", async () => {
  await withCatalogFiles(async ({ mergedModelsPath, modelPickerPath, models }) => {
    const bridge = new RouterCatalogBridge({
      mergedModelsPath,
      modelPickerPath,
      routerModelsUrl: "http://127.0.0.1:4202/v1/models",
      nativeCatalog: nativeCatalogFixture(),
      fetchImpl: async () => new Response(JSON.stringify({
        data: models
          .map((model) => model.id)
          .filter((id) => id !== WEBGPT_MODEL_IDS[0])
          .map((id) => ({ id })),
      })),
    });

    const lease = await bridge.activate({ target: "external", harnessId: "grok" });

    assert.equal(lease.allowedModelIds.includes(WEBGPT_MODEL_IDS[0]), false);
    assert.equal(lease.allowedModelIds.includes(WEBGPT_MODEL_IDS[1]), true);
    assert.equal(lease.allowedModelIds.includes("offline/provider-model"), false);
    assert.equal(lease.allowedModelIds.includes("hidden/provider-model"), false);
  });
});

test("目录在读取期间持续变化时失败关闭且不查询 Router", async () => {
  let mergedReadCount = 0;
  let routerCalls = 0;
  const bridge = new RouterCatalogBridge({
    mergedModelsPath: "X:\\fixture\\merged-models.json",
    modelPickerPath: "X:\\fixture\\model-picker.json",
    routerModelsUrl: "http://127.0.0.1:4202/v1/models",
    stabilityAttempts: 2,
    readTextFile: async (filePath) => {
      if (filePath.endsWith("merged-models.json")) {
        mergedReadCount += 1;
        return JSON.stringify({ models: [{ id: `provider/model-${mergedReadCount}` }] });
      }
      return JSON.stringify({ visible: ["provider/model-1"] });
    },
    fetchImpl: async () => {
      routerCalls += 1;
      return new Response(JSON.stringify({ data: [] }));
    },
  });

  await assert.rejects(
    bridge.activate({ kind: "codex" }),
    /catalog_unstable/,
  );
  assert.equal(routerCalls, 0);
});
