import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { rootDir } from "./store.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

const OUTLINE_LAYOUTS = ["cover", "section", "visual", "cards", "timeline", "quote", "closing"];

export function buildSkillFirstOutlineDraft({ input = {}, materialBrief = {}, uploads = [] } = {}) {
  const sourceReport = materialBrief.sourceReport || {};
  const sourcePages = Array.isArray(sourceReport.pages) ? sourceReport.pages : [];
  const sourcePageCount = Number(sourceReport.pageCount || materialBrief.pageCount || 0);
  const requestedCount = resolveDraftSlideCount(input.pageCount, sourcePageCount, materialBrief, uploads);
  const hasSourcePages = Boolean(sourceReport.hasOldDeck && sourcePages.length > 0);
  const layoutSequence = hasSourcePages
    ? buildSourcePageOutline(sourcePages, requestedCount)
    : buildBriefOutline(input, materialBrief, requestedCount);
  return {
    kind: "skill_first_outline_plan",
    version: 1,
    source: "workflow-outline-plan",
    title: cleanString(input.projectName || materialBrief.summary || "Skill-first PPT 工作流大纲"),
    targetSlides: layoutSequence.length,
    inputStrength: materialBrief.inputStrength || "strong",
    layoutSequence,
    routingReasons: [
      "skill-first-outline-plan",
      hasSourcePages ? "preserve-source-page-order" : "brief-to-codex-ppt-outline",
      "codex-ppt-image-deck-first",
      "image-to-editable-ppt-rebuild-second"
    ],
    skillChain: ["codex-ppt", "image-to-editable-ppt"],
    legacyTemplate: {
      used: false,
      reason: "legacy-template-pack-and-master-reuse-removed"
    },
    sourceReport: sourceReport || null
  };
}

function buildSourcePageOutline(sourcePages = [], requestedCount = 1) {
  const pages = sourcePages.slice(0, requestedCount);
  return pages.map((page, index) => {
    const last = index === pages.length - 1;
    const layout = index === 0 ? "cover" : last && pages.length > 2 ? "closing" : inferLayoutFromPage(page, index);
    const title = cleanString(page.title) || `源稿第 ${index + 1} 页`;
    const textPreview = cleanString(page.textPreview || page.text || "").slice(0, 180);
    return normalizeOutlineStep({
      layout,
      title,
      purpose: `保留源稿第 ${page.page || index + 1} 页的信息目标，由 codex-ppt 重绘成视觉统一图片页。`,
      storyRole: index === 0 ? "建立主题" : last && pages.length > 2 ? "收束交付" : "承接源稿内容",
      evidence: textPreview || `source-page-${page.page || index + 1}`,
      visualIntent: page.sourceSlideType ? `参考源页类型：${page.sourceSlideType}` : "重绘为统一视觉页",
      notes: "最终通过 image-to-editable-ppt/editppt 重建为可编辑 PPT。"
    }, index);
  });
}

function buildBriefOutline(input = {}, materialBrief = {}, requestedCount = 5) {
  const summary = cleanString(materialBrief.summary || input.notes || input.projectName || "");
  const base = [
    ["cover", cleanString(input.projectName) || "主题封面", "明确主题、受众和视觉基调。", "建立第一印象"],
    ["section", "核心结论", "把需求或资料压缩成 1 页可确认的主判断。", "给出结论"],
    ["visual", "关键证据", "用视觉页承载最重要的图片、数据或场景。", "证明价值"],
    ["cards", "方案拆解", "将主要卖点、模块或步骤拆成可扫描的信息组。", "展开内容"],
    ["timeline", "执行路径", "说明从当前状态到交付结果的推进节奏。", "落地路径"],
    ["quote", "记忆点", "沉淀一句适合复述的核心表达。", "强化记忆"],
    ["closing", "下一步", "明确复核、确认、交付或行动项。", "推动行动"]
  ];
  const sequence = fitBriefSequence(base, requestedCount);
  return sequence.map(([layout, title, purpose, storyRole], index) => normalizeOutlineStep({
    layout,
    title,
    purpose,
    storyRole,
    evidence: summary,
    visualIntent: "由 codex-ppt 生成视觉统一图片页，再进入可编辑重建。",
    notes: "Skill-first 工作流草案，可在前端修改后确认。"
  }, index));
}

function fitBriefSequence(base = [], requestedCount = 5) {
  const count = Math.max(1, Math.min(50, Number(requestedCount) || 5));
  if (count <= base.length) {
    if (count === 1) return [base[0]];
    return [base[0], ...base.slice(1, count - 1), base[base.length - 1]];
  }
  const middle = base.slice(1, -1);
  const extra = Array.from({ length: count - base.length }, (_item, index) => {
    const layout = OUTLINE_LAYOUTS[(index + 2) % (OUTLINE_LAYOUTS.length - 1)] || "cards";
    return [layout, `内容页 ${index + 1}`, "补充展开材料中的一个关键主题。", "扩展论证"];
  });
  return [base[0], ...middle, ...extra, base[base.length - 1]];
}

function inferLayoutFromPage(page = {}, index = 0) {
  const text = [page.title, page.textPreview, ...(page.diagnosisProblems || [])].filter(Boolean).join(" ");
  if (/price|pricing|价格|报价|费用|预算/i.test(text)) return "pricing";
  if (/risk|风险|清单|checklist/i.test(text)) return "risk-checklist";
  if (/timeline|roadmap|时间|流程|计划|路径/i.test(text)) return "timeline";
  if (/compare|对比|竞品/i.test(text)) return "compare";
  if (Number(page.imageCount || 0) > 0 && !Number(page.textChars || 0)) return "visual";
  return index % 3 === 0 ? "visual" : index % 3 === 1 ? "cards" : "section";
}

function resolveDraftSlideCount(pageCount, sourcePageCount, materialBrief = {}, uploads = []) {
  const text = String(pageCount || "");
  const explicit = text.match(/\d{1,2}/);
  if (explicit) return clampInteger(Number(explicit[0]), 1, 50, 5);
  if (sourcePageCount) return clampInteger(sourcePageCount, 1, 50, sourcePageCount);
  if (Number(materialBrief.charCount || 0) > 5000 || (uploads || []).length > 3) return 8;
  if (materialBrief.inputStrength === "empty") return 5;
  return 5;
}

export async function recordWorkflowCodexPptOutline(jobId, options = {}) {
  const job = await readWorkflowJob(jobId);
  const now = new Date().toISOString();
  const outlinePlan = normalizeOutlinePlan(job, options);
  const outlineDir = path.join(job.rootDir, "codex-ppt");
  await fs.mkdir(outlineDir, { recursive: true });
  const jsonPath = path.join(outlineDir, "outline.json");
  const markdownPath = path.join(outlineDir, "outline.md");
  const payload = {
    kind: "codex_ppt_outline",
    version: 1,
    jobId: job.id,
    source: cleanString(options.source || "workflow-outline"),
    title: cleanString(options.title || outlinePlan.title || job.input?.sourceOriginalName || "Codex PPT outline"),
    slideCount: outlinePlan.layoutSequence.length,
    layoutSequence: outlinePlan.layoutSequence,
    notes: cleanString(options.notes || ""),
    recordedBy: cleanString(options.recordedBy || "local-user"),
    recordedAt: now
  };
  const markdown = buildOutlineMarkdown(payload);
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.writeFile(markdownPath, markdown, "utf8");
  const [jsonStat, markdownStat] = await Promise.all([fs.stat(jsonPath), fs.stat(markdownPath)]);
  job.artifacts = {
    ...(job.artifacts || {}),
    codexPptOutline: {
      kind: "codex_ppt_outline",
      path: jsonPath,
      markdownPath,
      relativePath: path.relative(rootDir, jsonPath),
      markdownRelativePath: path.relative(rootDir, markdownPath),
      slideCount: payload.slideCount,
      source: payload.source,
      title: payload.title,
      size: jsonStat.size,
      markdownSize: markdownStat.size,
      sha256: await hashFile(jsonPath),
      markdownSha256: await hashFile(markdownPath),
      createdAt: now
    }
  };
  job.events = appendEvent(job.events, {
    type: "codex-ppt.outline.recorded",
    message: `Recorded codex-ppt outline (${payload.slideCount} slides)`,
    details: { slideCount: payload.slideCount, source: payload.source, path: jsonPath },
    createdAt: now
  });
  return saveWorkflowJob(job);
}

function normalizeOutlinePlan(job = {}, options = {}) {
  const inputPlan = options.outlinePlan && typeof options.outlinePlan === "object" ? options.outlinePlan : {};
  const inputSequence = Array.isArray(inputPlan.layoutSequence) ? inputPlan.layoutSequence : [];
  const layoutSequence = inputSequence
    .map((step, index) => normalizeOutlineStep(step, index))
    .filter(Boolean);
  if (layoutSequence.length) {
    return {
      ...inputPlan,
      title: cleanString(options.title || inputPlan.title || ""),
      layoutSequence
    };
  }
  const renderedPages = Array.isArray(job.artifacts?.renderedPages) ? job.artifacts.renderedPages : [];
  const sourceBrief = cleanString(options.sourceBrief || job.input?.sourceBrief || job.input?.notes || "");
  const fallbackCount = clampInteger(options.pageCount || renderedPages.length || guessPageCount(sourceBrief), 1, 50, 1);
  return {
    title: cleanString(options.title || job.input?.sourceOriginalName || "Codex PPT outline"),
    layoutSequence: Array.from({ length: fallbackCount }, (_item, index) => {
      const page = renderedPages[index] || {};
      const layout = index === 0 ? "cover" : index === fallbackCount - 1 && fallbackCount > 2 ? "closing" : "content";
      return normalizeOutlineStep({
        layout,
        title: page.title || (index === 0 ? "Opening" : index === fallbackCount - 1 && fallbackCount > 2 ? "Closing" : `Slide ${index + 1}`),
        purpose: page.path
          ? `Reframe source page ${index + 1} into the approved codex-ppt visual system.`
          : "Create a visually unified slide from the provided brief.",
        storyRole: layout === "cover" ? "set context" : layout === "closing" ? "close with action" : "develop the narrative",
        evidence: page.path || sourceBrief.slice(0, 180)
      }, index);
    }).filter(Boolean)
  };
}

function normalizeOutlineStep(step = {}, index = 0) {
  const title = cleanString(step.title || step.heading || step.name || "");
  const layout = cleanString(step.layout || step.type || "content") || "content";
  const purpose = cleanString(step.purpose || step.visualIntent || step.intent || "");
  return {
    id: cleanString(step.id || `slide_${String(index + 1).padStart(2, "0")}`),
    slideNumber: index + 1,
    layout,
    title: title || `Slide ${index + 1}`,
    purpose: purpose || "Create a visually unified slide from the approved source material.",
    storyRole: cleanString(step.storyRole || step.role || ""),
    evidence: cleanString(step.evidence || step.source || ""),
    visualIntent: cleanString(step.visualIntent || purpose || ""),
    notes: cleanString(step.notes || "")
  };
}

function buildOutlineMarkdown(payload) {
  const lines = [
    `# ${payload.title}`,
    "",
    `- Source: ${payload.source}`,
    `- Slide count: ${payload.slideCount}`,
    `- Recorded by: ${payload.recordedBy}`,
    `- Recorded at: ${payload.recordedAt}`,
    "",
    "## Slides"
  ];
  for (const step of payload.layoutSequence) {
    lines.push(
      "",
      `### Slide ${step.slideNumber}: ${step.title}`,
      "",
      `- Layout: ${step.layout}`,
      `- Purpose: ${step.purpose}`
    );
    if (step.storyRole) lines.push(`- Story role: ${step.storyRole}`);
    if (step.evidence) lines.push(`- Evidence: ${step.evidence}`);
    if (step.visualIntent) lines.push(`- Visual intent: ${step.visualIntent}`);
    if (step.notes) lines.push(`- Notes: ${step.notes}`);
  }
  return `${lines.join("\n")}\n`;
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function appendEvent(events = [], event) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    ...event
  }].slice(-500);
}

function guessPageCount(text = "") {
  const match = String(text || "").match(/(\d{1,2})\s*(page|pages|slide|slides)/i);
  return match ? Number(match[1]) : 1;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}
