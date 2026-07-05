import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { readWorkflowJob } from "./workflowJobs.js";
import { inspectPowerPointOpenability } from "./pptxEditability.js";

const REQUIRED_PAGE_RESULT_KEYS = [
  "page_manifest",
  "imagegen_jobs",
  "page_pptx",
  "preview",
  "contact_sheet",
  "validation",
  "page_result"
];

const REQUIRED_MANIFEST_KEYS = [
  "slide",
  "content_box",
  "source",
  "text_inventory",
  "visual_inventory",
  "background_strategy",
  "quality_checks",
  "text_boxes",
  "shapes",
  "images",
  "asset_provenance"
];

export async function scanWorkflowPageEvidence(jobOrId, options = {}) {
  const job = typeof jobOrId === "string" ? await readWorkflowJob(jobOrId) : jobOrId;
  const runDir = job?.artifacts?.editableRun?.path || "";
  const openableRepairOk = job?.artifacts?.editableFinal?.openableRepair?.ok === true;
  if (!runDir || !fsSync.existsSync(runDir)) {
    return emptyEvidence({ runDir, issue: "Editable run directory is missing." });
  }
  const pageJobsPath = path.join(runDir, "page_jobs.json");
  const pageJobs = await readJson(pageJobsPath).catch(() => null);
  const pages = Array.isArray(pageJobs?.pages) ? pageJobs.pages : [];
  if (!pages.length) {
    return emptyEvidence({ runDir, issue: "page_jobs.json has no pages." });
  }
  const pageEvidence = [];
  for (const page of pages) {
    pageEvidence.push(await scanPageEvidence(runDir, page, {
      openableRepairOk,
      skipPowerPointOpenability: options.skipPowerPointOpenability === true
    }));
  }
  const summary = summarizePages(pageEvidence);
  return {
    ok: true,
    runDir,
    pageJobsPath,
    totalPages: pageEvidence.length,
    summary,
    complete: summary.completePages === pageEvidence.length,
    pages: pageEvidence,
    issues: pageEvidence.flatMap((page) => page.issues.map((issue) => ({ pageId: page.pageId, issue }))).slice(0, 80)
  };
}

async function scanPageEvidence(runDir, page = {}, options = {}) {
  const pageId = normalizePageId(page.page_id || page.pageId || "");
  const pageDir = resolveRunPath(runDir, page.page_dir || `pages/${pageId}`);
  const dispatch = page.dispatch || null;
  const result = page.result || null;
  const outputs = result?.outputs || {};
  const issues = [];
  const promptPath = resolveRunPath(runDir, dispatch?.prompt || path.join("pages", pageId, "worker-prompt.md"));
  const dispatchOk = Boolean(dispatch?.agent_id && dispatch?.dispatched_at && dispatch?.prompt && fileExists(promptPath));
  if (!dispatchOk) issues.push("missing-dispatch-evidence");

  const outputEvidence = {};
  for (const key of REQUIRED_PAGE_RESULT_KEYS) {
    const relative = outputs[key] || fallbackOutputPath(pageId, key);
    const filePath = resolveRunPath(runDir, relative);
    const exists = fileExists(filePath);
    outputEvidence[key] = { path: filePath, exists, hashMatched: null };
    if (!exists) issues.push(`missing-${key}`);
  }

  const validation = await readJson(outputEvidence.validation.path).catch(() => null);
  const validationPassed = validation?.passed === true;
  if (!validationPassed) issues.push("validation-not-passed");

  const pageResult = await readJson(outputEvidence.page_result.path).catch(() => null);
  const pageResultShapeOk = REQUIRED_PAGE_RESULT_KEYS.every((key) => typeof pageResult?.[key] === "string" && pageResult[key]);
  if (!pageResultShapeOk) issues.push("page-result-shape-invalid");

  const pagePptxOpenability = outputEvidence.page_pptx.exists
    ? await inspectPagePptxOpenability(outputEvidence.page_pptx.path, {
        page,
        openableRepairOk: options.openableRepairOk,
        skipPowerPointOpenability: options.skipPowerPointOpenability
      })
    : null;
  const pagePptxOpenable = pagePptxOpenability?.openable !== false;
  if (pagePptxOpenability?.openable === false) issues.push("page-pptx-powerpoint-open-failed");
  if (pagePptxOpenability?.skipped === true) issues.push("page-pptx-openability-skipped");

  const manifest = await readJson(outputEvidence.page_manifest.path).catch(() => null);
  const manifestCheck = checkManifestContract(manifest);
  if (!manifestCheck.ok) issues.push(...manifestCheck.issues);

  const hashResults = await verifyOutputHashes(result?.hashes || {}, outputEvidence);
  const effectiveHashResults = hashResults.map((hash) => ({
    ...hash,
    matched: hash.matched || Boolean(options.openableRepairOk && hash.key === "page_pptx" && pagePptxOpenable)
  }));
  for (const hash of hashResults) {
    const effective = effectiveHashResults.find((item) => item.key === hash.key) || hash;
    outputEvidence[hash.key].hashMatched = effective.matched;
    if (!effective.matched) issues.push(`hash-mismatch-${hash.key}`);
  }
  const allHashesMatched = effectiveHashResults.length ? effectiveHashResults.every((item) => item.matched) : false;
  if (!hashResults.length) issues.push("missing-recorded-hashes");

  const resultOk = Boolean(result?.agent_id && result?.recorded_at && result?.record_mode === "dispatched-worker" && result?.validation_passed === true);
  if (!resultOk) issues.push("missing-record-evidence");

  const requiredArtifactsOk = Object.values(outputEvidence).every((item) => item.exists);
  const complete = dispatchOk && resultOk && requiredArtifactsOk && validationPassed && pageResultShapeOk && pagePptxOpenable && !pagePptxOpenability?.skipped && manifestCheck.ok && allHashesMatched;
  return {
    pageId,
    status: page.status || "",
    accepted: page.accepted === true,
    pageDir,
    dispatchOk,
    resultOk,
    requiredArtifactsOk,
    validationPassed,
    pageResultShapeOk,
    pagePptxOpenable,
    pagePptxOpenability,
    manifestContractOk: manifestCheck.ok,
    hashMatched: allHashesMatched,
    complete,
    recordMode: result?.record_mode || "",
    agentId: result?.agent_id || dispatch?.agent_id || "",
    issues: [...new Set(issues)]
  };
}

async function inspectPagePptxOpenability(filePath, options = {}) {
  const repair = options.page?.result?.openable_repair || null;
  if (options.openableRepairOk && repair?.pagePptx) {
    return {
      version: 1,
      source: "page-openable-repair-cache",
      available: process.platform === "win32",
      openable: true,
      slideCount: 1,
      warnings: [],
      error: ""
    };
  }
  if (options.skipPowerPointOpenability) {
    return {
      version: 1,
      source: "powerpoint-com-open",
      available: process.platform === "win32",
      openable: null,
      slideCount: 0,
      skipped: true,
      warnings: ["powerpoint-open-check-skipped-until-full-delivery"],
      error: ""
    };
  }
  const attempts = [];
  for (let index = 0; index < 3; index += 1) {
    const result = await inspectPowerPointOpenability(filePath).catch((error) => ({
      version: 1,
      source: "powerpoint-com-open",
      available: process.platform === "win32",
      openable: false,
      slideCount: 0,
      warnings: ["powerpoint-open-check-failed"],
      error: error.message || "PowerPoint open check failed"
    }));
    attempts.push(result);
    if (result?.openable !== false) {
      return index === 0 ? result : {
        ...result,
        warnings: [...(Array.isArray(result.warnings) ? result.warnings : []), `powerpoint-open-succeeded-after-${index + 1}-attempts`],
        attempts: attempts.map(compactOpenabilityAttempt)
      };
    }
    await sleep(250);
  }
  const last = attempts[attempts.length - 1] || {};
  return {
    ...last,
    attempts: attempts.map(compactOpenabilityAttempt)
  };
}

function compactOpenabilityAttempt(result = {}) {
  return {
    openable: result.openable ?? null,
    slideCount: result.slideCount || 0,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    error: result.error || ""
  };
}

function checkManifestContract(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== "object") return { ok: false, issues: ["manifest-json-invalid"] };
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!(key in manifest)) issues.push(`manifest-missing-${key}`);
  }
  for (const item of Array.isArray(manifest.text_boxes) ? manifest.text_boxes : []) {
    if (!isValidBox(item?.box_px)) issues.push("manifest-text-box-missing-box-px");
  }
  for (const item of Array.isArray(manifest.images) ? manifest.images : []) {
    if (!isValidBox(item?.box_px)) issues.push("manifest-image-missing-box-px");
  }
  for (const item of Array.isArray(manifest.shapes) ? manifest.shapes : []) {
    const type = String(item?.type || "").toLowerCase();
    if (type === "line") {
      if (!Array.isArray(item?.points_px) || item.points_px.length !== 4) issues.push("manifest-line-missing-points-px");
    } else if (!isValidBox(item?.box_px)) {
      issues.push("manifest-shape-missing-box-px");
    }
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

async function verifyOutputHashes(hashes = {}, outputEvidence = {}) {
  const results = [];
  for (const key of REQUIRED_PAGE_RESULT_KEYS) {
    const expected = String(hashes[key] || "").trim().toLowerCase();
    const filePath = outputEvidence[key]?.path || "";
    if (!expected || !fileExists(filePath)) continue;
    const actual = await hashFile(filePath).catch(() => "");
    results.push({ key, expected, actual, matched: actual === expected });
  }
  return results;
}

function summarizePages(pages = []) {
  return {
    total: pages.length,
    dispatched: pages.filter((page) => page.dispatchOk).length,
    recorded: pages.filter((page) => page.resultOk).length,
    artifacts: pages.filter((page) => page.requiredArtifactsOk).length,
    validationPassed: pages.filter((page) => page.validationPassed).length,
    pageResultShape: pages.filter((page) => page.pageResultShapeOk).length,
    pagePptxOpenable: pages.filter((page) => page.pagePptxOpenable).length,
    pagePptxOpenabilitySkipped: pages.filter((page) => page.pagePptxOpenability?.skipped === true).length,
    manifestContract: pages.filter((page) => page.manifestContractOk).length,
    hashes: pages.filter((page) => page.hashMatched).length,
    completePages: pages.filter((page) => page.complete).length
  };
}

function emptyEvidence({ runDir = "", issue = "" } = {}) {
  return {
    ok: false,
    runDir,
    totalPages: 0,
    summary: summarizePages([]),
    complete: false,
    pages: [],
    issues: issue ? [{ pageId: "", issue }] : []
  };
}

function fallbackOutputPath(pageId, key) {
  const names = {
    page_manifest: "manifest.json",
    imagegen_jobs: "imagegen-jobs.json",
    page_pptx: "page.pptx",
    preview: "preview.png",
    contact_sheet: "split_assets_contact.png",
    validation: "validation.json",
    page_result: "page_result.json"
  };
  return path.join("pages", pageId, names[key] || key);
}

function resolveRunPath(runDir, value = "") {
  const raw = String(value || "");
  if (!raw) return "";
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(runDir, raw);
}

function fileExists(filePath = "") {
  return Boolean(filePath && fsSync.existsSync(filePath) && fsSync.statSync(filePath).isFile());
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isValidBox(value) {
  return Array.isArray(value) && value.length === 4 && value.every((item) => Number.isFinite(Number(item)));
}

function normalizePageId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `page_${String(Number(raw)).padStart(3, "0")}`;
  return /^page_\d{3}$/i.test(raw) ? raw.toLowerCase() : raw;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
