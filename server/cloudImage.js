import fs from "fs/promises";
import path from "path";
import { uploadDir } from "./store.js";
import { analyzeGeneratedImage } from "./imageQa.js";

export function getCloudImageConfig() {
  const env = globalThis.process?.env || {};
  return {
    enabled: env.CLOUD_IMAGE_ENABLED !== "false",
    apiKey: env.OPENAI_API_KEY || "",
    baseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: env.OPENAI_IMAGE_MODEL || env.CLOUD_IMAGE_MODEL || "gpt-image-1"
  };
}

export async function generateCloudImage({
  prompt,
  width = 1024,
  height = 1024,
  prefix = "ppt_cloud_image",
  textSafeArea = "",
  materialRole = "cloud-generated-visual"
} = {}) {
  const config = getCloudImageConfig();
  if (!config.enabled) throw new Error("CLOUD_IMAGE_ENABLED=false");
  if (!config.apiKey) throw new Error("OPENAI_API_KEY not configured for cloud image generation");
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Missing cloud image prompt.");
  const response = await fetch(`${config.baseUrl}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      prompt: cleanPrompt,
      size: normalizeSize(width, height),
      n: 1
    })
  });
  if (!response.ok) throw new Error(`cloud image generation failed: HTTP ${response.status} ${await response.text()}`);
  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("cloud image generation response missing b64_json");
  const outputName = `${sanitizeFileName(prefix)}_${Date.now()}.png`;
  const outputPath = path.join(uploadDir, outputName);
  await fs.writeFile(outputPath, Buffer.from(b64, "base64"));
  const stat = await fs.stat(outputPath);
  const visualQa = await analyzeGeneratedImage(outputPath, { textSafeArea }).catch((error) => ({
    version: 1,
    source: "local-pixel-qa",
    status: "warn",
    risks: ["qa-failed"],
    error: error.message || "visual QA failed"
  }));
  return {
    id: `cloudimg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    originalName: outputName,
    mimeType: "image/png",
    path: outputPath,
    size: stat.size,
    createdAt: new Date().toISOString(),
    source: "cloud-image",
    generated: true,
    aiGenerated: true,
    provider: "openai-image",
    model: config.model,
    prompt: cleanPrompt,
    width,
    height,
    materialRole,
    visualQa
  };
}

function normalizeSize(width, height) {
  const w = Number(width) || 1024;
  const h = Number(height) || 1024;
  if (w >= 1500 || h >= 1500) return "1536x1024";
  if (Math.abs(w - h) < Math.max(w, h) * 0.18) return "1024x1024";
  return w > h ? "1536x1024" : "1024x1536";
}

function sanitizeFileName(value = "") {
  return String(value || "ppt_cloud_image").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 90) || "ppt_cloud_image";
}
