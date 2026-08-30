import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  anthropicToResponsesRequest,
  countAnthropicTokens,
  createResponsesSseToAnthropicTransform,
  responsesToAnthropicResponse,
} from "../src/anthropic-facade.mjs";

test("Anthropic Messages 转换文本、图片、工具和 max 推理档位", () => {
  const converted = anthropicToResponsesRequest({
    model: "chatgpt-web/pro",
    system: [{ type: "text", text: "system-text" }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "question" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.txt" } }],
      },
      {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [
            { type: "text", text: "file-body" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
            },
          ],
        }],
      },
    ],
    tools: [{ name: "read_file", description: "Read", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "read_file" },
    thinking: { type: "enabled", budget_tokens: 8_000 },
    stream: false,
  });

  assert.equal(converted.model, "chatgpt-web/pro");
  assert.equal(converted.instructions, "system-text");
  assert.equal(converted.reasoning.effort, "max");
  assert.deepEqual(converted.tools, [{
    type: "function",
    name: "read_file",
    description: "Read",
    parameters: { type: "object" },
  }]);
  assert.deepEqual(converted.tool_choice, { type: "function", name: "read_file" });
  assert.deepEqual(converted.input[0].content[1], {
    type: "input_image",
    image_url: "data:image/png;base64,aW1hZ2U=",
  });
  assert.deepEqual(converted.input[1], {
    type: "function_call",
    call_id: "tool-1",
    name: "read_file",
    arguments: "{\"path\":\"a.txt\"}",
  });
  assert.deepEqual(converted.input[2], {
    type: "function_call_output",
    call_id: "tool-1",
    output: [
      { type: "input_text", text: "file-body" },
      { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
    ],
  });
});

test("Responses 非流式结果转换 Anthropic 文本、tool_use、停止原因与用量", () => {
  const converted = responsesToAnthropicResponse({
    id: "resp-1",
    model: "gpt-5.6-sol",
    status: "completed",
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "summary" }] },
      { type: "message", content: [{ type: "output_text", text: "answer" }] },
      { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"a\"}" },
    ],
    usage: { input_tokens: 12, output_tokens: 7 },
  });
  assert.equal(converted.type, "message");
  assert.equal(converted.stop_reason, "tool_use");
  assert.deepEqual(converted.content, [
    { type: "text", text: "answer" },
    { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a" } },
  ]);
  assert.deepEqual(converted.usage, { input_tokens: 12, output_tokens: 7 });
});

test("Responses SSE 转换为合法 Anthropic Messages SSE", async () => {
  const source = Readable.from([
    'data: {"type":"response.created","response":{"id":"resp-1","model":"gpt-5.6-sol","usage":{"input_tokens":3}}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"hel"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp-1","model":"gpt-5.6-sol","usage":{"input_tokens":3,"output_tokens":2}}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const output = [];
  for await (const chunk of source.pipe(createResponsesSseToAnthropicTransform())) {
    output.push(chunk.toString("utf8"));
  }
  const text = output.join("");
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /"text":"hel"/);
  assert.match(text, /event: message_delta/);
  assert.match(text, /"output_tokens":2/);
  assert.match(text, /event: message_stop/);
  assert.doesNotMatch(text, /\[DONE\]/);
});

test("Responses 工具流转换 tool_use 与 input_json_delta", async () => {
  const source = Readable.from([
    'data: {"type":"response.created","response":{"id":"resp-tool","model":"gpt-5.6-sol"}}\n\n',
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1","name":"read_file"}}\n\n',
    'data: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":\\"a"}\n\n',
    'data: {"type":"response.function_call_arguments.delta","delta":".txt\\"}"}\n\n',
    'data: {"type":"response.output_item.done","item":{"type":"function_call"}}\n\n',
    'data: {"type":"response.completed","response":{"usage":{"output_tokens":4}}}\n\n',
  ]);
  const output = [];
  for await (const chunk of source.pipe(createResponsesSseToAnthropicTransform())) {
    output.push(chunk.toString("utf8"));
  }
  const text = output.join("");
  assert.match(text, /"type":"tool_use"/);
  assert.match(text, /"type":"input_json_delta"/);
  assert.ok(text.includes('"partial_json":"{\\"path'));
  assert.match(text, /event: content_block_stop/);
});

test("Responses 流式失败转换为脱敏 Anthropic error 事件", async () => {
  const source = Readable.from([
    'data: {"type":"response.failed","response":{"error":{"message":"private upstream detail"}}}\n\n',
  ]);
  const output = [];
  for await (const chunk of source.pipe(createResponsesSseToAnthropicTransform())) {
    output.push(chunk.toString());
  }
  const text = output.join("");
  assert.match(text, /event: error/);
  assert.match(text, /Upstream response failed/);
  assert.doesNotMatch(text, /private upstream detail/);
});

test("count_tokens 使用本地保守计数且不依赖网络", () => {
  assert.deepEqual(countAnthropicTokens({
    system: "abc",
    messages: [{ role: "user", content: "123456" }],
    tools: [{ name: "x", input_schema: { type: "object" } }],
  }), { input_tokens: 40 });
});
