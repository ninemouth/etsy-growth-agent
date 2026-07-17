// modules/llmClient.js — LLM Connector with Exponential Backoff Retry

export async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["apiKey", "llmProvider", "llmModel", "llmFallbackModels", "llmProfiles", "imageGenerationModel", "llmBaseUrl", "temperature", "helium10ApiKey", "sellerSpriteApiKey", "fastmossApiKey"],
      resolve
    );
  });
}

const LLM_ATTEMPT_TIMEOUT_MS = 60_000;
const LLM_MAX_RETRIES = 2;
const LLM_BODY_READ_TIMEOUT_MS = 90_000;
const PROVIDER_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1/messages",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  openrouter: "https://openrouter.ai/api/v1",
  thinktv: "https://www.thinktv.ai/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  groq: "https://api.groq.com/openai/v1",
};

async function readJsonWithTimeout(response) {
  let timeoutId;
  try {
    return await Promise.race([
      response.json(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`LLM 响应读取超过 ${LLM_BODY_READ_TIMEOUT_MS / 1000} 秒`)), LLM_BODY_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function readStreamChunkWithTimeout(reader) {
  let timeoutId;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`LLM 流式响应超过 ${LLM_BODY_READ_TIMEOUT_MS / 1000} 秒未继续返回`)), LLM_BODY_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(url, options, maxRetries = LLM_MAX_RETRIES) {
  let delay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LLM_ATTEMPT_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.status === 429 || response.status >= 500) {
        if (i === maxRetries - 1) return response;
        console.warn(`LLM API returned HTTP ${response.status}. Retrying in ${delay}ms (Attempt ${i + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      return response;
    } catch (err) {
      const reason = err.name === "AbortError" ? `请求超过 ${LLM_ATTEMPT_TIMEOUT_MS / 1000} 秒` : err.message;
      if (i === maxRetries - 1) throw new Error(`LLM 请求超时或网络失败：${reason}`);
      console.warn(`LLM API network failure: ${reason}. Retrying in ${delay}ms (Attempt ${i + 1}/${maxRetries})...`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function resolveImageEditUrl(settings) {
  const provider = settings.llmProvider || "openai";
  if (provider === "openai") return "https://api.openai.com/v1/images/edits";
  if (provider === "custom") {
    if (!settings.llmBaseUrl) throw new Error("未配置自定义 API 地址，无法调用生图模型。");
    const raw = settings.llmBaseUrl.replace(/\/+$/, "");
    if (raw.endsWith("/images/edits") || raw.endsWith("/images/generations")) return raw;
    if (raw.endsWith("/v1")) return `${raw}/images/edits`;
    return `${raw}/v1/images/edits`;
  }
  if (provider === "siliconflow") return "https://api.siliconflow.cn/v1/images/edits";
  if (provider === "qwen") return "https://dashscope.aliyuncs.com/compatible-mode/v1/images/edits";
  throw new Error(`当前 Provider (${provider}) 暂未接入通用图片编辑接口，请使用 OpenAI、SiliconFlow 或自定义 OpenAI-compatible 图片接口。`);
}

function dataUrlToBlob(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  const mime = match[1] || "image/jpeg";
  const isBase64 = !!match[2];
  const raw = isBase64 ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function prepareCleanProductImage(imageUrl, promptOverride = "") {
  const settings = await getSettings();
  const { apiKey, imageGenerationModel } = settings;
  if (!imageGenerationModel) {
    return {
      ok: false,
      skipped: true,
      reason: "image_generation_model_not_configured",
      cleanedImageUrl: imageUrl,
      message: "未配置生图模型，继续使用原始目标图进行以图搜图。",
    };
  }
  if (!apiKey) throw new Error("未配置 API Key，无法调用生图模型。");
  if (!imageUrl) throw new Error("imageUrl is required");

  let sourceBlob;
  if (String(imageUrl).startsWith("data:")) {
    sourceBlob = dataUrlToBlob(imageUrl);
  } else {
    const sourceResponse = await fetch(imageUrl);
    if (!sourceResponse.ok) {
      throw new Error(`目标商品图下载失败 (${sourceResponse.status})`);
    }
    sourceBlob = await sourceResponse.blob();
  }
  if (!sourceBlob) throw new Error("目标商品图解析失败，无法准备干净搜图图。");

  const endpoint = resolveImageEditUrl(settings);
  const prompt = promptOverride || [
    "Create a clean product-search reference image from the provided product photo.",
    "Keep the exact product shape, proportions, color, material, decorative details, and distinctive silhouette.",
    "Remove busy background, lifestyle props, text, watermarks, hands, packaging, and irrelevant objects.",
    "Center the complete product subject on a plain light background with all edges visible.",
    "Do not redesign, stylize, add parts, crop the product, or change the product identity.",
  ].join(" ");

  const form = new FormData();
  form.append("model", imageGenerationModel);
  form.append("prompt", prompt);
  form.append("image", sourceBlob, "target-product.png");
  form.append("size", "1024x1024");

  const response = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`生图模型调用失败 (${response.status}) [${endpoint}]: ${text}`);
  }

  const data = await readJsonWithTimeout(response);
  const first = data.data?.[0] || {};
  const cleanedImageUrl = first.b64_json
    ? `data:image/png;base64,${first.b64_json}`
    : first.url;

  if (!cleanedImageUrl) {
    throw new Error("生图模型未返回可用于搜图的图片。");
  }

  return {
    ok: true,
    model: imageGenerationModel,
    cleanedImageUrl,
    sourceImageUrl: imageUrl,
    prompt,
    message: "已生成背景干净、主体完整的搜图参考图。",
  };
}

function parseFallbackModels(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[\n,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldAddDefaultQwenFallback(provider, model, fallbackModels) {
  if (provider !== "qwen" || fallbackModels.length) return false;
  return /qwen3\.(?:6|7)|qwen-max/i.test(String(model || ""));
}

function normalizeProfile(raw = {}, settings = {}, index = 0) {
  const provider = raw.provider || settings.llmProvider || "openai";
  const model = String(raw.model || raw.llmModel || "").trim();
  const apiKey = String(raw.apiKey || settings.apiKey || "").trim();
  return {
    id: raw.id || `${provider}-${model || index}`,
    label: raw.label || `${provider}/${model}`,
    provider,
    model,
    apiKey,
    baseUrl: String(raw.baseUrl || raw.llmBaseUrl || settings.llmBaseUrl || "").trim(),
    protocol: raw.protocol || "",
    enableThinking: raw.enableThinking,
    enableSearch: raw.enableSearch,
    temperature: raw.temperature ?? settings.temperature,
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : index + 1,
    enabled: raw.enabled !== false,
  };
}

export function resolveLLMProfiles(settings = {}) {
  const configuredProfiles = Array.isArray(settings.llmProfiles)
    ? settings.llmProfiles.map((profile, index) => normalizeProfile(profile, settings, index))
    : [];

  if (configuredProfiles.length) {
    return configuredProfiles
      .filter((profile) => profile.enabled && profile.model && profile.apiKey)
      .sort((a, b) => a.priority - b.priority);
  }

  const provider = settings.llmProvider || "qwen";
  const model = String(settings.llmModel || "").trim();
  const fallbackModels = parseFallbackModels(settings.llmFallbackModels);
  if (shouldAddDefaultQwenFallback(provider, model, fallbackModels)) {
    fallbackModels.push("qwen3.5-plus");
  }
  const models = [model, ...fallbackModels].filter(Boolean);
  return models
    .map((item, index) => normalizeProfile({
      id: index === 0 ? "primary" : `fallback-${index}`,
      label: index === 0 ? "主模型" : `备用模型 ${index}`,
      provider,
      model: item,
      priority: index + 1,
    }, settings, index))
    .filter((profile) => profile.enabled && profile.model && profile.apiKey);
}

function resolveProtocol(profile) {
  if (profile.protocol === "responses" || profile.protocol === "chat") return profile.protocol;
  const model = String(profile.model || "");
  if (profile.provider === "qwen") return "chat";
  if (profile.provider === "openai" && (model.includes("gpt-5") || model.includes("gpt-6"))) return "responses";
  return "chat";
}

function resolveTextEndpoint(profile, protocol) {
  if (profile.provider === "custom") {
    if (!profile.baseUrl) throw new Error("未配置自定义 API 地址，请在设置页面填写完整的 API 端点 URL。");
    const raw = profile.baseUrl.replace(/\/+$/, "");
    if (raw.endsWith("/chat/completions") || raw.endsWith("/responses") || raw.endsWith("/completions") || raw.endsWith("/messages")) {
      return raw;
    }
    if (raw.endsWith("/v1") || raw.endsWith("/compatible-mode/v1")) {
      return raw + (protocol === "responses" ? "/responses" : "/chat/completions");
    }
    return raw + (protocol === "responses" ? "/v1/responses" : "/v1/chat/completions");
  }
  const base = PROVIDER_ENDPOINTS[profile.provider] || PROVIDER_ENDPOINTS.openai;
  if (profile.provider === "anthropic") return base;
  return base + (protocol === "responses" ? "/responses" : "/chat/completions");
}

function mapMessagesForResponses(messages = []) {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === "text") return { type: "input_text", text: part.text };
        if (part.type === "image_url") return { type: "input_image", image_url: part.image_url?.url || part.image_url };
        return part;
      }),
    };
  });
}

function isQwenLike(profile) {
  return profile.provider === "qwen" || profile.model.toLowerCase().includes("qwen") || profile.baseUrl.includes("dashscope");
}

function buildChatBody(profile, messages, finalTemperature, isStreaming) {
  const body = {
    model: profile.model,
    messages,
    temperature: finalTemperature,
    max_tokens: 8192,
    stream: isStreaming,
  };

  const model = profile.model.toLowerCase();
  const isGeminiModel = model.includes("gemini") || profile.baseUrl.includes("google");
  const isGlmModel = model.includes("glm") || profile.provider === "zhipu" || profile.baseUrl.includes("zhipu");
  const isBaichuan = model.includes("baichuan") || profile.provider === "baichuan";
  const isDoubaoModel = model.includes("doubao") || profile.baseUrl.includes("volcengine");
  const isMinimaxModel = model.includes("minimax");
  const isHunyuanModel = model.includes("hunyuan") || model.includes("tencent");

  if (isQwenLike(profile)) {
    if (profile.enableThinking !== false && /qwen3|reason/i.test(profile.model)) body.enable_thinking = true;
    if (profile.enableSearch !== false) {
      body.enable_search = true;
      body.tools = [{ type: "web_search" }];
    }
  } else if (isGeminiModel) {
    body.tools = [{ googleSearch: {} }];
  } else if (isGlmModel) {
    body.tools = [{ type: "web_search", web_search: { enable: true } }];
  } else if (isBaichuan || isDoubaoModel || isMinimaxModel || isHunyuanModel) {
    body.tools = [{ type: "web_search" }];
  }

  return body;
}

function buildRequestBody(profile, messages, protocol, finalTemperature, isStreaming) {
  if (profile.provider === "anthropic") {
    const systemMsg = messages.find((m) => m.role === "system")?.content || "";
    const userMessages = messages.filter((m) => m.role !== "system");
    return {
      model: profile.model,
      system: systemMsg,
      messages: userMessages,
      max_tokens: 8192,
      temperature: finalTemperature,
      stream: isStreaming,
    };
  }
  if (protocol === "responses") {
    return {
      model: profile.model,
      input: mapMessagesForResponses(messages),
      temperature: finalTemperature,
      stream: isStreaming,
    };
  }
  return buildChatBody(profile, messages, finalTemperature, isStreaming);
}

function buildHeaders(profile) {
  if (profile.provider === "anthropic") {
    return {
      "Content-Type": "application/json",
      "x-api-key": profile.apiKey,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${profile.apiKey}`,
  };
}

function extractResponsesText(data = {}) {
  if (typeof data.output_text === "string") return data.output_text;
  if (typeof data.output?.text === "string") return data.output.text;
  if (!Array.isArray(data.output)) return "";
  return data.output
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .map((part) => part.text || part.output_text || "")
    .filter(Boolean)
    .join("");
}

function extractTextFromJson(data = {}, protocol = "chat", provider = "") {
  if (provider === "anthropic") return data.content?.[0]?.text || "";
  if (protocol === "responses") return extractResponsesText(data);
  return data.choices?.[0]?.message?.content || data.output?.text || extractResponsesText(data) || "";
}

function createLLMError(message, profile, endpoint, status = 0) {
  const err = new Error(message);
  err.status = status;
  err.provider = profile.provider;
  err.model = profile.model;
  err.endpoint = endpoint;
  return err;
}

function shouldFallback(error) {
  if (error?.status === 429 || error?.status >= 500) return true;
  return /超时|timeout|network|网络|Failed to fetch|AbortError/i.test(error?.message || "");
}

async function callLLMWithProfile(profile, messages, streamCallback, isHighRandomness = false) {
  const protocol = resolveProtocol(profile);
  const endpoint = resolveTextEndpoint(profile, protocol);
  const isStreaming = typeof streamCallback === "function";
  const finalTemperature = isHighRandomness ? 0.95 : (parseFloat(profile.temperature) || 0.2);
  const body = buildRequestBody(profile, messages, protocol, finalTemperature, isStreaming);

  let response;
  try {
    response = await fetchWithRetry(endpoint, {
      method: "POST",
      headers: buildHeaders(profile),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw createLLMError(`网络请求彻底失败 (${profile.provider}/${profile.model})。\n请求地址: ${endpoint}\n原始错误: ${err.message}`, profile, endpoint);
  }

  if (!response.ok) {
    const text = await response.text();
    const label = profile.provider === "anthropic" ? "Anthropic API" : "LLM API";
    throw createLLMError(`${label} 错误 (${response.status}) [${profile.provider}/${profile.model}] [${endpoint}]: ${text}`, profile, endpoint, response.status);
  }

  if (isStreaming) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await readJsonWithTimeout(response);
      const chunk = extractTextFromJson(data, protocol, profile.provider) || JSON.stringify(data);
      streamCallback({ chunk, fullText: chunk });
      return chunk;
    }
    return await readSSEStream(response, streamCallback, profile.provider === "anthropic" ? "anthropic" : "openai");
  }

  const data = await readJsonWithTimeout(response);
  return extractTextFromJson(data, protocol, profile.provider);
}

export async function callLLM(messages, streamCallback, isHighRandomness = false) {
  const settings = await getSettings();
  const profiles = resolveLLMProfiles(settings);
  if (!profiles.length) {
    throw new Error("未配置可用 LLM Profile。请至少填写 API Key 和模型名称，或配置 llmProfiles。");
  }

  let lastError = null;
  for (let index = 0; index < profiles.length; index++) {
    const profile = profiles[index];
    try {
      if (index > 0) {
        console.warn(`LLM fallback activated: ${profile.provider}/${profile.model}`);
      }
      return await callLLMWithProfile(profile, messages, streamCallback, isHighRandomness);
    } catch (err) {
      lastError = err;
      const canTryNext = index < profiles.length - 1 && shouldFallback(err);
      if (!canTryNext) throw err;
      console.warn(`LLM profile failed, trying fallback: ${profile.provider}/${profile.model}: ${err.message}`);
    }
  }
  throw lastError || new Error("LLM 调用失败，且没有可用备用模型。");
}

async function readSSEStream(response, callback, format) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await readStreamChunkWithTimeout(reader);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      if (trimmed.startsWith(":")) {
        continue; // Ignore SSE comments (e.g., :HTTP_STATUS/200, :ping, keep-alive)
      }

      let payload = trimmed;
      if (trimmed.startsWith("data:")) {
        payload = trimmed.slice(5).trim();
      } else if (trimmed.startsWith("id:") || trimmed.startsWith("event:") || trimmed.startsWith("retry:")) {
        continue;
      }

      if (payload === "[DONE]") {
        continue; // Cleanly ignore standard EOF marker without logging parsing errors
      }
      
      let json;
      try {
        json = JSON.parse(payload);
      } catch (err) {
        console.error("SSE parse error", err, payload);
        continue;
      }
        
      if (json.code && json.message && !json.output && !json.choices) {
        throw new Error(`API 拒绝了请求: [${json.code}] ${json.message}`);
      }

      try {
        let chunk = "";
        let reasoningChunk = "";

        if (format === "anthropic") {
          chunk = json.delta?.text || "";
        } else if (json.type && json.type.startsWith("response.")) {
          if (json.type.includes("reasoning") && json.delta) {
             reasoningChunk = json.delta;
          } else if ((json.type.includes("text.delta") || json.type.includes("content_part.delta")) && json.delta) {
             chunk = json.delta;
          } else if (json.type === "response.message.delta" && json.delta?.text) {
             chunk = json.delta.text;
          } else if (json.type === "response.message.delta" && json.delta?.content) {
             chunk = json.delta.content;
          }
        } else {
          if (json.output) {
             if (json.output.type === "reasoning" && json.output.summary) {
                const s = json.output.summary;
                reasoningChunk = Array.isArray(s) ? s.map(x => x.text || "").join("") : (typeof s === "string" ? s : "");
             } else if (json.output.type === "message" && json.output.content) {
                const c = json.output.content;
                chunk = Array.isArray(c) ? c.map(x => x.text || "").join("") : (typeof c === "string" ? c : "");
             } else if (typeof json.output.text === "string") {
                 chunk = json.output.text;
             } else if (json.output.choices) {
                 const choice = json.output.choices[0];
                 if (choice) {
                    chunk = choice.delta?.content || choice.message?.content || "";
                    reasoningChunk = choice.delta?.reasoning_content || "";
                 }
             }
          } else {
             chunk = json.choices?.[0]?.delta?.content || "";
             reasoningChunk = json.choices?.[0]?.delta?.reasoning_content || "";
          }
        }

        if (reasoningChunk) {
           fullText += reasoningChunk;
           callback({ chunk: reasoningChunk, fullText, isReasoning: true });
        }
        if (chunk) {
          fullText += chunk;
          callback({ chunk, fullText });
        }
      } catch (err) {
        console.error("SSE parse error", err, payload);
      }
    }
  }

  return fullText;
}
