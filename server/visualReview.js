import fs from "fs/promises";
import path from "path";

export async function reviewDeckVisuals({ stage, deck = {}, quality = {}, routePlan = null, materialBrief = {}, previewImages = [] } = {}) {
  const env = globalThis.process?.env || {};
  if (!env.OPENAI_API_KEY) {
    return { stage, used: false, status: "skipped", reason: "OPENAI_API_KEY not configured", findings: [] };
  }
  const imagePaths = (previewImages || []).filter(Boolean).slice(0, 4);
  if (!imagePaths.length) {
    return { stage, used: false, status: "skipped", reason: "no preview images", findings: [] };
  }
  const images = [];
  for (const imagePath of imagePaths) {
    const dataUrl = await fileToDataUrl(imagePath).catch(() => null);
    if (dataUrl) images.push(dataUrl);
  }
  if (!images.length) {
    return { stage, used: false, status: "skipped", reason: "preview images unreadable", findings: [] };
  }

  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const prompt = buildVisualReviewPrompt({ stage, deck, quality, routePlan, materialBrief });
  try {
    const result = await fetchOpenAiCompatible(baseUrl, "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...images.map((imageUrl) => ({ type: "image_url", image_url: { url: imageUrl } }))
            ]
          }
        ],
        temperature: 0.2
      })
    });
    const usedBaseUrl = stripEndpoint(result.url, "/chat/completions");
    if (!result.response.ok) {
      return { stage, used: false, status: "warn", provider: { model, baseUrl: usedBaseUrl, status: result.response.status }, reason: await readProviderError(result.response), findings: [] };
    }
    const data = await result.response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const parsed = extractJson(content);
    if (!parsed) {
      return { stage, used: true, status: "warn", provider: { model, baseUrl: usedBaseUrl, usage: data.usage || null }, reason: "visual review returned non-JSON", findings: [content.slice(0, 300)].filter(Boolean) };
    }
    return normalizeReview(parsed, { stage, model, baseUrl: usedBaseUrl, usage: data.usage || null });
  } catch (error) {
    return { stage, used: false, status: "warn", reason: error.message, findings: [] };
  }
}

export async function reviewSourceIntake({ materialBrief = {}, uploads = [], stage = "source-intake" } = {}) {
  const env = globalThis.process?.env || {};
  if (!env.OPENAI_API_KEY) {
    return { stage, used: false, status: "skipped", reason: "OPENAI_API_KEY not configured", findings: [] };
  }
  const baseUrl = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.OPENAI_MODEL || "gpt-4.1-mini";
  const prompt = buildSourceIntakePrompt({ materialBrief, uploads, stage });
  try {
    const result = await fetchOpenAiCompatible(baseUrl, "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1
      })
    });
    const usedBaseUrl = stripEndpoint(result.url, "/chat/completions");
    if (!result.response.ok) {
      return { stage, used: false, status: "warn", provider: { model, baseUrl: usedBaseUrl, status: result.response.status }, reason: await readProviderError(result.response), findings: [] };
    }
    const data = await result.response.json();
    const content = data.choices?.[0]?.message?.content || "";
    const parsed = extractJson(content);
    if (!parsed) {
      return { stage, used: true, status: "warn", provider: { model, baseUrl: usedBaseUrl, usage: data.usage || null }, reason: "source review returned non-JSON", findings: [content.slice(0, 300)].filter(Boolean) };
    }
    return normalizeSourceReview(parsed, { stage, model, baseUrl: usedBaseUrl, usage: data.usage || null });
  } catch (error) {
    return { stage, used: false, status: "warn", reason: error.message, findings: [] };
  }
}

function buildVisualReviewPrompt({ stage, deck, quality, routePlan, materialBrief }) {
  const slides = (deck.slides || []).map((slide, index) => ({
    index: index + 1,
    title: slide.title,
    layout: slide.layout,
    imageSlots: slide.imageSlots || [],
    bullets: slide.bullets || [],
    dataPoints: slide.dataPoints || []
  }));
  return [
    "你是 PPT 视觉审美与交付复审 Agent。请根据随后的 PPT 预览图做视觉复审。",
    "只输出 JSON，不要 Markdown。",
    "JSON 格式：{\"status\":\"pass|warn|block\",\"summary\":\"...\",\"scores\":{\"style\":0-100,\"layout\":0-100,\"density\":0-100,\"imageUse\":0-100,\"delivery\":0-100},\"findings\":[\"...\"],\"fixSuggestions\":[\"...\"]}",
    "复审重点：是否符合目标风格；版式是否像专业商业 PPT；文字是否太密；图片是否用对且不乱；标题层级是否清楚；是否适合先给用户确认。",
    routePlan?.designDirectorStrategy ? "设计总监复审：这必须像视觉优质、提案级、可编辑的专业 PPT；若像普通模板、纯文字汇报、图片/图表过小、标题弱、层级混乱、页面全是同一种卡片、用户素材被弱化，status 必须为 warn 或 block，并指出返工项。" : "",
    stage === "style-preview" ? "当前阶段是风格样稿：重点判断是否值得交给用户人工确认风格。" : "当前阶段是完整 PPT：重点判断是否可继续编辑和导出。",
    `路由：${JSON.stringify({
      deckType: routePlan?.deckType,
      targetSlides: routePlan?.targetSlides,
      theme: routePlan?.recommendedTheme,
      templatePack: routePlan?.templatePack?.name,
      styleFingerprint: routePlan?.styleReferenceStrategy?.fingerprint || quality.routePlan?.styleFingerprint || null
    })}`,
    `质量数据：${JSON.stringify({
      routeScore: quality.routeAdherence?.score,
      warnings: quality.warnings?.slice?.(0, 8) || [],
      imageSlotReport: materialBrief.imageSlotReport || quality.material?.imageSlotReport || null,
      sourceReport: compactSourceReport(materialBrief.sourceReport || quality.material?.sourceReport || null)
    })}`,
    `页面结构：${JSON.stringify(slides)}`
  ].join("\n");
}

function compactSourceReport(report) {
  if (!report) return null;
  return {
    pageCount: report.pageCount,
    textPageCount: report.textPageCount,
    imageCount: report.imageCount,
    boundImageCount: report.boundImageCount,
    warnings: report.warnings?.slice?.(0, 8) || [],
    extractionAudit: report.extractionAudit ? {
      slideCount: report.extractionAudit.slideCount,
      textSlideCount: report.extractionAudit.textSlideCount,
      embeddedImageRefs: report.extractionAudit.embeddedImageRefs,
      extractedImageRefs: report.extractionAudit.extractedImageRefs,
      linkedImageRefs: report.extractionAudit.linkedImageRefs,
      missingImageRefs: report.extractionAudit.missingImageRefs,
      confidence: report.extractionAudit.confidence,
      warnings: report.extractionAudit.warnings?.slice?.(0, 8) || []
    } : null
  };
}

function buildSourceIntakePrompt({ materialBrief, uploads, stage }) {
  const sourceReport = compactSourceReport(materialBrief.sourceReport || null);
  const pages = (materialBrief.sourceReport?.pages || materialBrief.pages || []).slice(0, 20).map((page) => ({
    page: page.page,
    title: page.title,
    textChars: page.textChars || cleanText(page.text || "").length,
    imageCount: page.imageCount || 0,
    status: page.status || null,
    sourceSlideType: page.sourceSlideType || null,
    diagnosisScore: page.diagnosisScore ?? null
  }));
  const files = uploads.slice(0, 30).map((file) => ({
    name: file.originalName || path.basename(file.path || ""),
    mimeType: file.mimeType || "",
    source: file.source || "upload",
    sourceSlide: file.sourceSlide || null,
    derived: Boolean(file.derived)
  }));
  return [
    "You are auditing a PPT generation intake pipeline. Return JSON only.",
    "Decide whether local extraction likely missed text/images, whether slide-image binding looks trustworthy, and what routing should consider.",
    "JSON schema: {\"status\":\"pass|warn|block\",\"confidence\":\"high|medium|low\",\"summary\":\"...\",\"findings\":[\"...\"],\"routingHints\":[\"...\"],\"mustFixBeforeGeneration\":[\"...\"]}",
    `Stage: ${stage}`,
    `Source report: ${JSON.stringify(sourceReport)}`,
    `Pages: ${JSON.stringify(pages)}`,
    `Files: ${JSON.stringify(files)}`
  ].join("\n");
}

function normalizeSourceReview(parsed, provider) {
  const rawStatus = String(parsed.status || "").toLowerCase();
  const status = ["pass", "warn", "block"].includes(rawStatus) ? rawStatus : "warn";
  const rawConfidence = String(parsed.confidence || "").toLowerCase();
  const confidence = ["high", "medium", "low"].includes(rawConfidence) ? rawConfidence : "medium";
  return {
    ...provider,
    used: true,
    status,
    confidence,
    summary: cleanText(parsed.summary || ""),
    findings: Array.isArray(parsed.findings) ? parsed.findings.map(cleanText).filter(Boolean).slice(0, 8) : [],
    routingHints: Array.isArray(parsed.routingHints) ? parsed.routingHints.map(cleanText).filter(Boolean).slice(0, 8) : [],
    mustFixBeforeGeneration: Array.isArray(parsed.mustFixBeforeGeneration) ? parsed.mustFixBeforeGeneration.map(cleanText).filter(Boolean).slice(0, 8) : []
  };
}

async function fileToDataUrl(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > 5 * 1024 * 1024) return null;
  const bytes = await fs.readFile(filePath);
  return `data:${mimeFromExt(path.extname(filePath))};base64,${bytes.toString("base64")}`;
}

function normalizeReview(parsed, provider) {
  const scores = parsed.scores && typeof parsed.scores === "object" ? parsed.scores : {};
  const findings = Array.isArray(parsed.findings) ? parsed.findings.map(cleanText).filter(Boolean).slice(0, 8) : [];
  const fixSuggestions = Array.isArray(parsed.fixSuggestions) ? parsed.fixSuggestions.map(cleanText).filter(Boolean).slice(0, 8) : [];
  const rawStatus = String(parsed.status || "").toLowerCase();
  const status = ["pass", "warn", "block"].includes(rawStatus) ? rawStatus : findings.length ? "warn" : "pass";
  return {
    ...provider,
    used: true,
    status,
    summary: cleanText(parsed.summary || ""),
    scores: {
      style: clampScore(scores.style),
      layout: clampScore(scores.layout),
      density: clampScore(scores.density),
      imageUse: clampScore(scores.imageUse),
      delivery: clampScore(scores.delivery)
    },
    findings,
    fixSuggestions
  };
}

async function fetchOpenAiCompatible(baseUrl, endpoint, options) {
  const errors = [];
  for (const candidate of getCompatibleBaseUrls(baseUrl)) {
    const url = `${candidate}${endpoint}`;
    try {
      const response = await fetch(url, options);
      if (response.ok && /application\/json/i.test(response.headers.get("content-type") || "")) return { response, url };
      errors.push({ response, url });
      if (response.ok || ![404, 405].includes(response.status)) continue;
    } catch (error) {
      errors.push({ error, url });
    }
  }
  const last = errors.at(-1);
  if (last?.response) return last;
  throw new Error(last?.error?.message || "visual review connection failed");
}

function getCompatibleBaseUrls(baseUrl) {
  const normalized = String(baseUrl || "https://api.openai.com/v1").trim().replace(/\/$/, "");
  const candidates = [normalized];
  if (!/\/v\d+(\/|$)/.test(normalized)) candidates.push(`${normalized}/v1`);
  return [...new Set(candidates)];
}

function extractJson(text = "") {
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function readProviderError(response) {
  const text = await response.text();
  try {
    const data = JSON.parse(text);
    return data.error?.message || data.message || text.slice(0, 240);
  } catch {
    return text.slice(0, 240);
  }
}

function mimeFromExt(ext = "") {
  if (/jpe?g/i.test(ext)) return "image/jpeg";
  if (/webp/i.test(ext)) return "image/webp";
  return "image/png";
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function stripEndpoint(url, endpoint) {
  return String(url || "").endsWith(endpoint) ? String(url).slice(0, -endpoint.length) : String(url || "").replace(/\/$/, "");
}

function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}
