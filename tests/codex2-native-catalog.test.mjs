import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  fetchCodex2NativeCatalog,
  parseCodex2AuthJson,
  selectCodex2NativeModels,
} from "../src/codex2-native-catalog.mjs";

function jwtWithExpiration(exp) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}

test("原生目录只保留 list、API 可用且 live 的模型，并在 Sol 后加入 1M 变体", () => {
  const selected = selectCodex2NativeModels({
    models: [
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6 Sol",
        context_window: 272_000,
        visibility: "list",
        supported_in_api: true,
        live: true,
      },
      {
        slug: "gpt-5.4",
        display_name: "GPT-5.4",
        visibility: "list",
        supported_in_api: true,
        live: true,
      },
      { slug: "gpt-hidden", visibility: "hide", supported_in_api: true, live: true },
      { slug: "gpt-not-api", visibility: "list", supported_in_api: false, live: true },
      { slug: "gpt-offline", visibility: "list", supported_in_api: true, live: false },
      { slug: "provider/external", visibility: "list", supported_in_api: true, live: true },
    ],
  });

  assert.deepEqual(selected.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-sol-1m",
    "gpt-5.4",
  ]);
  assert.equal(selected.every((model) => model.source === "native-openai"), true);
  assert.equal(selected[1].display_name, "GPT-5.6 Sol 1M");
  assert.equal(selected[1].context_window, 1_000_000);
});

test("基础 Sol 不存在时绝不单独发布 Sol 1M", () => {
  const selected = selectCodex2NativeModels({
    models: [{
      slug: "gpt-5.4",
      visibility: "list",
      supported_in_api: true,
      live: true,
    }],
  });

  assert.equal(selected.some((model) => model.id === "gpt-5.6-sol-1m"), false);
});

test("Codex debug models 的账号目录本身视为 live，不要求不存在的 live 字段", () => {
  const selected = selectCodex2NativeModels({
    models: [
      {
        slug: "gpt-5.6-sol",
        visibility: "list",
        supported_in_api: true,
        context_window: 272_000,
      },
      {
        slug: "gpt-5.4",
        visibility: "hide",
        supported_in_api: true,
        context_window: 272_000,
      },
      {
        slug: "gpt-5.2",
        visibility: "list",
        supported_in_api: true,
        context_window: 272_000,
      },
    ],
  });

  assert.deepEqual(selected.map((model) => model.id), [
    "gpt-5.6-sol",
    "gpt-5.6-sol-1m",
    "gpt-5.2",
  ]);
});

test("Codex 2 OAuth 认证仅以闭包写入请求头，不会进入 JSON、日志或 inspect", () => {
  const secret = jwtWithExpiration(2_000_000_000);
  const session = parseCodex2AuthJson(JSON.stringify({
    tokens: { access_token: secret, account_id: "account-codex2-only" },
  }), { now: 1_900_000_000_000 });
  const headers = new Headers({ "x-test": "ok" });

  session.applyToHeaders(headers);

  assert.equal(headers.get("authorization"), `Bearer ${secret}`);
  assert.equal(headers.get("chatgpt-account-id"), "account-codex2-only");
  assert.equal(JSON.stringify(session).includes(secret), false);
  assert.equal(inspect(session).includes(secret), false);
  assert.deepEqual(JSON.parse(JSON.stringify(session)), { available: true, kind: "oauth" });
});

test("Codex 2 静态 API key 可在内存使用但不可序列化", () => {
  const secret = "codex2-only-test-secret";
  const session = parseCodex2AuthJson(JSON.stringify({ OPENAI_API_KEY: secret }));
  const headers = {};

  session.applyToHeaders(headers);

  assert.equal(headers.authorization, `Bearer ${secret}`);
  assert.equal(JSON.stringify(session).includes(secret), false);
});

test("认证缺失、无过期信息的 OAuth token 和已过期 token 均失败关闭", () => {
  assert.throws(() => parseCodex2AuthJson("{}"), /codex2_auth_missing/);
  assert.throws(
    () => parseCodex2AuthJson(JSON.stringify({ tokens: { access_token: "opaque" } })),
    /codex2_auth_expiration_missing/,
  );
  assert.throws(
    () => parseCodex2AuthJson(JSON.stringify({
      tokens: { access_token: jwtWithExpiration(100) },
    }), { now: 101_000 }),
    /codex2_auth_expired/,
  );
});

test("解析器只接受注入的 auth.json 文本，不提供默认或 Codex 1 路径入口", () => {
  assert.equal(parseCodex2AuthJson.length, 1);
  assert.throws(() => parseCodex2AuthJson("not json"), /codex2_auth_invalid/);
});

test("实时目录 helper 只经内存参数接收 OAuth，并校验账号目录结构", async () => {
  const secret = jwtWithExpiration(2_000_000_000);
  const session = parseCodex2AuthJson(JSON.stringify({
    tokens: { access_token: secret, account_id: "account-codex2-only" },
  }), { now: 1_900_000_000_000 });
  let observed;

  const catalog = await fetchCodex2NativeCatalog(session, {
    clientVersion: "0.147.0",
    runHelper: async (input) => {
      observed = input;
      return JSON.stringify({ models: [{ slug: "gpt-5.6-sol" }] });
    },
  });

  assert.deepEqual(catalog, { models: [{ slug: "gpt-5.6-sol" }] });
  assert.equal(observed.authorization, `Bearer ${secret}`);
  assert.equal(observed.accountId, "account-codex2-only");
  assert.equal(observed.clientVersion, "0.147.0");
  assert.equal(JSON.stringify(catalog).includes(secret), false);
  await assert.rejects(
    fetchCodex2NativeCatalog(session, {
      clientVersion: "0.147.0",
      runHelper: async () => "{}",
    }),
    /codex2_native_catalog_invalid/,
  );
});
