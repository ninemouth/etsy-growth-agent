import assert from "node:assert/strict";
import fs from "node:fs";
import { resolveLLMProfiles } from "../modules/llmClient.js";

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

const source = fs.readFileSync("modules/llmClient.js", "utf8");
assert.match(source, /function resolveProtocol[\s\S]*profile\.provider === "qwen"\) return "chat"/, "Qwen should use OpenAI-compatible chat/completions by default");
assert.match(source, /function extractResponsesText[\s\S]*output_text[\s\S]*data\.output/, "Responses API non-streaming output must be parsed explicitly");
assert.match(source, /function shouldFallback[\s\S]*429[\s\S]*status >= 500[\s\S]*超时/, "LLM fallback should be limited to transient failures");
assert.match(source, /llmProfiles[\s\S]*llmFallbackModels/, "settings should support both advanced profiles and simple fallback models");

const sidepanelSource = fs.readFileSync("sidepanel.js", "utf8");
assert.match(sidepanelSource, /llmFallbackModels/, "sidepanel should persist fallback model settings");

console.log("llm client smoke passed");
