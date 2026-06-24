import { analyzeGeneratedImage } from "./imageQa.js";
import { generateImageWithProvider, getProviderConfig } from "./providers.js";

export function getCloudImageConfig() {
  return getProviderConfig().image;
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
  if (!config.hasApiKey) throw new Error("OPENAI_API_KEY not configured for cloud image generation");
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("Missing cloud image prompt.");
  const image = await generateImageWithProvider({ prompt: cleanPrompt, width, height, prefix });
  const visualQa = await analyzeGeneratedImage(image.path, { textSafeArea }).catch((error) => ({
    version: 1,
    source: "local-pixel-qa",
    status: "warn",
    risks: ["qa-failed"],
    error: error.message || "visual QA failed"
  }));
  return {
    ...image,
    id: image.id.replace(/^providerimg_/, "cloudimg_"),
    mimeType: "image/png",
    source: "cloud-image",
    generated: true,
    aiGenerated: true,
    provider: config.provider,
    model: config.model,
    materialRole,
    visualQa
  };
}
