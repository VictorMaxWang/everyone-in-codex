import { Transform } from "node:stream";

function textFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function normalizeEffort(body) {
  const requested = body?.reasoning_effort ?? body?.metadata?.reasoning_effort;
  if (requested === "ultra") return "max";
  if (["low", "medium", "high", "max"].includes(requested)) return requested;
  if (body?.thinking?.type === "enabled" || body?.thinking?.type === "adaptive") return "max";
  return undefined;
}

function anthropicBlockToResponses(block, role) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text" && typeof block.text === "string") {
    return { type: role === "assistant" ? "output_text" : "input_text", text: block.text };
  }
  if (block.type === "image" && block.source?.type === "base64") {
    return {
      type: "input_image",
      image_url: `data:${block.source.media_type};base64,${block.source.data}`,
    };
  }
  if (block.type === "image" && block.source?.type === "url") {
    return { type: "input_image", image_url: block.source.url };
  }
  return null;
}

function toolResultOutput(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  const converted = content
    .map((block) => anthropicBlockToResponses(block, "user"))
    .filter((block) => block?.type === "input_text" || block?.type === "input_image");
  return converted.length > 0 ? converted : "";
}

function messageToResponsesItems(message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  if (typeof message?.content === "string") {
    return [{
      type: "message",
      role,
      content: [{
        type: role === "assistant" ? "output_text" : "input_text",
        text: message.content,
      }],
    }];
  }
  const content = Array.isArray(message?.content) ? message.content : [];
  const items = [];
  const messageContent = [];
  for (const block of content) {
    if (block?.type === "tool_use") {
      if (messageContent.length > 0) {
        items.push({ type: "message", role, content: messageContent.splice(0) });
      }
      items.push({
        type: "function_call",
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
      continue;
    }
    if (block?.type === "tool_result") {
      if (messageContent.length > 0) {
        items.push({ type: "message", role, content: messageContent.splice(0) });
      }
      items.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: toolResultOutput(block.content),
      });
      continue;
    }
    const converted = anthropicBlockToResponses(block, role);
    if (converted) messageContent.push(converted);
  }
  if (messageContent.length > 0) items.push({ type: "message", role, content: messageContent });
  return items;
}

function convertToolChoice(toolChoice) {
  if (!toolChoice || toolChoice.type === "auto") return "auto";
  if (toolChoice.type === "any") return "required";
  if (toolChoice.type === "none") return "none";
  if (toolChoice.type === "tool" && typeof toolChoice.name === "string") {
    return { type: "function", name: toolChoice.name };
  }
  return "auto";
}

export function anthropicToResponsesRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("invalid_anthropic_request");
  }
  const result = {
    model: body.model,
    input: (Array.isArray(body.messages) ? body.messages : []).flatMap(messageToResponsesItems),
    stream: body.stream === true,
  };
  const instructions = textFromAnthropicContent(body.system);
  if (instructions) result.instructions = instructions;
  if (Array.isArray(body.tools)) {
    result.tools = body.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema ?? { type: "object" },
    }));
    result.tool_choice = convertToolChoice(body.tool_choice);
  }
  if (Number.isInteger(body.max_tokens) && body.max_tokens > 0) {
    result.max_output_tokens = body.max_tokens;
  }
  const effort = normalizeEffort(body);
  if (effort) result.reasoning = { effort };
  return result;
}

function parseArguments(value) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function responsesToAnthropicResponse(response) {
  const content = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    // Responses reasoning 没有 Anthropic 可验证 signature；伪造空 signature 会让
    // Claude Code 在下一轮回放时被上游拒绝，因此只转换可安全往返的内容块。
    if (item?.type === "message") {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (block?.type === "output_text" && typeof block.text === "string") {
          content.push({ type: "text", text: block.text });
        }
      }
    } else if (item?.type === "function_call") {
      content.push({
        type: "tool_use",
        id: item.call_id ?? item.id,
        name: item.name,
        input: parseArguments(item.arguments),
      });
    }
  }
  const hasToolUse = content.some((block) => block.type === "tool_use");
  const usage = response?.usage ?? {};
  return {
    id: response?.id ?? "message_unknown",
    type: "message",
    role: "assistant",
    model: response?.model ?? "unknown",
    content,
    stop_reason: hasToolUse ? "tool_use" : response?.status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.input_tokens) || 0,
      output_tokens: Number(usage.output_tokens) || 0,
    },
  };
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function createResponsesSseToAnthropicTransform() {
  let pending = "";
  let messageId = "message_unknown";
  let model = "unknown";
  let blockIndex = -1;
  let textStarted = false;
  let hasToolUse = false;
  let inputTokens = 0;
  const transformEvent = (line) => {
    if (!line.startsWith("data:")) return "";
    const raw = line.slice("data:".length).trim();
    if (!raw || raw === "[DONE]") return "";
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return "";
    }
    if (event.type === "response.created") {
      messageId = event.response?.id ?? messageId;
      model = event.response?.model ?? model;
      inputTokens = Number(event.response?.usage?.input_tokens) || 0;
      return sseEvent("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      });
    }
    if (event.type === "response.output_text.delta") {
      let result = "";
      if (!textStarted) {
        blockIndex += 1;
        textStarted = true;
        result += sseEvent("content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        });
      }
      return result + sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "text_delta", text: event.delta ?? "" },
      });
    }
    if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
      blockIndex += 1;
      hasToolUse = true;
      return sseEvent("content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: event.item.call_id ?? event.item.id,
          name: event.item.name,
          input: {},
        },
      });
    }
    if (event.type === "response.function_call_arguments.delta") {
      return sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: event.delta ?? "" },
      });
    }
    if (event.type === "response.output_item.done" && ["message", "function_call"].includes(event.item?.type)) {
      if (event.item.type === "message") textStarted = false;
      return sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
    }
    if (event.type === "response.completed") {
      let result = "";
      if (textStarted) {
        result += sseEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
        textStarted = false;
      }
      const outputTokens = Number(event.response?.usage?.output_tokens) || 0;
      result += sseEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: hasToolUse ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: outputTokens },
      });
      result += sseEvent("message_stop", { type: "message_stop" });
      return result;
    }
    if (event.type === "response.failed" || event.type === "error") {
      return sseEvent("error", {
        type: "error",
        error: { type: "api_error", message: "Upstream response failed" },
      });
    }
    return "";
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) this.push(transformEvent(line.replace(/\r$/u, "")));
      callback();
    },
    flush(callback) {
      if (pending) this.push(transformEvent(pending.replace(/\r$/u, "")));
      callback();
    },
  });
}

export function countAnthropicTokens(body) {
  // 使用 UTF-8 每 3 字节一个 token 的上界近似；不会触发任何模型或网络请求。
  const serialized = JSON.stringify({
    system: body?.system ?? null,
    messages: body?.messages ?? [],
    tools: body?.tools ?? [],
  });
  return { input_tokens: Math.max(1, Math.ceil(Buffer.byteLength(serialized) / 3)) };
}
