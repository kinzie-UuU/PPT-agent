import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getThemeRecord } from "./designSystem.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const aestheticRecipes = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "design-system", "aesthetic-recipes.json"), "utf8"));

export function getAestheticSystem() {
  return aestheticRecipes;
}

export function getAestheticRecipe(style = "") {
  const theme = getThemeRecord(style);
  return aestheticRecipes.styles.find((item) => item.themeName === style || item.themeSlug === style || item.themeSlug === theme.slug)
    || aestheticRecipes.styles[0];
}

export function buildAestheticPlan({ style = "", deckType = "", layoutSequence = [], styleReferences = [], materialBrief = {}, uploads = [] } = {}) {
  const recipe = getAestheticRecipe(style);
  const referenceSummary = summarizeReferences(styleReferences);
  const hasUserImages = uploads.some((file) => /^image\//.test(file.mimeType || "") || /\.(png|jpe?g|webp|svg)$/i.test(file.originalName || ""));
  const imageHints = [...(materialBrief.imageHints || []), ...uploads.map((file) => file.originalName).filter(Boolean)].slice(0, 10);
  const pagePlans = layoutSequence.map((step, index) => buildPageAesthetic({ step, index, recipe, referenceSummary, imageHints, hasUserImages }));

  return {
    system: "ppt-poster-layer-system",
    deckType,
    theme: recipe.themeName,
    themeSlug: recipe.themeSlug,
    principle: aestheticRecipes.principle,
    visualGrammar: recipe.visualGrammar,
    globalComposition: {
      background: recipe.background,
      textSafeArea: recipe.textSafeArea,
      imageTreatment: recipe.imageTreatment,
      iconMotifs: recipe.iconMotifs,
      avoid: recipe.avoid,
      styleReferenceCount: styleReferences.length,
      styleReferenceSummary: referenceSummary
    },
    generationPolicy: {
      localFirst: true,
      localProvider: "comfyui-zimage",
      cloudFallback: "Only when local generation cannot cover a required illustration/object or the user explicitly asks for remote generation.",
      preserveOriginalImages: "For old PPT optimization, original meaningful images are reused first; generated backgrounds must not replace factual product photos unless marked as supplement.",
      humanGate: "Generate style proof pages, run automatic visual QA, then ask human confirmation before full deck rendering."
    },
    comfy: {
      basePrompt: recipe.comfyPrompt,
      negativePrompt: "text, words, logo, watermark, blurry UI, cluttered layout, low readability, deformed product, extra labels",
      defaultSize: { width: 1280, height: 720 },
      workflowMustBeSaved: true
    },
    pagePlans
  };
}

function buildPageAesthetic({ step = {}, index = 0, recipe, referenceSummary, imageHints, hasUserImages }) {
  const layout = step.layout || "cards";
  const layerRule = aestheticRecipes.layoutLayerRules[layout] || aestheticRecipes.layoutLayerRules.cards;
  const needsImage = Boolean(step.imageSlots?.length) || ["cover", "visual", "product-detail"].includes(layout) || hasUserImages;
  return {
    index: step.index || index + 1,
    layout,
    title: step.title || layout,
    purpose: step.purpose || "",
    layers: {
      background: layerRule.backgroundRole,
      text: layerRule.textRole,
      image: layerRule.imageRole,
      ornament: layerRule.ornamentRole
    },
    textSafeArea: recipe.textSafeArea,
    textSafePriority: layerRule.textSafePriority,
    imagePolicy: {
      needsImage,
      source: step.imageSlots?.length ? "source-image-slot" : needsImage ? "style-or-generated-support" : "none",
      slots: step.imageSlots || [],
      cropRule: recipe.imageTreatment
    },
    ornamentPolicy: {
      motifs: recipe.iconMotifs,
      density: ["cover", "visual", "quote", "section"].includes(layout) ? "low" : "medium"
    },
    comfyPrompt: [
      recipe.comfyPrompt,
      layoutPrompt(layout, layerRule),
      referenceSummary ? `style reference traits: ${referenceSummary}` : "",
      needsImage ? "composition leaves room for product/image crop, clear separation between image area and text-safe area" : "minimal background, no dominant object",
      "presentation slide background, 16:9, no text"
    ].filter(Boolean).join(", "),
    qualityGate: [
      "text-safe area must stay visually quiet",
      "no generated words/logos in background",
      "main image/object must not cover planned text area",
      imageHints.length ? "prefer original source images before generated supplements" : "generated visuals are decorative/supportive only"
    ]
  };
}

function layoutPrompt(layout, layerRule) {
  const map = {
    cover: "hero cover composition, one strong focal area, generous title whitespace",
    visual: "dominant product/visual area, short text caption zone, poster-like balance",
    section: "breathing section divider, calm single-message composition",
    toc: "quiet navigation background, subtle progress rhythm",
    kpi: "large-number data page background, precise grid",
    pricing: "price ladder background, tiered structure with clean cards",
    "product-detail": "product detail stage, callout-friendly whitespace",
    bundle: "three-tier recommendation composition, balanced columns",
    "risk-checklist": "plain checklist background, readable and restrained",
    compare: "split comparison background, clear left-right structure",
    timeline: "timeline flow background, subtle nodes and path",
    cards: "card grid background, modular information structure",
    quote: "large quote page background, strong negative space",
    closing: "calm closing page background, final action focus"
  };
  return `${map[layout] || map.cards}, background=${layerRule.backgroundRole}, text=${layerRule.textRole}`;
}

function summarizeReferences(styleReferences = []) {
  return styleReferences
    .map((item) => item.styleFingerprint?.prompt || item.tone || item.name || "")
    .filter(Boolean)
    .slice(0, 4)
    .join(" | ")
    .slice(0, 600);
}
