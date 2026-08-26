import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { getProviderConfig, normalizeBaseUrl } from "./providers.js";
import { readWorkflowJob, saveWorkflowJob } from "./workflowJobs.js";

export const CODEX_PPT_GATES = new Map([
  ["outline", "outline approval"],
  ["style", "style approval"],
  ["backend", "backend approval"],
  ["sample", "sample approval"],
  ["fullDeck", "full-deck authorization"]
]);

export const CODEX_PPT_VISUAL_SAMPLE_GATES = ["outline", "style", "backend"];
export const CODEX_PPT_VISUAL_TEST_GATES = ["outline", "style", "backend", "sample"];
export const CODEX_PPT_VISUAL_DECK_GATES = ["outline", "style", "backend", "sample", "fullDeck"];
const LEGACY_CODEX_PPT_STYLE_RE = /轻盈渐变风|东方自然风|黑白画册风|蓝白科技风|暗黑科技风|旧模板|旧版模板|模板包|template[-_\s]?pack/i;
const SAMPLE_HASH_CACHE = new Map();

export async function approveCodexPptGate(jobId, options = {}) {
  const gate = normalizeGate(options.gate);
  const job = await readWorkflowJob(jobId);
  assertApprovalPreconditions(job, gate, options);
  const now = new Date().toISOString();
  const approvals = getApprovals(job).filter((item) => item.gate !== gate);
  const record = {
    kind: "codex_ppt_approval",
    gate,
    label: CODEX_PPT_GATES.get(gate),
    status: "approved",
    note: cleanString(options.note || ""),
    approvedBy: cleanString(options.approvedBy || "local-user"),
    approvedAt: now
  };
  if (gate === "backend") {
    record.backend = buildBackendSnapshot(options.backend);
  }
  if (gate === "sample") {
    record.sampleSha256 = cleanString(job.artifacts?.visualSample?.sha256 || "");
  }
  if (gate === "fullDeck" && !isNonProductApprovalAllowed(options)) {
    record.testDeck = buildFullDeckTestEvidence(job);
  }
  approvals.push(record);
  job.artifacts = {
    ...(job.artifacts || {}),
    codexPptApprovals: approvals,
    ...(gate === "backend" ? { codexPptBackend: record.backend } : {})
  };
  if (gate === "sample") {
    await reconcileVisualArtifactsForApprovedSample(job, record, now);
  }
  job.events = appendEvent(job.events, {
    type: "codex-ppt.approval.approved",
    message: `Approved ${record.label}`,
    details: { gate, backend: record.backend || null, sampleSha256: record.sampleSha256 || "" },
    createdAt: now
  });
  return saveWorkflowJob(job);
}

export async function reconcileVisualArtifactsForApprovedSample(job = {}, approval = {}, now = new Date().toISOString()) {
  const sample = job.artifacts?.visualSample || {};
  const samplePath = sample.path ? path.resolve(sample.path) : "";
  const sampleSha256 = cleanString(approval.sampleSha256 || sample.sha256 || "");
  const visualImages = (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : []).map((image) => {
    const references = (Array.isArray(image.referenceImagePaths) ? image.referenceImagePaths : [])
      .map((item) => path.resolve(item || ""));
    const matches = Boolean(sampleSha256 && (
      image.approvedSampleSha256 === sampleSha256
      || (samplePath && references.includes(samplePath))
    ));
    return {
      ...image,
      staleStyleReference: !matches,
      styleLockStatus: matches ? "current" : "stale",
      currentApprovedSampleSha256: sampleSha256
    };
  });
  const stalePageIds = visualImages.filter((image) => image.staleStyleReference).map((image) => image.pageId).filter(Boolean);
  const artifacts = { ...(job.artifacts || {}), visualImages };
  if (stalePageIds.length) {
    for (const key of [
      "imageDeck",
      "imageDeckReview",
      "visualQuality",
      "visualQualityReview",
      "editableRun",
      "editableHints",
      "editableNext",
      "editableWorkerPrompts",
      "editableWorkerTasks",
      "editableDispatches",
      "editableRecords",
      "editableLocalRebuilds",
      "editableWorkerBatchRuns",
      "editableFinal",
      "editableTextHintsAcknowledgement",
      "workerBriefs"
    ]) delete artifacts[key];
  }
  job.artifacts = artifacts;
  const manifestPath = artifacts.visualManifest?.path || "";
  if (manifestPath && visualImages.length) {
    try {
      const previous = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      const manifest = {
        ...(previous && !Array.isArray(previous) ? previous : {}),
        version: Number(previous?.version || 1),
        kind: previous?.kind || "workflow_visual_images_manifest",
        updatedAt: now,
        styleReconciledAt: now,
        imageCount: visualImages.length,
        images: visualImages
      };
      const body = JSON.stringify(manifest, null, 2);
      await fs.writeFile(manifestPath, body, "utf8");
      job.artifacts.visualManifest = {
        ...artifacts.visualManifest,
        size: Buffer.byteLength(body),
        sha256: crypto.createHash("sha256").update(body).digest("hex"),
        createdAt: now,
        imageCount: visualImages.length,
        currentImageCount: visualImages.length - stalePageIds.length
      };
    } catch {
      // The job artifact remains authoritative; a later task sync will rebuild the manifest file.
    }
  }
  job.events = appendEvent(job.events, {
    type: "codex-ppt.sample_style_reconciled",
    message: `Reconciled visual pages against approved sample ${sampleSha256}`,
    details: { sampleSha256, stalePageIds, currentPages: visualImages.length - stalePageIds.length },
    createdAt: now
  });
}

export async function preflightCodexPptGate(jobId, options = {}) {
  const gate = normalizeGate(options.gate);
  const job = await readWorkflowJob(jobId);
  const passed = gate === "fullDeck"
    ? isCodexPptFullDeckApprovalCurrent(job, options)
    : gate === "sample"
      ? isCodexPptSampleApprovalCurrent(job, options)
      : getApprovals(job).some((item) => item?.status === "approved" && item.gate === gate);
  if (passed) {
    return {
      ok: true,
      gate,
      label: CODEX_PPT_GATES.get(gate),
      ready: false,
      passed: true,
      blockers: []
    };
  }
  try {
    assertApprovalPreconditions(job, gate, options);
    return {
      ok: true,
      gate,
      label: CODEX_PPT_GATES.get(gate),
      ready: true,
      passed: false,
      blockers: []
    };
  } catch (error) {
    return {
      ok: true,
      gate,
      label: CODEX_PPT_GATES.get(gate),
      ready: false,
      passed: false,
      code: error.code || "CODEX_PPT_APPROVAL_NOT_READY",
      error: error.message || "codex-ppt approval is not ready",
      blockers: [error.message || "codex-ppt approval is not ready"].filter(Boolean),
      missing: error.missing || [],
      requiredArtifact: error.requiredArtifact || "",
      backend: error.backend || null,
      style: error.style || null,
      sample: error.sample || null
    };
  }
}

export async function resetCodexPptGate(jobId, options = {}) {
  const gate = options.gate === "all" ? "all" : normalizeGate(options.gate);
  const job = await readWorkflowJob(jobId);
  const now = new Date().toISOString();
  const approvals = gate === "all" ? [] : getApprovals(job).filter((item) => item.gate !== gate);
  job.artifacts = {
    ...(job.artifacts || {}),
    codexPptApprovals: approvals
  };
  if (gate === "all" || gate === "backend") delete job.artifacts.codexPptBackend;
  job.events = appendEvent(job.events, {
    type: "codex-ppt.approval.reset",
    message: gate === "all" ? "Reset all codex-ppt approvals" : `Reset ${CODEX_PPT_GATES.get(gate)}`,
    details: { gate },
    createdAt: now
  });
  return saveWorkflowJob(job);
}

export async function assertCodexPptApprovals(jobId, requiredGates = []) {
  const job = await readWorkflowJob(jobId);
  const required = requiredGates.map(normalizeGate);
  const approved = new Set(getApprovals(job)
    .filter((item) => item?.status === "approved" && item.gate)
    .map((item) => item.gate));
  if (required.includes("fullDeck") && !isCodexPptFullDeckApprovalCurrent(job)) {
    approved.delete("fullDeck");
  }
  if (required.includes("sample") && !isCodexPptSampleApprovalCurrent(job)) {
    approved.delete("sample");
  }
  const missing = required.filter((gate) => !approved.has(gate));
  if (missing.length) {
    const error = new Error(`Missing codex-ppt approval gate(s): ${missing.map((gate) => CODEX_PPT_GATES.get(gate)).join(", ")}`);
    error.code = "CODEX_PPT_APPROVAL_REQUIRED";
    error.missing = missing.map((gate) => ({ gate, label: CODEX_PPT_GATES.get(gate) }));
    error.required = required.map((gate) => ({ gate, label: CODEX_PPT_GATES.get(gate) }));
    throw error;
  }
  return job;
}

function buildBackendSnapshot(input = {}) {
  const configured = getProviderConfig().image || {};
  return {
    kind: "codex_ppt_backend",
    status: "approved",
    provider: cleanString(input.provider || configured.baseUrl || "configured-provider"),
    baseUrl: cleanString(input.baseUrl || configured.baseUrl || ""),
    model: cleanString(input.model || configured.model || ""),
    enabled: Boolean(configured.enabled),
    configured: Boolean(configured.configured),
    approvedAt: new Date().toISOString()
  };
}

function assertApprovalPreconditions(job = {}, gate = "", options = {}) {
  const approvals = new Set(getApprovals(job)
    .filter((item) => item?.status === "approved" && item.gate)
    .map((item) => item.gate));
  if (!isCodexPptSampleApprovalCurrent(job, options)) approvals.delete("sample");
  if (gate === "outline" && !job.artifacts?.codexPptOutline?.path) {
    throwApprovalPrecondition(
      "CODEX_PPT_OUTLINE_REQUIRED",
      "Record a codex-ppt outline artifact before approving the outline gate.",
      { gate, requiredArtifact: "codexPptOutline" }
    );
  }
  if (gate === "style" && !job.artifacts?.codexPptStyle?.path) {
    throwApprovalPrecondition(
      "CODEX_PPT_STYLE_REQUIRED",
      "Record a codex-ppt style artifact before approving the style gate.",
      { gate, requiredArtifact: "codexPptStyle" }
    );
  }
  if (gate === "style" && findLegacyStyleEvidence(job.artifacts?.codexPptStyle) && !isNonProductApprovalAllowed(options)) {
    throwApprovalPrecondition(
      "CODEX_PPT_STYLE_LEGACY_TEMPLATE",
      "Refresh codex-ppt style evidence before approving the style gate. Legacy template style evidence is not accepted in the product workflow.",
      {
        gate,
        style: publicStyleSnapshot(job.artifacts.codexPptStyle),
        legacyStyle: findLegacyStyleEvidence(job.artifacts.codexPptStyle)
      }
    );
  }
  if (gate === "backend") {
    if (!job.artifacts?.codexPptBackendDecision?.path) {
      throwApprovalPrecondition(
        "CODEX_PPT_BACKEND_DECISION_REQUIRED",
        "Record a codex-ppt backend decision artifact before approving the backend gate.",
        { gate, requiredArtifact: "codexPptBackendDecision" }
      );
    }
    const backend = buildBackendSnapshot(options.backend);
    if (!isNonProductApprovalAllowed(options) && (!backend.enabled || !backend.configured || isPassthroughBackend(backend))) {
      throwApprovalPrecondition(
        "CODEX_PPT_BACKEND_NOT_READY",
        "A configured, non-passthrough image backend is required before approving codex-ppt backend.",
        { gate, backend: publicBackendSnapshot(backend) }
      );
    }
  }
  if (gate === "sample") {
    const missing = ["outline", "style", "backend"].filter((item) => !approvals.has(item));
    if (missing.length) {
      throwApprovalPrecondition(
        "CODEX_PPT_APPROVAL_REQUIRED",
        `Sample approval requires prior approvals: ${missing.join(", ")}.`,
        { gate, missing }
      );
    }
    if (!job.artifacts?.visualSample?.path) {
      throwApprovalPrecondition(
        "CODEX_PPT_SAMPLE_REQUIRED",
        "Generate one visual sample artifact before approving the codex-ppt sample gate.",
        { gate, requiredArtifact: "visualSample" }
      );
    }
    assertProductVisualSample(job, gate, options);
  }
  if (gate === "fullDeck") {
    const missing = ["outline", "style", "backend", "sample"].filter((item) => !approvals.has(item));
    if (missing.length) {
      throwApprovalPrecondition(
        "CODEX_PPT_APPROVAL_REQUIRED",
        `Full-deck authorization requires prior approvals: ${missing.join(", ")}.`,
        { gate, missing }
      );
    }
    if (!job.artifacts?.visualSample?.path) {
      throwApprovalPrecondition(
        "CODEX_PPT_SAMPLE_REQUIRED",
        "Full-deck authorization requires an approved visual sample artifact.",
        { gate, requiredArtifact: "visualSample" }
      );
    }
    assertProductVisualSample(job, gate, options);
    if (!isNonProductApprovalAllowed(options)) buildFullDeckTestEvidence(job);
  }
}

export function isCodexPptFullDeckApprovalCurrent(job = {}, options = {}) {
  const record = getApprovals(job)
    .filter((item) => item?.status === "approved" && item.gate === "fullDeck")
    .at(-1);
  if (!record) return false;
  if (isNonProductApprovalAllowed(options)) return true;
  const evidence = record.testDeck || {};
  const sample = job.artifacts?.visualSample || {};
  const currentImages = new Map(getVisualImages(job).map((image) => [visualPageId(image), image]));
  return Boolean(
    evidence.version === 1
    && evidence.sampleSha256
    && evidence.sampleSha256 === sample.sha256
    && Array.isArray(evidence.pages)
    && evidence.pages.length === 2
    && evidence.pages.every((page) => {
      const current = currentImages.get(page.pageId);
      return Boolean(current?.sha256 && page.sha256 && current.sha256 === page.sha256);
    })
  );
}

export function isCodexPptSampleApprovalCurrent(job = {}, options = {}) {
  const record = getApprovals(job)
    .filter((item) => item?.status === "approved" && item.gate === "sample")
    .at(-1);
  if (!record) return false;
  if (isNonProductApprovalAllowed(options)) return true;
  const sample = job.artifacts?.visualSample || {};
  const sampleSha256 = cleanString(sample.sha256 || "");
  const diskSha256 = hashCurrentSampleFile(sample.path || "");
  return Boolean(
    sampleSha256
    && diskSha256
    && diskSha256 === sampleSha256
    && record.sampleSha256
    && record.sampleSha256 === sampleSha256
  );
}

function hashCurrentSampleFile(filePath = "") {
  const resolved = path.resolve(cleanString(filePath));
  if (!filePath || !fsSync.existsSync(resolved) || !fsSync.statSync(resolved).isFile()) return "";
  const stat = fsSync.statSync(resolved);
  const cacheKey = `${resolved}:${stat.size}:${stat.mtimeMs}`;
  if (SAMPLE_HASH_CACHE.has(cacheKey)) return SAMPLE_HASH_CACHE.get(cacheKey);
  const sha256 = crypto.createHash("sha256").update(fsSync.readFileSync(resolved)).digest("hex");
  SAMPLE_HASH_CACHE.clear();
  SAMPLE_HASH_CACHE.set(cacheKey, sha256);
  return sha256;
}

export function getCodexPptFullDeckTestEvidence(job = {}) {
  const record = getApprovals(job)
    .filter((item) => item?.status === "approved" && item.gate === "fullDeck")
    .at(-1);
  return isCodexPptFullDeckApprovalCurrent(job) ? record?.testDeck || null : null;
}

export function buildFullDeckTestEvidence(job = {}) {
  const images = getVisualImages(job);
  const review = job.artifacts?.imageDeckReview || {};
  const summary = review.summary || {};
  const marks = review.marks || {};
  const sample = job.artifacts?.visualSample || {};
  const pages = images.map((image) => ({
    pageId: visualPageId(image),
    pageNumber: Number(image.pageNumber || 0),
    sha256: cleanString(image.sha256 || ""),
    path: cleanString(image.relativePath || image.path || ""),
    imageInputMode: cleanString(image.imageInputMode || ""),
    styleAuthority: Boolean(
      image.retainedApprovedSample === true
      && sample.sha256
      && cleanString(image.sha256 || "") === cleanString(sample.sha256)
    )
  }));
  const everyPagePassed = pages.length === 2 && pages.every((page) => {
    const mark = marks[page.pageId] || {};
    return Boolean(
      page.pageId
      && page.sha256
      && mark.status === "pass"
      && mark.visualImageSha256 === page.sha256
    );
  });
  const styleReferenceModes = new Set(["source-page-edit-plus-style-reference", "approved-sample-edit"]);
  const usesStyleReference = pages.length === 2
    && pages.every((page) => page.styleAuthority || styleReferenceModes.has(page.imageInputMode))
    && pages.some((page) => page.styleAuthority)
    && pages.some((page) => styleReferenceModes.has(page.imageInputMode));
  if (
    !sample.sha256
    || review.status !== "approved"
    || summary.totalPages !== 2
    || summary.passCount !== 2
    || summary.acceptCount !== 0
    || summary.allPagesReviewed !== true
    || summary.allMarksCurrent !== true
    || summary.readyForApproval !== true
    || !everyPagePassed
    || !usesStyleReference
  ) {
    throwApprovalPrecondition(
      "CODEX_PPT_TWO_PAGE_TEST_REQUIRED",
      "Full-deck authorization requires exactly two current style-locked test pages, both marked pass in image deck review.",
      {
        gate: "fullDeck",
        requiredArtifact: "imageDeckReview",
        testDeck: {
          pageCount: pages.length,
          reviewStatus: review.status || "",
          passCount: Number(summary.passCount || 0),
          styleAuthorityPages: pages.filter((page) => page.styleAuthority).length,
          styleReferencePages: pages.filter((page) => styleReferenceModes.has(page.imageInputMode)).length
        }
      }
    );
  }
  return {
    version: 1,
    sampleSha256: sample.sha256,
    pages,
    reviewApprovedAt: review.approvedAt || "",
    recordedAt: new Date().toISOString()
  };
}

function getVisualImages(job = {}) {
  return (Array.isArray(job.artifacts?.visualImages) ? job.artifacts.visualImages : [])
    .filter((image) => image?.path)
    .sort((a, b) => Number(a.pageNumber || 0) - Number(b.pageNumber || 0));
}

function visualPageId(image = {}) {
  const pageNumber = Number(image.pageNumber || 0);
  return cleanString(image.pageId || (pageNumber ? `page_${String(pageNumber).padStart(3, "0")}` : ""));
}

function assertProductVisualSample(job = {}, gate = "", options = {}) {
  const sample = job.artifacts?.visualSample || {};
  if (isNonProductApprovalAllowed(options)) return;
  if (isNonProductVisualSample(sample)) {
    throwApprovalPrecondition(
      "CODEX_PPT_SAMPLE_NON_PRODUCT",
      "Generate a product visual sample with the approved image backend before approving this codex-ppt gate.",
      {
        gate,
        sample: publicVisualSampleSnapshot(sample)
      }
    );
  }
  const backend = getApprovedImageBackend(job);
  if (!sampleMatchesBackend(sample, backend)) {
    throwApprovalPrecondition(
      "CODEX_PPT_SAMPLE_BACKEND_MISMATCH",
      "Regenerate the visual sample with the currently approved image backend before approving this codex-ppt gate.",
      {
        gate,
        sample: publicVisualSampleSnapshot(sample),
        backend: publicBackendSnapshot(backend)
      }
    );
  }
}

function throwApprovalPrecondition(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function isNonProductApprovalAllowed(options = {}) {
  return options.allowNonProductBackend === true;
}

function getApprovedImageBackend(job = {}) {
  const backendApproval = getApprovals(job)
    .filter((item) => item?.status === "approved" && item.gate === "backend" && item.backend)
    .at(-1)?.backend;
  const configured = getProviderConfig().image || {};
  return {
    provider: backendApproval?.provider || job.artifacts?.codexPptBackend?.provider || job.artifacts?.codexPptBackendDecision?.provider || configured.provider || "",
    baseUrl: backendApproval?.baseUrl || job.artifacts?.codexPptBackend?.baseUrl || job.artifacts?.codexPptBackendDecision?.baseUrl || configured.baseUrl || "",
    model: backendApproval?.model || job.artifacts?.codexPptBackend?.model || job.artifacts?.codexPptBackendDecision?.model || configured.model || "",
    enabled: backendApproval?.enabled ?? configured.enabled,
    configured: backendApproval?.configured ?? configured.configured
  };
}

function sampleMatchesBackend(sample = {}, backend = {}) {
  const sampleModel = cleanString(sample.model || "");
  const backendModel = cleanString(backend.model || "");
  const sampleBaseUrl = normalizeEndpoint(sample.baseUrl || "");
  const backendBaseUrl = normalizeEndpoint(backend.baseUrl || "");
  if (!sampleModel || !backendModel || sampleModel !== backendModel) return false;
  if (!sampleBaseUrl || !backendBaseUrl || sampleBaseUrl !== backendBaseUrl) return false;
  return true;
}

function normalizeEndpoint(value = "") {
  if (!String(value || "").trim()) return "";
  return normalizeBaseUrl(value).replace(/\/v\d+$/, "");
}

function isPassthroughBackend(record = {}) {
  const text = `${record.provider || ""} ${record.baseUrl || ""} ${record.model || ""}`;
  return /passthrough|dry-run|dryrun|regression/i.test(text);
}

function isNonProductVisualSample(record = {}) {
  const text = `${record.source || ""} ${record.provider || ""} ${record.model || ""}`;
  return Boolean(record.dryRun || record.passthrough) || /passthrough|dry-run|dryrun|regression|source-page-passthrough/i.test(text);
}

function publicBackendSnapshot(record = {}) {
  return {
    provider: record.provider || "",
    baseUrl: record.baseUrl || "",
    model: record.model || "",
    enabled: Boolean(record.enabled),
    configured: Boolean(record.configured)
  };
}

function publicVisualSampleSnapshot(record = {}) {
  return {
    provider: record.provider || "",
    baseUrl: record.baseUrl || "",
    model: record.model || "",
    source: record.source || "",
    dryRun: Boolean(record.dryRun),
    pageNumber: record.pageNumber || null
  };
}

export function findLegacyStyleEvidence(record = {}) {
  const text = [
    record.styleBrief,
    record.title,
    record.source,
    record.provider,
    record.model,
    record.path,
    record.relativePath,
    record.markdownPath,
    record.markdownRelativePath
  ].filter(Boolean).join(" ");
  return text.match(LEGACY_CODEX_PPT_STYLE_RE)?.[0] || "";
}

function publicStyleSnapshot(record = {}) {
  return {
    title: record.title || "",
    styleBrief: record.styleBrief || "",
    source: record.source || "",
    path: record.relativePath || record.path || ""
  };
}

function getApprovals(job = {}) {
  return Array.isArray(job.artifacts?.codexPptApprovals) ? job.artifacts.codexPptApprovals : [];
}

function normalizeGate(value = "") {
  const raw = String(value || "").trim();
  const aliases = {
    full_deck: "fullDeck",
    fullDeck: "fullDeck",
    full: "fullDeck",
    generate: "fullDeck"
  };
  const gate = aliases[raw] || raw;
  if (!CODEX_PPT_GATES.has(gate)) throw new Error(`Invalid codex-ppt approval gate: ${raw}`);
  return gate;
}

function appendEvent(events = [], event) {
  return [...(Array.isArray(events) ? events : []), {
    id: `evt_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    ...event
  }].slice(-500);
}

function cleanString(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}
