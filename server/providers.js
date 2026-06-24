import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { uploadDir } from "./store.js";

const execFileAsync = promisify(execFile);

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LLM_MODEL = "gpt-4.1-mini";
const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CONCURRENCY = 2;

export function getProviderConfig(env = globalThis.process?.env || {}) {
  const apiKey = env.OPENAI_API_KEY || env.PROVIDER_API_KEY || "";
  const baseUrl = normalizeBaseUrl(env.OPENAI_BASE_URL || env.PROVIDER_BASE_URL || DEFAULT_BASE_URL);
  const timeoutMs = clampNumber(env.PROVIDER_TIMEOUT_MS, 5000, 600000, DEFAULT_TIMEOUT_MS);
  const maxRetries = clampNumber(env.PROVIDER_MAX_RETRIES, 0, 8, DEFAULT_MAX_RETRIES);
  const concurrency = clampNumber(env.PROVIDER_CONCURRENCY, 1, 12, DEFAULT_CONCURRENCY);
  return {
    version: 1,
    llm: {
      provider: env.LLM_PROVIDER || "openai-compatible",
      configured: Boolean(apiKey),
      hasApiKey: Boolean(apiKey),
      maskedApiKey: maskSecret(apiKey),
      baseUrl,
      model: env.OPENAI_MODEL || env.LLM_MODEL || DEFAULT_LLM_MODEL,
      timeoutMs,
      maxRetries,
      concurrency
    },
    image: {
      provider: env.IMAGE_PROVIDER || "openai-compatible-image",
      enabled: env.CLOUD_IMAGE_ENABLED !== "false",
      configured: Boolean(apiKey),
      hasApiKey: Boolean(apiKey),
      maskedApiKey: maskSecret(apiKey),
      baseUrl,
      model: env.OPENAI_IMAGE_MODEL || env.CLOUD_IMAGE_MODEL || env.IMAGE_MODEL || DEFAULT_IMAGE_MODEL,
      supportsImageGeneration: true,
      supportsImageEdit: env.IMAGE_EDIT_ENABLED !== "false",
      generationEndpoint: "/images/generations",
      editEndpoint: "/images/edits",
      requiredInputMode: "source-page-edit",
      timeoutMs,
      maxRetries,
      concurrency
    },
    ocr: {
      provider: env.OCR_PROVIDER || "rapidocr-local",
      enabled: env.OCR_ENABLED !== "false",
      pythonPath: resolveDefaultOcrPythonPath(env),
      timeoutMs: clampNumber(env.OCR_TIMEOUT_MS, 5000, 600000, DEFAULT_TIMEOUT_MS),
      maxRetries: clampNumber(env.OCR_MAX_RETRIES, 0, 8, DEFAULT_MAX_RETRIES),
      concurrency: clampNumber(env.OCR_CONCURRENCY, 1, 12, DEFAULT_CONCURRENCY)
    }
  };
}

function resolveDefaultOcrPythonPath(env = {}) {
  if (env.OCR_PYTHON_PATH) return env.OCR_PYTHON_PATH;
  if (env.PYTHON_PATH) return env.PYTHON_PATH;
  const candidates = [
    path.join(process.cwd(), "outputs", "skill-duo-test", "ocr-venv", "Scripts", "python.exe"),
    path.join(process.cwd(), ".venv", "Scripts", "python.exe"),
    path.join(process.cwd(), "venv", "Scripts", "python.exe")
  ];
  return candidates.find((candidate) => fsSync.existsSync(candidate)) || "python";
}

export async function testLlmProvider(overrides = {}) {
  const config = mergeLlmConfig(overrides);
  if (!config.apiKey) return { ok: false, configured: false, provider: publicProviderConfig(config), error: "Missing API key" };
  const result = await requestOpenAiCompatible(config.baseUrl, "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: "Return only: pong" }],
      max_tokens: 8,
      temperature: 0
    }),
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries
  });
  if (!result.response.ok) {
    return {
      ok: false,
      configured: true,
      provider: { ...publicProviderConfig(config), baseUrl: stripEndpoint(result.url, "/chat/completions") },
      status: result.response.status,
      error: await readProviderError(result.response)
    };
  }
  const data = await result.response.json();
  return {
    ok: true,
    configured: true,
    provider: { ...publicProviderConfig(config), baseUrl: stripEndpoint(result.url, "/chat/completions") },
    usage: data.usage || null,
    sample: data.choices?.[0]?.message?.content || ""
  };
}

export async function listLlmModels(overrides = {}) {
  const config = mergeLlmConfig(overrides);
  if (!config.apiKey) return { ok: false, configured: false, provider: publicProviderConfig(config), error: "Missing API key", models: [] };
  const result = await requestOpenAiCompatible(config.baseUrl, "/models", {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries
  });
  if (!result.response.ok) {
    return {
      ok: false,
      configured: true,
      provider: { ...publicProviderConfig(config), baseUrl: stripEndpoint(result.url, "/models") },
      status: result.response.status,
      error: await readProviderError(result.response),
      models: []
    };
  }
  const data = await result.response.json();
  const models = (data.data || []).map((item) => item.id).filter(Boolean).sort((a, b) => a.localeCompare(b));
  return {
    ok: true,
    configured: true,
    provider: { ...publicProviderConfig(config), baseUrl: stripEndpoint(result.url, "/models") },
    models,
    chatModels: models.filter((id) => !/embedding|audio|tts|whisper|image|moderation|realtime|transcribe/i.test(id)),
    imageModels: models.filter((id) => /image|gpt-image|dall-e/i.test(id))
  };
}

export async function testImageProvider(overrides = {}) {
  const config = mergeImageConfig(overrides);
  if (!config.enabled) return { ok: false, configured: false, provider: publicProviderConfig(config), error: "Image provider disabled" };
  if (!config.apiKey) return { ok: false, configured: false, provider: publicProviderConfig(config), error: "Missing API key" };
  if (!overrides.generateProbe) {
    return {
      ok: true,
      configured: true,
      dryRun: true,
      provider: publicProviderConfig(config),
      message: "Image provider is configured. Set generateProbe=true to run a paid image generation probe."
    };
  }
  const image = await generateImageWithProvider({
    prompt: "Clean 16:9 presentation background, abstract soft geometry, no text",
    width: 1024,
    height: 1024,
    prefix: "provider_probe",
    config
  });
  return { ok: true, configured: true, dryRun: false, provider: publicProviderConfig(config), image };
}

export async function testOcrProvider(overrides = {}) {
  const config = mergeOcrConfig(overrides);
  if (!config.enabled) return { ok: false, configured: false, provider: config.provider, error: "OCR provider disabled" };
  if (config.provider !== "rapidocr-local") {
    return { ok: true, configured: true, provider: config.provider, message: "OCR provider selected; runtime check is only implemented for rapidocr-local." };
  }
  try {
    const probe = "import importlib.util, json; mods=['rapidocr_onnxruntime','rapidocr']; print(json.dumps({m: bool(importlib.util.find_spec(m)) for m in mods}))";
    const { stdout } = await execFileAsync(config.pythonPath, ["-c", probe], {
      timeout: config.timeoutMs,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" }
    });
    const modules = JSON.parse(stdout.trim() || "{}");
    const ok = Boolean(modules.rapidocr_onnxruntime || modules.rapidocr);
    return {
      ok,
      configured: ok,
      provider: config.provider,
      pythonPath: config.pythonPath,
      modules,
      error: ok ? "" : "rapidocr_onnxruntime or rapidocr is not installed in this Python runtime"
    };
  } catch (error) {
    return {
      ok: false,
      configured: false,
      provider: config.provider,
      pythonPath: config.pythonPath,
      error: error.message || "OCR runtime check failed"
    };
  }
}

export async function generateImageWithProvider({ prompt, width = 1024, height = 1024, prefix = "provider_image", config = null } = {}) {
  const imageConfig = config || mergeImageConfig({});
  if (!imageConfig.enabled) throw new Error("Image provider disabled");
  if (!imageConfig.supportsImageEdit) throw new Error("Image edit provider disabled");
  if (!imageConfig.apiKey) throw new Error("Missing image provider API key");
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Missing image prompt");
  const result = await requestOpenAiCompatible(imageConfig.baseUrl, "/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${imageConfig.apiKey}` },
    body: JSON.stringify({
      model: imageConfig.model,
      prompt: cleanPrompt,
      size: normalizeImageSize(width, height, imageConfig.model),
      n: 1
    }),
    timeoutMs: imageConfig.timeoutMs,
    maxRetries: imageConfig.maxRetries
  });
  if (!result.response.ok) throw new Error(`image generation failed: HTTP ${result.response.status} ${await readProviderError(result.response)}`);
  const data = await result.response.json();
  return writeGeneratedImageResult({
    data,
    prefix,
    timeoutMs: imageConfig.timeoutMs,
    source: "provider-image",
    idPrefix: "providerimg",
    imageConfig,
    resultUrl: result.url,
    endpoint: "/images/generations",
    prompt: cleanPrompt,
    width,
    height,
    extra: {
      operation: "image-generation",
      imageInputMode: "text-only"
    }
  });
}

export async function editImageWithProvider({ prompt, sourceImagePath, width = 1024, height = 1024, prefix = "provider_image_edit", config = null } = {}) {
  const imageConfig = config || mergeImageConfig({});
  if (!imageConfig.enabled) throw new Error("Image provider disabled");
  if (!imageConfig.apiKey) throw new Error("Missing image provider API key");
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Missing image edit prompt");
  const imagePath = String(sourceImagePath || "").trim();
  if (!imagePath || !fsSync.existsSync(imagePath)) throw new Error("Missing source image for image edit");
  const imageBuffer = await fs.readFile(imagePath);
  const form = new FormData();
  form.append("model", imageConfig.model);
  form.append("prompt", cleanPrompt);
  form.append("size", normalizeImageSize(width, height, imageConfig.model));
  form.append("n", "1");
  form.append("image", new Blob([imageBuffer], { type: mimeTypeForPath(imagePath) }), path.basename(imagePath));
  const result = await requestOpenAiCompatible(imageConfig.baseUrl, "/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${imageConfig.apiKey}` },
    body: form,
    timeoutMs: imageConfig.timeoutMs,
    maxRetries: imageConfig.maxRetries
  });
  if (!result.response.ok) throw new Error(`image edit failed: HTTP ${result.response.status} ${await readProviderError(result.response)}`);
  const data = await result.response.json();
  return writeGeneratedImageResult({
    data,
    prefix,
    timeoutMs: imageConfig.timeoutMs,
    source: "provider-image-edit",
    idPrefix: "provideredit",
    imageConfig,
    resultUrl: result.url,
    endpoint: "/images/edits",
    prompt: cleanPrompt,
    width,
    height,
    extra: {
      operation: "image-edit",
      imageInputMode: "source-page-edit",
      sourceImagePath: imagePath
    }
  });
}

async function writeGeneratedImageResult({ data, prefix, timeoutMs, source, idPrefix, imageConfig, resultUrl, endpoint, prompt, width, height, extra = {} }) {
  const first = data.data?.[0] || {};
  const outputName = `${sanitizeFileName(prefix)}_${Date.now()}.png`;
  const outputPath = path.join(uploadDir, outputName);
  if (first.b64_json) {
    await fs.writeFile(outputPath, Buffer.from(first.b64_json, "base64"));
  } else if (first.url) {
    await downloadFile(first.url, outputPath, timeoutMs);
  } else {
    throw new Error("image response missing b64_json or url");
  }
  const stat = await fs.stat(outputPath);
  return {
    id: `${idPrefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    originalName: outputName,
    mimeType: "image/png",
    path: outputPath,
    size: stat.size,
    createdAt: new Date().toISOString(),
    source,
    generated: true,
    aiGenerated: true,
    provider: imageConfig.provider,
    model: imageConfig.model,
    baseUrl: stripEndpoint(resultUrl, endpoint),
    prompt,
    width,
    height,
    responseFormat: first.b64_json ? "b64_json" : "url",
    usage: data.usage || null,
    ...extra
  };
}

export async function requestOpenAiCompatible(baseUrl, endpoint, options = {}) {
  const errors = [];
  const maxRetries = Math.max(0, Number(options.maxRetries ?? DEFAULT_MAX_RETRIES));
  for (const candidate of getCompatibleBaseUrls(baseUrl)) {
    const url = `${candidate}${endpoint}`;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetchWithTimeout(url, options, options.timeoutMs || DEFAULT_TIMEOUT_MS);
        if (response.ok && isJsonResponse(response)) return { response, url, attempt };
        errors.push({ response, url });
        if (response.ok || ![408, 409, 429, 500, 502, 503, 504].includes(response.status)) break;
      } catch (error) {
        errors.push({ error, url });
      }
      if (attempt < maxRetries) await sleep(Math.min(5000, 500 * 2 ** attempt));
    }
  }
  const last = errors.at(-1);
  if (last?.response) return last;
  throw new Error(last?.error?.message || "Provider connection failed");
}

export function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  return raw || DEFAULT_BASE_URL;
}

export function maskSecret(value = "") {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

export function stripEndpoint(url, endpoint) {
  return String(url || "").endsWith(endpoint) ? String(url).slice(0, -endpoint.length) : String(url || "").replace(/\/$/, "");
}

export async function readProviderError(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (/application\/json/i.test(contentType)) {
    try {
      const data = JSON.parse(text);
      return data.error?.message || data.message || text.slice(0, 240);
    } catch {
      return text.slice(0, 240);
    }
  }
  if (/^\s*</.test(text)) return "Provider returned HTML instead of JSON. Check whether Base URL needs /v1.";
  return text.slice(0, 240);
}

function mergeLlmConfig(overrides = {}) {
  const config = getProviderConfig().llm;
  return {
    provider: config.provider,
    apiKey: String(overrides.apiKey || process.env.OPENAI_API_KEY || process.env.PROVIDER_API_KEY || "").trim(),
    baseUrl: normalizeBaseUrl(overrides.baseUrl || config.baseUrl),
    model: String(overrides.model || config.model || DEFAULT_LLM_MODEL).trim(),
    timeoutMs: clampNumber(overrides.timeoutMs || config.timeoutMs, 5000, 600000, DEFAULT_TIMEOUT_MS),
    maxRetries: clampNumber(overrides.maxRetries ?? config.maxRetries, 0, 8, DEFAULT_MAX_RETRIES),
    concurrency: clampNumber(overrides.concurrency || config.concurrency, 1, 12, DEFAULT_CONCURRENCY)
  };
}

function mergeImageConfig(overrides = {}) {
  const config = getProviderConfig().image;
  return {
    provider: config.provider,
    enabled: overrides.enabled ?? config.enabled,
    apiKey: String(overrides.apiKey || process.env.OPENAI_API_KEY || process.env.PROVIDER_API_KEY || "").trim(),
    baseUrl: normalizeBaseUrl(overrides.baseUrl || config.baseUrl),
    model: String(overrides.model || config.model || DEFAULT_IMAGE_MODEL).trim(),
    supportsImageGeneration: overrides.supportsImageGeneration ?? config.supportsImageGeneration !== false,
    supportsImageEdit: overrides.supportsImageEdit ?? config.supportsImageEdit !== false,
    generationEndpoint: config.generationEndpoint || "/images/generations",
    editEndpoint: config.editEndpoint || "/images/edits",
    requiredInputMode: config.requiredInputMode || "source-page-edit",
    timeoutMs: clampNumber(overrides.timeoutMs || config.timeoutMs, 5000, 600000, DEFAULT_TIMEOUT_MS),
    maxRetries: clampNumber(overrides.maxRetries ?? config.maxRetries, 0, 8, DEFAULT_MAX_RETRIES),
    concurrency: clampNumber(overrides.concurrency || config.concurrency, 1, 12, DEFAULT_CONCURRENCY)
  };
}

function mergeOcrConfig(overrides = {}) {
  const config = getProviderConfig().ocr;
  return {
    provider: String(overrides.provider || config.provider || "rapidocr-local").trim(),
    enabled: overrides.enabled ?? config.enabled,
    pythonPath: String(overrides.pythonPath || config.pythonPath || "python").trim(),
    timeoutMs: clampNumber(overrides.timeoutMs || config.timeoutMs, 5000, 600000, DEFAULT_TIMEOUT_MS),
    maxRetries: clampNumber(overrides.maxRetries ?? config.maxRetries, 0, 8, DEFAULT_MAX_RETRIES),
    concurrency: clampNumber(overrides.concurrency || config.concurrency, 1, 12, DEFAULT_CONCURRENCY)
  };
}

function publicProviderConfig(config = {}) {
  const { apiKey: _apiKey, ...publicConfig } = config;
  return { ...publicConfig, hasApiKey: Boolean(config.apiKey), maskedApiKey: maskSecret(config.apiKey || "") };
}

function getCompatibleBaseUrls(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  const candidates = [normalized];
  if (!/\/v\d+(\/|$)/.test(normalized)) candidates.push(`${normalized}/v1`);
  return [...new Set(candidates)];
}

function isJsonResponse(response) {
  return /application\/json/i.test(response.headers.get("content-type") || "");
}

async function fetchWithTimeout(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const { timeoutMs: _timeoutMs, maxRetries: _maxRetries, ...fetchOptions } = options;
  try {
    return await fetch(url, { ...fetchOptions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFile(url, outputPath, timeoutMs) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
}

function normalizeImageSize(width, height, model = "") {
  const w = Number(width) || 1024;
  const h = Number(height) || 1024;
  const ratio = w / h;
  if (/gpt-image-2/i.test(String(model || "")) && Math.abs(ratio - (16 / 9)) < 0.03) return "1536x864";
  if (w >= 1500 || h >= 1500) return "1536x1024";
  if (Math.abs(w - h) < Math.max(w, h) * 0.18) return "1024x1024";
  return w > h ? "1536x1024" : "1024x1536";
}

function sanitizeFileName(value = "") {
  return String(value || "provider_image").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 90) || "provider_image";
}

function mimeTypeForPath(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
