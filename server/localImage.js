import fs from "fs/promises";
import path from "path";
import { uploadDir } from "./store.js";
import { analyzeGeneratedImage } from "./imageQa.js";

const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";
const DEFAULT_OUTPUT_DIR = "F:\\PPT工具\\ZImageLocal\\ComfyUI_windows_portable\\ComfyUI\\output";
const WORKFLOW_ASSET_DIR = path.join(process.cwd(), "local-ai", "comfyui-workflows");
const BACKGROUND_WORKFLOW_ASSET = path.join(WORKFLOW_ASSET_DIR, "ppt-background-zimage.workflow.json");

export function getLocalImageConfig() {
  const env = globalThis.process?.env || {};
  return {
    enabled: env.LOCAL_IMAGE_ENABLED !== "false",
    provider: "comfyui-zimage",
    baseUrl: (env.LOCAL_IMAGE_BASE_URL || DEFAULT_COMFY_URL).replace(/\/$/, ""),
    outputDir: env.LOCAL_IMAGE_OUTPUT_DIR || DEFAULT_OUTPUT_DIR,
    model: env.LOCAL_IMAGE_MODEL || "z-image-turbo-fp8-e4m3fn.safetensors",
    textEncoder: env.LOCAL_IMAGE_TEXT_ENCODER || "qwen_3_4b_fp8_mixed.safetensors",
    vae: env.LOCAL_IMAGE_VAE || "ae.safetensors"
  };
}

export async function checkLocalImageStatus() {
  const config = getLocalImageConfig();
  if (!config.enabled) return { ok: false, configured: false, reason: "LOCAL_IMAGE_ENABLED=false", config };
  try {
    const response = await fetch(`${config.baseUrl}/system_stats`);
    if (!response.ok) return { ok: false, configured: true, reason: `HTTP ${response.status}`, config };
    const stats = await response.json();
    return {
      ok: true,
      configured: true,
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      textEncoder: config.textEncoder,
      vae: config.vae,
      system: stats.system,
      devices: stats.devices || []
    };
  } catch (error) {
    return { ok: false, configured: true, reason: error.message || "local image service unavailable", config };
  }
}

export async function generateLocalImage({
  prompt,
  width = 768,
  height = 768,
  steps = 8,
  seed = Date.now(),
  prefix = "ppt_local_zimage",
  textSafeArea = ""
} = {}) {
  const config = getLocalImageConfig();
  if (!config.enabled) throw new Error("Local image model is disabled.");
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Missing local image prompt.");
  const workflow = buildZImageWorkflow({ prompt: cleanPrompt, width, height, steps, seed, prefix, config });
  const response = await fetch(`${config.baseUrl}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: "ppt-design-tool-local-image" })
  });
  if (!response.ok) {
    throw new Error(`Local image prompt submission failed: HTTP ${response.status} ${await response.text()}`);
  }
  const queued = await response.json();
  const promptId = queued.prompt_id;
  const workflowPath = await saveComfyWorkflow(config, workflow, prefix, promptId);
  const history = await waitForComfyHistory(config.baseUrl, promptId);
  const images = history?.outputs?.["10"]?.images || [];
  if (!images.length) throw new Error("Local image generation finished without output images.");
  const image = images[0];
  const sourcePath = path.join(config.outputDir, image.subfolder || "", image.filename);
  await fs.access(sourcePath);
  const outputName = `${prefix}_${Date.now()}_${sanitizeFileName(image.filename)}`;
  const targetPath = path.join(uploadDir, outputName);
  await fs.copyFile(sourcePath, targetPath);
  const stat = await fs.stat(targetPath);
  const visualQa = await analyzeGeneratedImage(targetPath, { textSafeArea }).catch((error) => ({
    version: 1,
    source: "local-pixel-qa",
    status: "warn",
    risks: ["qa-failed"],
    error: error.message || "visual QA failed"
  }));
  return {
    id: `localimg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    originalName: outputName,
    mimeType: "image/png",
    path: targetPath,
    size: stat.size,
    createdAt: new Date().toISOString(),
    source: "local-zimage",
    generated: true,
    aiGenerated: true,
    provider: config.provider,
    prompt: cleanPrompt,
    seed,
    width,
    height,
    steps,
    visualQa,
    comfy: { promptId, filename: image.filename, subfolder: image.subfolder || "", workflowPath, workflowAsset: BACKGROUND_WORKFLOW_ASSET }
  };
}

async function saveComfyWorkflow(config, workflow, prefix, promptId) {
  const workflowDir = path.join(path.dirname(config.outputDir), "user", "default", "workflows", "ppt-design-tool");
  await fs.mkdir(workflowDir, { recursive: true });
  const filename = `${sanitizeFileName(prefix) || "ppt_local_zimage"}_${promptId}.json`;
  const workflowPath = path.join(workflowDir, filename);
  await fs.writeFile(workflowPath, JSON.stringify({
    savedBy: "ppt-design-tool",
    provider: config.provider,
    model: config.model,
    textEncoder: config.textEncoder,
    vae: config.vae,
    createdAt: new Date().toISOString(),
    workflow
  }, null, 2), "utf8");
  return workflowPath;
}

async function waitForComfyHistory(baseUrl, promptId) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const response = await fetch(`${baseUrl}/history/${promptId}`);
    if (!response.ok) continue;
    const history = await response.json();
    if (history?.[promptId]) return history[promptId];
  }
  throw new Error("Local image generation timed out.");
}

function buildZImageWorkflow({ prompt, width, height, steps, seed, prefix, config }) {
  return {
    "1": { class_type: "CLIPLoader", inputs: { clip_name: config.textEncoder, type: "lumina2", device: "default" } },
    "2": { class_type: "VAELoader", inputs: { vae_name: config.vae } },
    "3": { class_type: "UNETLoader", inputs: { unet_name: config.model, weight_dtype: "default" } },
    "4": { class_type: "CLIPTextEncode", inputs: { clip: ["1", 0], text: prompt } },
    "5": {
      class_type: "CLIPTextEncode",
      inputs: {
        clip: ["1", 0],
        text: "text, words, letters, numbers, Chinese characters, captions, labels, logo, watermark, fake UI text, readable typography"
      }
    },
    "6": { class_type: "EmptySD3LatentImage", inputs: { width: normalizeSize(width), height: normalizeSize(height), batch_size: 1 } },
    "7": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["3", 0], shift: 3 } },
    "8": {
      class_type: "KSampler",
      inputs: {
        model: ["7", 0],
        seed: Number(seed) || Date.now(),
        steps: Math.max(4, Math.min(16, Number(steps) || 8)),
        cfg: 1,
        sampler_name: "res_multistep",
        scheduler: "simple",
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
        denoise: 1
      }
    },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["2", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: sanitizeFileName(prefix).slice(0, 60) || "ppt_local_zimage" } }
  };
}

function normalizeSize(value) {
  const size = Math.max(512, Math.min(1280, Number(value) || 768));
  return Math.round(size / 16) * 16;
}

function sanitizeFileName(value = "") {
  return String(value).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 120);
}
