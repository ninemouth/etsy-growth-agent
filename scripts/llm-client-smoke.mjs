import assert from "node:assert/strict";
import fs from "node:fs";
import { __testInternals, buildRequestBody, resolveLLMProfiles } from "../modules/llmClient.js";

const profiles = resolveLLMProfiles({
  apiKey: "test-key",
  llmProvider: "qwen",
  llmModel: "qwen3.6-plus",
  temperature: "0.2",
});

assert.equal(profiles.length, 2, "qwen3.6-plus should get a same-provider fallback by default");
assert.equal(profiles[0].model, "qwen3.6-plus");
assert.equal(profiles[1].model, "qwen3.5-plus");
assert.equal(profiles[0].provider, "qwen");

const qwenChatBody = buildRequestBody(
  profiles[0],
  [{ role: "user", content: "hello" }],
  "chat",
  0.2,
  false
);
assert.equal(qwenChatBody.enable_search, true, "Qwen chat requests should keep DashScope search enabled");
assert.equal(qwenChatBody.enable_thinking, true, "Qwen reasoning models should keep thinking enabled");
assert.equal(qwenChatBody.tools, undefined, "Qwen chat/completions must not send Responses-style web_search tools");

assert.equal(__testInternals.isRateLimitText("limit_burst_rate: Rate limit reached"), true, "DashScope burst limits should be recognized as rate limits");
assert.equal(__testInternals.computeRetryDelayMs({ status: 429, headers: new Map() }, 0, ""), 5000, "429 retries should use a slower initial backoff");
assert.equal(__testInternals.computeRetryDelayMs({ status: 429, headers: new Map([["retry-after", "7"]]) }, 0, ""), 7000, "Retry-After should be honored for 429 responses");

const qwenRateLimitMessage = __testInternals.describeLLMHttpError(
  429,
  '{"error":{"type":"limit_burst_rate","message":"Rate limit reached. Please slow down and retry."}}',
  profiles[1],
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
);
assert.match(qwenRateLimitMessage, /供应商频率限制/, "429 errors should be explained as provider rate limits");
assert.match(qwenRateLimitMessage, /不是 Responses API\/Chat Completions 协议错误/, "429 errors should not be confused with protocol/schema failures");

const source = fs.readFileSync("modules/llmClient.js", "utf8");
assert.match(source, /function resolveProtocol[\s\S]*profile\.provider === "qwen"\) return "chat"/, "Qwen should use OpenAI-compatible chat/completions by default");
assert.match(source, /function extractResponsesText[\s\S]*output_text[\s\S]*data\.output/, "Responses API non-streaming output must be parsed explicitly");
assert.match(source, /function shouldFallback[\s\S]*429[\s\S]*status >= 500[\s\S]*超时/, "LLM fallback should be limited to transient failures");
assert.match(source, /LLM_RATE_LIMIT_RETRY_DELAYS_MS[\s\S]*5000[\s\S]*15000[\s\S]*30000/, "LLM 429 handling should avoid short burst retries");
assert.match(source, /llmProfiles[\s\S]*llmFallbackModels/, "settings should support both advanced profiles and simple fallback models");

const sidepanelSource = fs.readFileSync("sidepanel.js", "utf8");
assert.match(sidepanelSource, /llmFallbackModels/, "sidepanel should persist fallback model settings");

console.log("llm client smoke passed");
