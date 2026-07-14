import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { readWorkflowJob } from "./workflowJobs.js";
import { getWorkflowDeliveryStatus } from "./workflowDelivery.js";
import { getWorkflowLogBundleLink } from "./workflowLogBundle.js";

export async function listWorkflowArtifactLinks(id) {
  const job = await readWorkflowJob(id);
  const artifacts = job.artifacts || {};
  const reviewArtifacts = await mirrorReviewArtifacts(job);
  const logBundleLink = await getWorkflowLogBundleLink(id);
  const delivery = await getWorkflowDeliveryStatus(id).catch(() => null);
  const finalGate = delivery?.finalGate || null;
  return {
    ok: true,
    jobId: job.id,
    links: decorateArtifactLinks([
      makeLink(job, "final-pptx", "最终 PPTX", artifacts.editableFinal?.path, { download: true }),
      makeDraftFinalLink(job, artifacts, finalGate),
      makeLink(job, "validation", "Validation JSON", artifacts.editableFinal?.validation?.path),
      makeLink(job, "source-meta", "Source Meta", artifacts.sourceMeta?.path),
      makeLink(job, "codex-ppt-outline", "codex-ppt Outline JSON", artifacts.codexPptOutline?.path),
      makeLink(job, "codex-ppt-outline-md", "codex-ppt Outline Markdown", artifacts.codexPptOutline?.markdownPath),
      makeLink(job, "codex-ppt-style", "codex-ppt Style JSON", artifacts.codexPptStyle?.path),
      makeLink(job, "codex-ppt-style-md", "codex-ppt Style Markdown", artifacts.codexPptStyle?.markdownPath),
      makeLink(job, "codex-ppt-backend", "codex-ppt Backend JSON", artifacts.codexPptBackendDecision?.path),
      makeLink(job, "codex-ppt-backend-md", "codex-ppt Backend Markdown", artifacts.codexPptBackendDecision?.markdownPath),
      makeLink(job, "codex-ppt-information-assets", "codex-ppt Information Asset Map", artifacts.codexPptInformationAssets?.path || artifacts.informationAssetMap?.path),
      makeLink(job, "codex-ppt-information-assets-md", "codex-ppt Information Asset Map Markdown", artifacts.codexPptInformationAssets?.markdownPath || artifacts.informationAssetMap?.markdownPath),
      makeLink(job, "codex-ppt-fidelity-assets", "codex-ppt Fidelity Assets Manifest", artifacts.codexPptFidelityAssets?.path || artifacts.codexPptInformationAssets?.fidelityAssetManifestPath),
      makeLink(job, "codex-ppt-sample-prompt-preview", "codex-ppt 样张 Prompt 预览", artifacts.codexPptSamplePromptPreview?.path),
      makeLink(job, "visual-sample", "codex-ppt 视觉样张", artifacts.visualSample?.path),
      makeLink(job, "codex-ppt-deck-spec", "codex-ppt Deck Spec", artifacts.codexPptDeckSpec?.path),
      makeLink(job, "codex-ppt-speech", "codex-ppt Speech Notes", artifacts.codexPptSpeech?.path),
      makeLink(job, "codex-ppt-slide-jobs", "codex-ppt Slide Jobs", artifacts.codexPptSlideJobs?.path),
      makeLink(job, "codex-ppt-slide-run-state", "codex-ppt Slide Run State", artifacts.codexPptSlideRunState?.path),
      ...artifactArrayLinks(job, "codex-ppt-slide-prompt", "codex-ppt Slide Prompt", artifacts.codexPptSlidePrompts),
      makeLink(job, "ocr-text-hints", "OCR Text Hints", artifacts.ocrTextHints?.path),
      ...artifactArrayLinks(job, "ocr-page", "OCR Page", artifacts.ocrPages),
      ...artifactArrayLinks(job, "editable-text-hint", "editppt Text Hint", artifacts.editableHints?.summary?.pages),
      makeLink(job, "image-deck", "图片型 PPT", artifacts.imageDeck?.path, { download: true }),
      makeLink(job, "visual-quality", "视觉质量报告", artifacts.visualQuality?.path),
      ...artifactArrayLinks(job, "rendered-page", "源稿页面图", artifacts.renderedPages),
      ...artifactArrayLinks(job, "visual-page", "视觉页面图", artifacts.visualImages),
      ...artifactArrayLinks(job, "rebuild-preview", "重建预览图", reviewArtifacts.previews),
      ...artifactArrayLinks(job, "asset-contact-sheet", "资产分离总览图", reviewArtifacts.contactSheets),
      ...artifactArrayLinks(job, "final-compare", "最终对比图", getFinalCompareArtifacts(job)),
      ...artifactArrayLinks(job, "page-validation", "页面 Validation", reviewArtifacts.validations),
      ...artifactArrayLinks(job, "page-result", "页面 Result", reviewArtifacts.results),
      ...artifactArrayLinks(job, "page-pptx", "页面 PPTX", reviewArtifacts.pptx, { download: true }),
      logBundleLink
    ].filter(Boolean), finalGate)
  };
}

export async function resolveWorkflowArtifact(id, key, pageId = "") {
  const job = await readWorkflowJob(id);
  const artifacts = job.artifacts || {};
  const normalizedKey = cleanKey(key);
  if (["rebuild-preview", "asset-contact-sheet", "page-validation", "page-result", "page-pptx"].includes(normalizedKey)) {
    await mirrorReviewArtifacts(job);
  }
  let filePath = "";
  let fileName = "";
  let inline = true;

  if (normalizedKey === "final-pptx") {
    await assertFinalPptxDownloadable(id);
    filePath = artifacts.editableFinal?.path || "";
    fileName = "editable-final.pptx";
    inline = false;
  } else if (normalizedKey === "draft-final-pptx") {
    await assertDraftFinalPptxDownloadable(id);
    filePath = artifacts.editableFinal?.path || "";
    const finalPages = artifacts.editableFinal?.summary?.page_count || artifacts.editableFinal?.pptxEditability?.slideCount || "";
    fileName = finalPages ? `editable-sample-${finalPages}p-draft.pptx` : "editable-sample-draft.pptx";
    inline = false;
  } else if (normalizedKey === "validation") {
    filePath = artifacts.editableFinal?.validation?.path || "";
    fileName = "editable-validation.json";
  } else if (normalizedKey === "source-meta") {
    filePath = artifacts.sourceMeta?.path || "";
    fileName = "source_meta.json";
  } else if (normalizedKey === "codex-ppt-outline") {
    filePath = artifacts.codexPptOutline?.path || "";
    fileName = "codex-ppt-outline.json";
  } else if (normalizedKey === "codex-ppt-outline-md") {
    filePath = artifacts.codexPptOutline?.markdownPath || "";
    fileName = "codex-ppt-outline.md";
  } else if (normalizedKey === "codex-ppt-style") {
    filePath = artifacts.codexPptStyle?.path || "";
    fileName = "codex-ppt-style.json";
  } else if (normalizedKey === "codex-ppt-style-md") {
    filePath = artifacts.codexPptStyle?.markdownPath || "";
    fileName = "codex-ppt-style.md";
  } else if (normalizedKey === "codex-ppt-backend") {
    filePath = artifacts.codexPptBackendDecision?.path || "";
    fileName = "codex-ppt-backend.json";
  } else if (normalizedKey === "codex-ppt-backend-md") {
    filePath = artifacts.codexPptBackendDecision?.markdownPath || "";
    fileName = "codex-ppt-backend.md";
  } else if (normalizedKey === "codex-ppt-information-assets") {
    filePath = artifacts.codexPptInformationAssets?.path || artifacts.informationAssetMap?.path || "";
    fileName = "information_asset_map.json";
  } else if (normalizedKey === "codex-ppt-information-assets-md") {
    filePath = artifacts.codexPptInformationAssets?.markdownPath || artifacts.informationAssetMap?.markdownPath || "";
    fileName = "information_asset_map.md";
  } else if (normalizedKey === "codex-ppt-fidelity-assets") {
    filePath = artifacts.codexPptFidelityAssets?.path || artifacts.codexPptInformationAssets?.fidelityAssetManifestPath || "";
    fileName = "fidelity_assets_manifest.json";
  } else if (normalizedKey === "codex-ppt-sample-prompt-preview") {
    filePath = artifacts.codexPptSamplePromptPreview?.path || "";
    fileName = "sample_prompt_preview.json";
  } else if (normalizedKey === "visual-sample") {
    filePath = artifacts.visualSample?.path || "";
    fileName = path.basename(filePath || "visual-sample.png");
  } else if (normalizedKey === "codex-ppt-deck-spec") {
    filePath = artifacts.codexPptDeckSpec?.path || "";
    fileName = "deck_spec.json";
  } else if (normalizedKey === "codex-ppt-speech") {
    filePath = artifacts.codexPptSpeech?.path || "";
    fileName = "speech.md";
  } else if (normalizedKey === "codex-ppt-slide-jobs") {
    filePath = artifacts.codexPptSlideJobs?.path || "";
    fileName = "slide_jobs.json";
  } else if (normalizedKey === "codex-ppt-slide-run-state") {
    filePath = artifacts.codexPptSlideRunState?.path || "";
    fileName = "slide_run_state.json";
  } else if (normalizedKey === "codex-ppt-slide-prompt") {
    const prompt = findPageArtifact(artifacts.codexPptSlidePrompts, pageId);
    filePath = prompt?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}-slide-prompt.json`);
  } else if (normalizedKey === "ocr-text-hints") {
    filePath = artifacts.ocrTextHints?.path || "";
    fileName = "ocr-text-hints.json";
  } else if (normalizedKey === "ocr-page") {
    const page = findPageArtifact(artifacts.ocrPages, pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}-ocr.json`);
  } else if (normalizedKey === "editable-text-hint") {
    const page = findPageArtifact(artifacts.editableHints?.summary?.pages, pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}-text_hints.json`);
  } else if (normalizedKey === "image-deck") {
    filePath = artifacts.imageDeck?.path || "";
    fileName = path.basename(filePath || "image-deck.pptx");
    inline = false;
  } else if (normalizedKey === "visual-quality") {
    filePath = artifacts.visualQuality?.path || "";
    fileName = "visual_quality_report.json";
  } else if (normalizedKey === "rendered-page") {
    const page = findPageArtifact(artifacts.renderedPages, pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}.png`);
  } else if (normalizedKey === "visual-page") {
    const page = findPageArtifact(artifacts.visualImages, pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}.png`);
  } else if (normalizedKey === "rebuild-preview") {
    const page = findPageArtifact(getMirroredReviewArtifacts(job, "preview.png"), pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}-preview.png`);
  } else if (normalizedKey === "asset-contact-sheet") {
    const page = findPageArtifact(getMirroredReviewArtifacts(job, "split_assets_contact.png"), pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}-asset-contact-sheet.png`);
  } else if (normalizedKey === "final-compare") {
    const page = findPageArtifact(getFinalCompareArtifacts(job), pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}-compare.png`);
  } else if (normalizedKey === "page-validation") {
    const page = findPageArtifact(getMirroredReviewArtifacts(job, "validation.json"), pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}-validation.json`);
  } else if (normalizedKey === "page-result") {
    const page = findPageArtifact(getMirroredReviewArtifacts(job, "page_result.json"), pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}-page_result.json`);
  } else if (normalizedKey === "page-pptx") {
    const page = findPageArtifact(getMirroredReviewArtifacts(job, "page.pptx"), pageId);
    filePath = page?.path || "";
    fileName = path.basename(filePath || `${cleanPageId(pageId)}.pptx`);
    inline = false;
  } else {
    throw new Error("Unsupported workflow artifact key");
  }

  const resolved = resolveJobFile(job, filePath);
  return {
    path: resolved,
    fileName,
    inline,
    contentType: contentTypeForFile(resolved)
  };
}

export function isFinalPptxProductReady(finalGate = {}) {
  return finalGate?.productReady === true;
}

async function assertFinalPptxDownloadable(id) {
  const delivery = await getWorkflowDeliveryStatus(id);
  const gate = delivery.finalGate || {};
  if (!isFinalPptxProductReady(gate)) {
    const error = new Error(gate.summary || "Final PPTX is blocked until productReady=true.");
    error.status = 409;
    error.code = "WORKFLOW_FINAL_PPTX_BLOCKED";
    error.finalGate = {
      level: gate.level || "blocked",
      label: gate.label || "not-deliverable.pptx",
      title: gate.title || "Delivery blocked",
      productReady: gate.productReady === true,
      reasons: gate.reasons || [],
      warnings: gate.warnings || []
    };
    throw error;
  }
}

async function assertDraftFinalPptxDownloadable(id) {
  const delivery = await getWorkflowDeliveryStatus(id);
  const gate = delivery.finalGate || {};
  const checks = gate.checks || {};
  const sourcePages = Number(checks.sourcePages || delivery.coverage?.sourcePages || 0);
  const finalPages = Number(checks.finalPages || delivery.coverage?.finalPages || 0);
  if (!finalPages || !sourcePages || gate.productReady === true) {
    const error = new Error("Draft final PPTX is only available before final delivery approval.");
    error.status = 404;
    error.code = "WORKFLOW_DRAFT_FINAL_NOT_AVAILABLE";
    throw error;
  }
}

function artifactArrayLinks(job, key, label, records = [], options = {}) {
  return (Array.isArray(records) ? records : []).map((record) => makeLink(job, key, `${label} ${record.pageId || record.pageNumber || ""}`.trim(), record.path, {
    ...options,
    pageId: record.pageId || `page_${String(record.pageNumber || "").padStart(3, "0")}`
  })).filter(Boolean);
}

function getFinalCompareArtifacts(job = {}) {
  const rootDir = job.rootDir || "";
  const renderedCheckDir = path.join(rootDir, "final", "rendered-check");
  if (!rootDir || !fsSync.existsSync(renderedCheckDir)) return [];
  return fsSync.readdirSync(renderedCheckDir)
    .map((fileName) => {
      const match = String(fileName || "").match(/^compare_(\d+)\.(png|jpg|jpeg|webp)$/i);
      if (!match) return null;
      return {
        pageId: `page_${String(match[1]).padStart(3, "0")}`,
        path: path.join(renderedCheckDir, fileName)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.pageId.localeCompare(b.pageId));
}

function makeLink(job, key, label, filePath, options = {}) {
  if (!filePath) return null;
  try {
    const resolved = resolveJobFile(job, filePath);
    const pagePart = options.pageId ? `/${encodeURIComponent(options.pageId)}` : "";
    return {
      key,
      pageId: options.pageId || "",
      label,
      fileName: path.basename(resolved),
      size: fsSync.statSync(resolved).size,
      href: `/api/workflow-jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(key)}${pagePart}${options.download ? "?download=1" : ""}`
    };
  } catch {
    return null;
  }
}

function makeDraftFinalLink(job, artifacts = {}, finalGate = null) {
  const checks = finalGate?.checks || {};
  const sourcePages = Number(checks.sourcePages || 0);
  const finalPages = Number(checks.finalPages || artifacts.editableFinal?.summary?.page_count || artifacts.editableFinal?.pptxEditability?.slideCount || 0);
  if (!artifacts.editableFinal?.path || !sourcePages || !finalPages || finalGate?.productReady === true) return null;
  const partial = finalPages < sourcePages;
  const label = partial ? `Draft check PPTX (${finalPages}/${sourcePages})` : "Draft check PPTX";
  const link = makeLink(job, "draft-final-pptx", label, artifacts.editableFinal.path, { download: true });
  return link ? {
    ...link,
    draft: true,
    downloadable: true,
    warning: partial ? `Only ${finalPages}/${sourcePages} pages are generated; this is not final delivery.` : "All pages are generated, but manual review is not complete; this is a draft check file."
  } : null;
}

function decorateArtifactLinks(links = [], finalGate = null) {
  return (Array.isArray(links) ? links : []).map((link) => {
    if (link?.key === "draft-final-pptx") {
      return {
        ...link,
        exists: true,
        downloadable: true,
        blocked: false,
        nextAction: "继续重建剩余页面后，再生成最终产品级 PPT。"
      };
    }
    if (!link || link.key !== "final-pptx") {
      return link?.size ? { ...link, exists: true } : link;
    }
    const productReady = isFinalPptxProductReady(finalGate);
    const blocked = !productReady;
    return {
      ...link,
      label: "Final PPTX",
      exists: true,
      downloadable: productReady,
      blocked,
      blockedReason: blocked ? firstText(finalGate.reasons) || firstText(finalGate.warnings) : "",
      nextAction: blocked ? inferBlockedFinalNextAction(finalGate) : ""
    };
  });
}

function firstText(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .find(Boolean) || "";
}

function inferBlockedFinalNextAction(finalGate = {}) {
  const text = [firstText(finalGate.reasons), firstText(finalGate.warnings)].join(" ");
  if (/Page-level PPTX cannot be opened by PowerPoint/i.test(text)) return "重置打不开的页面任务，重新运行可编辑重建后再生成最终 PPT。";
  if (/local text-only multi-page worker|Local text-only multi-page worker/i.test(text)) return "运行产品级可编辑重建后重新生成最终 PPT；本地文本多页输出只能作为实验验证。";
  if (/PowerPoint|open PPTX|could not open|0x80070570/i.test(text)) return "修复可编辑重建或最终生成输出后重新生成最终 PPT；当前文件不能被 PowerPoint 打开。";
  if (/hash|哈希|过期|stale/i.test(text)) return "重置过期页面证据后，重新运行可编辑重建页面任务。";
  if (/page worker evidence|页面任务证据|page task evidence|worker evidence/i.test(text)) return "补齐或重跑可编辑重建页面任务证据后，再生成最终 PPT。";
  if (/manual|人工|复核/i.test(text)) return "完成人工页面复核后再下载最终 PPTX。";
  if (/validation|校验/i.test(text)) return "查看 validation 结果并修复失败页。";
  return "先处理交付门禁提示，再下载最终 PPTX。";
}

function resolveJobFile(job, filePath) {
  if (!filePath) throw new Error("Workflow artifact has no file path");
  const resolved = path.resolve(String(filePath));
  const jobRoot = path.resolve(job.rootDir);
  if (!isInsidePath(resolved, jobRoot)) throw new Error("Artifact path is outside workflow job root");
  if (!fsSync.existsSync(resolved)) throw new Error("Workflow artifact file not found");
  const stat = fsSync.statSync(resolved);
  if (!stat.isFile()) throw new Error("Workflow artifact is not a file");
  return resolved;
}

function findPageArtifact(records, pageId) {
  const clean = cleanPageId(pageId);
  return (Array.isArray(records) ? records : []).find((record) => {
    const recordPage = cleanPageId(record.pageId || `page_${String(record.pageNumber || "").padStart(3, "0")}`);
    return recordPage === clean;
  });
}

function cleanKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function cleanPageId(value) {
  const text = String(value || "").trim().toLowerCase();
  const numberMatch = text.match(/\d+/);
  if (!numberMatch) return "";
  return `page_${String(Number(numberMatch[0])).padStart(3, "0")}`;
}

function isInsidePath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".md" || ext === ".txt") return "text/plain; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

async function mirrorReviewArtifacts(job) {
  const runDir = path.resolve(job.artifacts?.editableRun?.path || "");
  const tasks = Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks : [];
  const targetRoot = path.join(job.rootDir, "review-artifacts");
  const result = { previews: [], contactSheets: [], validations: [], results: [], pptx: [] };
  if (!runDir || !fsSync.existsSync(runDir)) return result;
  for (const task of tasks) {
    if (task.status !== "recorded") continue;
    const pageId = cleanPageId(task.pageId);
    if (!pageId) continue;
    const sourcePageDir = path.resolve(String(task.pageDir || ""));
    if (!isInsidePath(sourcePageDir, runDir)) continue;
    if (!isRealPathInside(sourcePageDir, runDir)) continue;
    if (path.basename(sourcePageDir).toLowerCase() !== pageId) continue;
    const targetDir = path.join(targetRoot, pageId);
    await fs.mkdir(targetDir, { recursive: true });
    await mirrorNamedArtifact({ pageId, sourcePageDir, targetDir, sourceName: "preview.png", targetName: "preview.png", bucket: result.previews });
    await mirrorNamedArtifact({ pageId, sourcePageDir, targetDir, sourceName: "split_assets_contact.png", targetName: "split_assets_contact.png", bucket: result.contactSheets });
    await mirrorNamedArtifact({ pageId, sourcePageDir, targetDir, sourceName: "validation.json", targetName: "validation.json", bucket: result.validations });
    await mirrorNamedArtifact({ pageId, sourcePageDir, targetDir, sourceName: "page_result.json", targetName: "page_result.json", bucket: result.results });
    await mirrorNamedArtifact({ pageId, sourcePageDir, targetDir, sourceName: "page.pptx", targetName: "page.pptx", bucket: result.pptx });
  }
  return result;
}

async function mirrorNamedArtifact({ pageId, sourcePageDir, targetDir, sourceName, targetName, bucket }) {
  const sourcePath = path.join(sourcePageDir, sourceName);
  if (!fsSync.existsSync(sourcePath) || !fsSync.statSync(sourcePath).isFile()) return;
  if (!isRealPathInside(sourcePath, sourcePageDir)) return;
  if (!isRealPathInside(targetDir, path.dirname(targetDir))) return;
  const targetPath = path.join(targetDir, targetName);
  if (fsSync.existsSync(targetPath) && !isRealPathInside(targetPath, targetDir)) return;
  const sourceStat = fsSync.statSync(sourcePath);
  const targetStat = fsSync.existsSync(targetPath) ? fsSync.statSync(targetPath) : null;
  if (!targetStat || targetStat.size !== sourceStat.size || targetStat.mtimeMs < sourceStat.mtimeMs) {
    await fs.copyFile(sourcePath, targetPath);
  }
  bucket.push({ pageId, path: targetPath, size: sourceStat.size });
}

function isRealPathInside(candidate, parent) {
  try {
    const realCandidate = fsSync.realpathSync(candidate);
    const realParent = fsSync.realpathSync(parent);
    return isInsidePath(realCandidate, realParent);
  } catch {
    return false;
  }
}

function getMirroredReviewArtifacts(job, fileName) {
  const tasks = Array.isArray(job.artifacts?.editableWorkerTasks) ? job.artifacts.editableWorkerTasks : [];
  return tasks
    .filter((task) => task.status === "recorded")
    .map((task) => {
      const pageId = cleanPageId(task.pageId);
      return pageId ? { pageId, path: path.join(job.rootDir, "review-artifacts", pageId, fileName) } : null;
    })
    .filter(Boolean);
}
