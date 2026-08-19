import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";
import { getDesignSystem, getTemplatePack, getTemplatePackPrompt } from "./designSystem.js";
import { buildMaterialBrief } from "./materialBrief.js";
import { routeDeck } from "./deckRouter.js";
import { validateDeck } from "./validateDeck.js";
import { applySceneGraphOverrides, applySceneGraphRepairPlan, buildSceneGraph, buildSceneGraphRepairRecord, buildVisualTarget, compareRenderedPreviewToVisualTarget, compareVisualTarget, validateSceneGraph } from "./sceneGraph.js";
import { buildDeck } from "./ppt.js";
import { inspectEditablePptx } from "./pptxEditability.js";
import { getCloudImageConfig } from "./cloudImage.js";
import { buildAssetManifest, validateAssetManifest } from "./assetManifest.js";
import { ensureVisualProjectForJob, generateVisualProjectSlides, writeEditableSceneGraphArtifacts } from "./visualProject.js";
import { buildFinalExportGate, buildHybridQa } from "./hybridQa.js";
import { cutoutImage } from "./matting.js";
import { buildFullDeckTestEvidence, findLegacyStyleEvidence, isCodexPptFullDeckApprovalCurrent, isCodexPptSampleApprovalCurrent, reconcileVisualArtifactsForApprovedSample } from "./workflowApprovals.js";
import { cleanPublicError } from "./workflowWorkerBatchRunner.js";
import { assertEditableDispatchAllowed, inspectEditablePageVisualFidelity, isImageDeckReviewApproved, restoreRecordedEditablePages } from "./workflowEditable.js";
import { assertVisualQualityAllowsReview, assertWorkflowImageDeckReviewReady } from "./workflowImageDeckReview.js";
import { isPageResultEvidenceComplete } from "./workflowPageEvidence.js";
import { isFinalPptxProductReady } from "./workflowArtifacts.js";
import { collectMissingForegroundAssets, comparePngVisualFidelity, evaluateEditableVisualFidelity, isBlockingEditableVisualIssue } from "./workflowFinalEvidence.js";
import { buildPartialFinalCoverage, isContinuationBatchSuccess } from "./workflowContinuation.js";
import { deriveWorkflowDeliveryStatus } from "../shared/workflowDeliveryStatus.js";
import { isInternalWorkflowJob } from "../shared/workflowVisibility.js";
import { buildFinalDeliveryGate } from "./workflowDelivery.js";
import { withWorkflowJobLock, workflowJobLockCount } from "./workflowJobLock.js";
import { assertWorkflowVisualGenerationAllowed, buildBriefSourcePrompt, buildDeckStyleConsistencyReport, buildVisualImageRecord, buildVisualPromptsPayload, isVisualSourceImage, mergeOutlineMetadata, resolveRetainedVisualContinuityReference, retainUnchangedImageDeckReviewMarks } from "./workflowVisuals.js";
import { applyWorkflowOcrResultToJob, extractPptxNativeTextByPage, extractSourceTextLines, getOcrInputImages, getWorkflowOcrCoverage, isSourceTextInput, mergeOcrPageEvidence, mergeWorkflowOcrTextHints, shouldSyncOcrHintsToEditableRun } from "./workflowOcr.js";
import { buildProviderConnectionError, getProviderConfig, readProviderError } from "./providers.js";
import { isBatchInfrastructureError, resolveAppliedSampleSha256, resolveCodexStyleReferenceImages, runSequentialSlideTasks, sanitizeBatchError } from "./workflowCodexPptSlideBatchRunner.js";
import { inspectRecentProviderFailure } from "./workflowWorkerBatchRunner.js";
import { prepareCodexPptSlideRun } from "./workflowCodexPptRunState.js";
import { invalidateStaleImageDeck, mergeTasks as mergeCodexPptSlideTasks } from "./workflowCodexPptWorkerQueue.js";
import { buildPendingVisualTestGuidance, buildVisualGenerationScope, getPendingVisualPageNumbers } from "./workflowNextAction.js";
import { getExternalImageAuthorizationStatus } from "./workflowAuthorizations.js";
import { buildSkillFirstOutlineDraft } from "./workflowOutline.js";
import {
  buildDeckStyleSpec,
  buildDeckDesignContract,
  classifyDeckText,
  formatDeckStyleSpecPrompt,
  inferDeckPageRole,
  inferPageNumberPolicyFromOcrHints,
  resolveVisualSampleSelection,
  selectRepresentativeSamplePage
} from "./workflowDeckDesignSystem.js";
import { buildVisualTextQualityReport, reconcileImageDeckReviewEvidence, writeWorkflowVisualTextQualityReport } from "./workflowVisualTextQa.js";

const EASTERN = "\u4e1c\u65b9\u81ea\u7136\u98ce";
const TECH = "\u84dd\u767d\u79d1\u6280\u98ce";
const SYSTEM_RECOMMEND = "\u7cfb\u7edf\u63a8\u8350";

const providerConnectionError = buildProviderConnectionError(
  Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }),
  "https://ai.example.test/v1/images/edits"
);
assert.equal(providerConnectionError.code, "PROVIDER_CONNECTION_FAILED");
assert.match(providerConnectionError.message, /ai\.example\.test/);
assert.match(providerConnectionError.message, /ECONNRESET/);
assert.equal(isBatchInfrastructureError(providerConnectionError), true);
assert.equal(isBatchInfrastructureError(new Error("image generation failed: HTTP 429 quota exceeded")), false);
assert.equal(isBatchInfrastructureError(new Error("image generation failed: HTTP 429 fetch failed")), false);
assert.equal(isBatchInfrastructureError(Object.assign(new Error("connect timeout"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })), true);
assert.equal(isBatchInfrastructureError(Object.assign(new Error("dns retry"), { code: "EAI_AGAIN" })), true);
assert.equal(isInternalWorkflowJob({ internal: false, input: { internal: false, mode: "smoke-e2e" } }), true);
assert.equal(isInternalWorkflowJob({ internal: false, visibility: "public", input: { mode: "smoke-e2e" } }), false);
assert.equal(isInternalWorkflowJob({ internal: false, input: { mode: "ppt-rebuild" } }), false);
assert.equal(isContinuationBatchSuccess({ run: { status: "complete" } }), true);
assert.equal(isContinuationBatchSuccess({ run: { status: "review_required" } }), true);
assert.equal(isContinuationBatchSuccess({ run: { status: "partial" } }), true);
assert.equal(isContinuationBatchSuccess({ run: { status: "failed" } }), false);
const supersededEditableFailure = inspectRecentProviderFailure({
  artifacts: {
    editableWorkerTasks: [{ pageId: "page_001", status: "recorded" }],
    editableWorkerBatchRuns: [{
      id: "failed-run",
      status: "failed",
      finishedAt: "2026-01-01T00:00:00.000Z",
      summary: { results: [{ pageId: "page_001", ok: false, error: "Model response did not contain parseable JSON" }] }
    }]
  }
});
assert.equal(supersededEditableFailure.found, false);
const unresolvedEditableFailure = inspectRecentProviderFailure({
  artifacts: {
    editableWorkerTasks: [{ pageId: "page_002", status: "ready" }],
    editableWorkerBatchRuns: [{
      id: "failed-run",
      status: "failed",
      finishedAt: "2026-01-01T00:00:00.000Z",
      summary: { results: [{ pageId: "page_002", ok: false, error: "Model response did not contain parseable JSON" }] }
    }]
  }
});
assert.equal(unresolvedEditableFailure.found, true);
assert.deepEqual(unresolvedEditableFailure.pages, ["page_002"]);
assert.equal(shouldSyncOcrHintsToEditableRun({ visualEvidenceMode: false }), true);
assert.equal(shouldSyncOcrHintsToEditableRun({ visualEvidenceMode: true }), false);
assert.equal(shouldSyncOcrHintsToEditableRun({ visualEvidenceMode: true, syncToEditableRun: true }), true);
const pendingVisualTestGuidance = buildPendingVisualTestGuidance({
  artifacts: {
    renderedPages: Array.from({ length: 20 }, (_item, index) => ({ pageNumber: index + 1 })),
    visualImages: [{ pageId: "page_006", pageNumber: 6, path: "page_006.png" }],
    codexPptApprovals: [{ gate: "sample", status: "approved" }],
    codexPptSlideJobs: { total: 2, pending: 1, recorded: 1 },
    imageDeckReview: { marks: { page_006: { status: "pass" }, page_009: { status: "rerun" } } }
  }
});
assert.equal(pendingVisualTestGuidance.action, "visual/generate");
assert.equal(pendingVisualTestGuidance.externalImageCalls, 1);
assert.match(pendingVisualTestGuidance.summary, /1\/2/);
assert.deepEqual(pendingVisualTestGuidance.testScope.rerunPageIds, ["page_009"]);
const nativeTextSmokeDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ppt-native-text-smoke-"));
try {
  const nativeTextPptx = path.join(nativeTextSmokeDir, "source.pptx");
  const nativeTextZip = new JSZip();
  nativeTextZip.file("ppt/slides/slide1.xml", '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>产品链接</a:t><a:t>https://item.jd.com/10224227783390.html</a:t><a:t>研发&amp;交付</a:t></p:sld>');
  await fsPromises.writeFile(nativeTextPptx, await nativeTextZip.generateAsync({ type: "nodebuffer" }));
  const nativeTextByPage = await extractPptxNativeTextByPage(nativeTextPptx);
  assert.deepEqual(nativeTextByPage.get(1), ["产品链接", "https://item.jd.com/10224227783390.html", "研发&交付"]);
} finally {
  await fsPromises.rm(nativeTextSmokeDir, { recursive: true, force: true });
}
const qualityOnlyRefreshGate = buildFinalDeliveryGate({
  artifacts: {
    visualImages: [{ pageId: "page_001", createdAt: "2026-01-01T00:00:00.000Z" }],
    visualQuality: { createdAt: "2026-01-03T00:00:00.000Z" },
    editableRun: { createdAt: "2026-01-02T00:00:00.000Z" }
  },
  dirs: {}
}, {}, {}, {});
assert.equal(qualityOnlyRefreshGate.visualFreshness.stale, false);
assert.equal(qualityOnlyRefreshGate.checks.fullSourceCoverage, false);

const lockOrder = [];
await Promise.all([
  withWorkflowJobLock("smoke-lock", async () => {
    lockOrder.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 15));
    lockOrder.push("first-end");
  }),
  withWorkflowJobLock("smoke-lock", async () => {
    lockOrder.push("second");
  })
]);
assert.deepEqual(lockOrder, ["first-start", "first-end", "second"]);
assert.equal(workflowJobLockCount(), 0);

const overflowCoverageGate = buildFinalDeliveryGate({
  sourceMeta: { pageCount: 20 },
  artifacts: {
    editableFinal: {
      path: "editable-final.pptx",
      summary: { page_count: 21 },
      pptxEditability: { slideCount: 21, editable: true, rasterOnlySlides: 0 }
    }
  },
  dirs: {}
}, {}, { complete: true }, { complete: true, summary: { visualQa: { automatedStatus: "pass" } } });
assert.equal(overflowCoverageGate.productReady, false);
assert.equal(overflowCoverageGate.checks.fullSourceCoverage, false);
assert.equal(overflowCoverageGate.checks.sourceCoverageOverflow, true);
assert.ok(overflowCoverageGate.reasons.some((reason) => /21\/20/.test(reason)));

const reviewedBackgroundGate = buildFinalDeliveryGate({
  sourceMeta: { pageCount: 1 },
  artifacts: {
    editableFinal: {
      path: "editable-final.pptx",
      size: 100,
      sha256: "final-sha",
      createdAt: "2026-01-01T00:00:00.000Z",
      summary: { page_count: 1 },
      pptxEditability: {
        slideCount: 1,
        editable: true,
        fullSlidePictures: 1,
        rasterOnlySlides: 0,
        rasterBackgroundSlides: 1,
        warnings: ["full-slide-background-picture:1"]
      }
    },
    manualReview: {
      status: "approved",
      finalPath: "editable-final.pptx",
      finalSize: 100,
      finalSha256: "final-sha",
      finalCreatedAt: "2026-01-01T00:00:00.000Z"
    }
  },
  dirs: {}
}, {}, { complete: true }, { complete: true, summary: { visualQa: { automatedStatus: "pass" } } });
assert.equal(reviewedBackgroundGate.checks.manualReviewRecorded, true);
assert.ok(!reviewedBackgroundGate.warnings.some((warning) => /full-slide-background-picture|全页背景图/.test(warning)));

const untrackedFinalDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ppt-untracked-final-smoke-"));
try {
  await fsPromises.writeFile(path.join(untrackedFinalDir, "editable-final.pptx"), "stale draft", "utf8");
  const untrackedFinalGate = buildFinalDeliveryGate({
    artifacts: {},
    dirs: { final: untrackedFinalDir }
  }, {}, {}, {});
  assert.equal(untrackedFinalGate.invalidatedFinal.exists, true);
  assert.ok(untrackedFinalGate.warnings.some((warning) => /editable-final\.pptx/.test(warning)));
} finally {
  await fsPromises.rm(untrackedFinalDir, { recursive: true, force: true });
}
const editableRefreshDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ppt-editable-refresh-smoke-"));
try {
  const archivedRunDir = path.join(editableRefreshDir, "archive", "run");
  const refreshedRunDir = path.join(editableRefreshDir, "fresh", "run");
  for (const runDir of [archivedRunDir, refreshedRunDir]) {
    for (const pageId of ["page_001", "page_002", "page_003", "page_004"]) {
      await fsPromises.mkdir(path.join(runDir, "pages", pageId), { recursive: true });
    }
  }
  const pngChunk = (type, data) => {
    const body = Buffer.from(data);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type, "ascii"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const minimalPng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", Buffer.from([0x00])),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  const truncatedPng = minimalPng.subarray(0, 24);
  const minimalPptxZip = new JSZip();
  minimalPptxZip.file("[Content_Types].xml", "<Types/>");
  minimalPptxZip.file("ppt/presentation.xml", "<p:presentation xmlns:p=\"urn:test\"/>");
  minimalPptxZip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"urn:test\"/>");
  const minimalPptx = await minimalPptxZip.generateAsync({ type: "nodebuffer" });
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "marker.txt"), "preserved-page", "utf8");
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "manifest.json"), JSON.stringify({ page_id: "page_001", images: [], asset_provenance: [] }), "utf8");
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "imagegen-jobs.json"), "[]", "utf8");
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "page.pptx"), minimalPptx);
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "preview.png"), minimalPng);
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "source.png"), minimalPng);
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "split_assets_contact.png"), minimalPng);
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "validation.json"), JSON.stringify({ passed: true }), "utf8");
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "product-visual-qa.json"), JSON.stringify({ pageId: "page_001", passed: true }), "utf8");
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_001", "page_result.json"), JSON.stringify({
    page_manifest: "manifest.json",
    imagegen_jobs: "imagegen-jobs.json",
    page_pptx: "page.pptx",
    preview: "preview.png",
    contact_sheet: "split_assets_contact.png",
    validation: "validation.json",
    page_result: "page_result.json"
  }), "utf8");
  const recoveredOutputNames = {
    page_manifest: "manifest.json",
    imagegen_jobs: "imagegen-jobs.json",
    page_pptx: "page.pptx",
    preview: "preview.png",
    contact_sheet: "split_assets_contact.png",
    validation: "validation.json",
    page_result: "page_result.json"
  };
  const recoveredHashes = Object.fromEntries(await Promise.all(Object.entries(recoveredOutputNames).map(async ([key, fileName]) => [
    key,
    crypto.createHash("sha256").update(await fsPromises.readFile(path.join(archivedRunDir, "pages", "page_001", fileName))).digest("hex")
  ])));
  const corruptPageDir = path.join(archivedRunDir, "pages", "page_003");
  await fsPromises.writeFile(path.join(corruptPageDir, "manifest.json"), JSON.stringify({ page_id: "page_003", images: [], asset_provenance: [] }), "utf8");
  await fsPromises.writeFile(path.join(corruptPageDir, "imagegen-jobs.json"), "[]", "utf8");
  await fsPromises.writeFile(path.join(corruptPageDir, "page.pptx"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await fsPromises.writeFile(path.join(corruptPageDir, "preview.png"), minimalPng);
  await fsPromises.writeFile(path.join(corruptPageDir, "source.png"), minimalPng);
  await fsPromises.writeFile(path.join(corruptPageDir, "split_assets_contact.png"), minimalPng);
  await fsPromises.writeFile(path.join(corruptPageDir, "validation.json"), JSON.stringify({ passed: true }), "utf8");
  await fsPromises.writeFile(path.join(corruptPageDir, "product-visual-qa.json"), JSON.stringify({ pageId: "page_003", passed: true }), "utf8");
  await fsPromises.writeFile(path.join(corruptPageDir, "page_result.json"), JSON.stringify(recoveredOutputNames), "utf8");
  const corruptHashes = Object.fromEntries(await Promise.all(Object.entries(recoveredOutputNames).map(async ([key, fileName]) => [
    key,
    crypto.createHash("sha256").update(await fsPromises.readFile(path.join(corruptPageDir, fileName))).digest("hex")
  ])));
  const corruptPngPageDir = path.join(archivedRunDir, "pages", "page_004");
  await fsPromises.writeFile(path.join(corruptPngPageDir, "manifest.json"), JSON.stringify({ page_id: "page_004", images: [], asset_provenance: [] }), "utf8");
  await fsPromises.writeFile(path.join(corruptPngPageDir, "imagegen-jobs.json"), "[]", "utf8");
  await fsPromises.writeFile(path.join(corruptPngPageDir, "page.pptx"), minimalPptx);
  await fsPromises.writeFile(path.join(corruptPngPageDir, "preview.png"), truncatedPng);
  await fsPromises.writeFile(path.join(corruptPngPageDir, "source.png"), minimalPng);
  await fsPromises.writeFile(path.join(corruptPngPageDir, "split_assets_contact.png"), minimalPng);
  await fsPromises.writeFile(path.join(corruptPngPageDir, "validation.json"), JSON.stringify({ passed: true }), "utf8");
  await fsPromises.writeFile(path.join(corruptPngPageDir, "product-visual-qa.json"), JSON.stringify({ pageId: "page_004", passed: true }), "utf8");
  await fsPromises.writeFile(path.join(corruptPngPageDir, "page_result.json"), JSON.stringify(recoveredOutputNames), "utf8");
  const corruptPngHashes = Object.fromEntries(await Promise.all(Object.entries(recoveredOutputNames).map(async ([key, fileName]) => [
    key,
    crypto.createHash("sha256").update(await fsPromises.readFile(path.join(corruptPngPageDir, fileName))).digest("hex")
  ])));
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_002", "marker.txt"), "stale-page", "utf8");
  await fsPromises.writeFile(path.join(archivedRunDir, "pages", "page_003", "marker.txt"), "incomplete-recorded-page", "utf8");
  await fsPromises.writeFile(path.join(refreshedRunDir, "pages", "page_001", "marker.txt"), "fresh-pending", "utf8");
  await fsPromises.writeFile(path.join(refreshedRunDir, "pages", "page_001", "source.png"), minimalPng);
  await fsPromises.writeFile(path.join(refreshedRunDir, "pages", "page_002", "marker.txt"), "fresh-regenerated", "utf8");
  await fsPromises.writeFile(path.join(refreshedRunDir, "pages", "page_003", "marker.txt"), "fresh-incomplete", "utf8");
  await fsPromises.writeFile(path.join(refreshedRunDir, "pages", "page_003", "source.png"), minimalPng);
  await fsPromises.writeFile(path.join(refreshedRunDir, "pages", "page_004", "marker.txt"), "fresh-corrupt-png", "utf8");
  await fsPromises.writeFile(path.join(refreshedRunDir, "pages", "page_004", "source.png"), minimalPng);
  await fsPromises.writeFile(path.join(archivedRunDir, "page_jobs.json"), JSON.stringify({
    pages: [
      { page_id: "page_001", status: "recorded", result: { outputs: { page_pptx: "pages/page_001/page.pptx" }, hashes: recoveredHashes } },
      { page_id: "page_002", status: "recorded", result: { outputs: { page_pptx: "pages/page_002/page.pptx" } } },
      { page_id: "page_003", status: "recorded", result: { outputs: { page_pptx: "pages/page_003/page.pptx" }, hashes: corruptHashes } },
      { page_id: "page_004", status: "recorded", result: { outputs: { page_pptx: "pages/page_004/page.pptx" }, hashes: corruptPngHashes } }
    ]
  }), "utf8");
  await fsPromises.writeFile(path.join(refreshedRunDir, "page_jobs.json"), JSON.stringify({
    pages: [
      { page_id: "page_001", status: "pending", result: null },
      { page_id: "page_002", status: "pending", result: null },
      { page_id: "page_003", status: "pending", result: null },
      { page_id: "page_004", status: "pending", result: null }
    ]
  }), "utf8");
  const preservedPageIds = await restoreRecordedEditablePages(
    { runDir: archivedRunDir },
    { runDir: refreshedRunDir },
    ["page_002"]
  );
  assert.deepEqual(preservedPageIds, ["page_001"]);
  assert.equal(await fsPromises.readFile(path.join(refreshedRunDir, "pages", "page_001", "marker.txt"), "utf8"), "preserved-page");
  assert.equal(await fsPromises.readFile(path.join(refreshedRunDir, "pages", "page_002", "marker.txt"), "utf8"), "fresh-regenerated");
  assert.equal(await fsPromises.readFile(path.join(refreshedRunDir, "pages", "page_003", "marker.txt"), "utf8"), "fresh-incomplete");
  assert.equal(await fsPromises.readFile(path.join(refreshedRunDir, "pages", "page_004", "marker.txt"), "utf8"), "fresh-corrupt-png");
  const refreshedJobs = JSON.parse(await fsPromises.readFile(path.join(refreshedRunDir, "page_jobs.json"), "utf8"));
  assert.equal(refreshedJobs.pages[0].status, "recorded");
  assert.equal(refreshedJobs.pages[1].status, "pending");
  assert.equal(refreshedJobs.pages[2].status, "pending");
  assert.equal(refreshedJobs.pages[3].status, "pending");
} finally {
  await fsPromises.rm(editableRefreshDir, { recursive: true, force: true });
}
const sourceOutlineWithoutClosing = buildSkillFirstOutlineDraft({
  input: { pageCount: "3" },
  materialBrief: {
    sourceReport: {
      hasOldDeck: true,
      pageCount: 3,
      pages: [
        { page: 1, title: "项目封面" },
        { page: 2, title: "方案说明", textPreview: "核心方案和执行步骤" },
        { page: 3, title: "报价汇总", textPreview: "产品清单 价格 数量 总价" }
      ]
    }
  }
});
assert.equal(sourceOutlineWithoutClosing.layoutSequence[2].layout, "table");
assert.equal(sourceOutlineWithoutClosing.structureAudit.hasClosing, false);
assert.equal(sourceOutlineWithoutClosing.structureAudit.closingAction, "recommend-only");
const sourceOutlineWithBadEdgeLabels = buildSkillFirstOutlineDraft({
  input: { pageCount: "3" },
  materialBrief: {
    sourceReport: {
      hasOldDeck: true,
      pageCount: 3,
      pages: [
        { page: 1, layout: "cover", title: "项目封面" },
        { page: 2, layout: "cover", title: "产品方案", textPreview: "产品卖点与使用场景" },
        { page: 3, layout: "closing", title: "报价汇总", textPreview: "产品清单 价格 数量 总价" }
      ]
    }
  }
});
assert.equal(sourceOutlineWithBadEdgeLabels.layoutSequence[0].layout, "cover");
assert.notEqual(sourceOutlineWithBadEdgeLabels.layoutSequence[1].layout, "cover");
assert.equal(sourceOutlineWithBadEdgeLabels.layoutSequence[2].layout, "table");
assert.equal(inferDeckPageRole({ pageNumber: 5, title: "谢谢观看" }, { totalPages: 5 }), "closing");
assert.equal(selectRepresentativeSamplePage([
  { pageNumber: 1, title: "封面" },
  { pageNumber: 2, title: "核心方案", textPreview: "这是一个有实际内容和证据的代表性正文页面", textChars: 60 },
  { pageNumber: 3, title: "谢谢" }
]).pageNumber, 2);
const protectedSampleSelection = resolveVisualSampleSelection([
  { pageNumber: 1, title: "封面" },
  { pageNumber: 2, title: "核心方案", textPreview: "这是一个有实际内容和证据的代表性正文页面", textChars: 60 },
  { pageNumber: 3, title: "谢谢" }
], { pageNumber: 1 });
assert.equal(protectedSampleSelection.pageNumber, 1);
assert.equal(protectedSampleSelection.mode, "explicit-page-blocked");
assert.equal(protectedSampleSelection.blocked, true);
assert.equal(protectedSampleSelection.recommendedPageNumber, 2);
assert.equal(resolveVisualSampleSelection([
  { pageNumber: 1, title: "封面" },
  { pageNumber: 2, title: "核心方案", textPreview: "这是一个有实际内容和证据的代表性正文页面", textChars: 60 },
  { pageNumber: 3, title: "谢谢" }
], { pageNumber: 1, allowCoverSample: true }).pageNumber, 1);
const missingSampleSelection = resolveVisualSampleSelection([
  { pageNumber: 1, title: "封面" },
  { pageNumber: 2, title: "核心方案", textChars: 60 }
], { pageNumber: 99 });
assert.equal(missingSampleSelection.blocked, true);
assert.equal(missingSampleSelection.mode, "explicit-page-not-found");
assert.equal(missingSampleSelection.blockerCode, "CODEX_PPT_SAMPLE_PAGE_NOT_FOUND");
assert.equal(missingSampleSelection.recommendedPageNumber, 2);
const structuredStyleSpec = buildDeckStyleSpec({
  styleBrief: "温暖但克制的中秋员工关怀提案",
  audience: "企业员工",
  tone: "温暖、清晰"
});
assert.equal(structuredStyleSpec.kind, "codex_ppt_style_spec");
assert.equal(structuredStyleSpec.typography.familyMode, "single-sans");
assert.ok(structuredStyleSpec.typography.roles.table.titlePt.length === 2);
assert.deepEqual(buildDeckStyleSpec({ styleSpec: { master: { outerMarginPercent: "bad" } } }).master.outerMarginPercent, [5, 7]);
assert.deepEqual(buildDeckStyleSpec({ styleSpec: { master: { outerMarginPercent: [12, 4] } } }).master.outerMarginPercent, [4, 12]);
assert.match(formatDeckStyleSpecPrompt(structuredStyleSpec), /STYLE SYSTEM SUMMARY/);
assert.match(formatDeckStyleSpecPrompt(structuredStyleSpec), /MASTER SYSTEM/);
const autoPageNumberPolicy = inferPageNumberPolicyFromOcrHints({
  pages: [
    { ocrLines: [] },
    { ocrLines: [{ text: "02 / 04" }] },
    { ocrLines: [{ text: "03 / 04" }] },
    { ocrLines: [{ text: "04 / 04" }] }
  ]
});
assert.equal(autoPageNumberPolicy, "normalize");
assert.equal(inferDeckPageRole({
  pageNumber: 20,
  title: "Closing",
  ocrText: ["Category", "Product content", "Parameter", "Quantity", "Price", "Total", "15000", "626.80"]
}, { totalPages: 20 }), "table");
assert.equal(inferDeckPageRole({ pageNumber: 1, title: "Employee care plan" }, { totalPages: 20 }), "cover");
assert.equal(inferDeckPageRole({ pageNumber: 1, layout: "cover", tableCount: 1, title: "Pricing overview" }, { totalPages: 20 }), "cover");
assert.equal(inferDeckPageRole({ pageNumber: 20, layout: "closing", tableCount: 1, title: "Thank you" }, { totalPages: 20 }), "closing");
assert.equal(inferDeckPageRole({ pageNumber: 20, layout: "closing", tableCount: 1, title: "Quotation" }, { totalPages: 20, preferExplicitRole: false }), "table");
assert.equal(inferDeckPageRole({ pageNumber: 2, title: "Closing the gap in service quality" }, { totalPages: 20 }), "content");
assert.equal(inferDeckPageRole({ pageNumber: 2, title: "Closing-the-gap" }, { totalPages: 20 }), "content");
assert.equal(inferDeckPageRole({ pageNumber: 2, title: "Closing | Revenue" }, { totalPages: 20 }), "content");
assert.equal(inferDeckPageRole({ pageNumber: 20, title: "Thank You!" }, { totalPages: 20 }), "closing");
assert.equal(inferDeckPageRole({ pageNumber: 20, title: "Questions?" }, { totalPages: 20 }), "closing");
assert.equal(inferDeckPageRole({ pageNumber: 20, title: "The End." }, { totalPages: 20 }), "closing");
assert.equal(inferDeckPageRole({ pageNumber: 8, title: "Thank You!" }, { totalPages: 20 }), "content");
assert.equal(inferDeckPageRole({ pageNumber: 20, title: "\u95ee\u7b54\u73af\u8282" }, { totalPages: 20 }), "closing");
assert.equal(inferDeckPageRole({ pageNumber: 20, title: "\u9879\u76ee\u7b54\u7591" }, { totalPages: 20 }), "closing");
assert.equal(inferDeckPageRole({ pageNumber: 20, ocrText: ["Thank you", "contact@example.com"] }, { totalPages: 20 }), "closing");
const semanticTextQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "报价汇总" }, { text: "总价 100 元" }] }]
  },
  visualHints: {
    pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "visual-sha", ocrLines: [{ text: "Closing" }, { text: "YOUR BRAND" }, { text: "01 / 02" }] }]
  },
  outline: { layoutSequence: [{ layout: "closing", title: "Closing" }] },
  contract: buildDeckDesignContract({ pageNumberPolicy: "normalize" })
});
assert.equal(semanticTextQa.status, "fail");
assert.ok(semanticTextQa.pages[0].blockingReasons.includes("placeholder-text-detected"));
assert.ok(semanticTextQa.pages[0].blockingReasons.includes("page-number-value-mismatch"));
assert.ok(semanticTextQa.pages[0].blockingReasons.includes("synthetic-closing-on-content-page"));
assert.ok(semanticTextQa.pages[0].evidenceSha256);
const sourceTitleMismatchQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{
      pageId: "page_002",
      pageNumber: 2,
      ocrLines: [
        { text: "\u4eba\u5148\u81f4\u8fdc\uff0c\u6708\u6ee1\u6c47\u5ddd", confidence: 0.99, box_px: [80, 70, 620, 70], font_pt_if_cjk: 42 },
        { text: "\u573a\u666f\u3001\u7cbe\u5ea6\u3001\u613f\u529b", confidence: 0.99, box_px: [80, 260, 420, 34], font_pt_if_cjk: 20 }
      ]
    }]
  },
  visualHints: {
    pages: [{
      pageId: "page_002",
      pageNumber: 2,
      imageSha256: "source-title-mismatch",
      ocrLines: [
        { text: "\u573a\u666f\u3001\u7cbe\u5ea6\u3001\u613f\u529b", confidence: 0.99, box_px: [80, 70, 620, 70], font_pt_if_cjk: 42 },
        { text: "\u4eba\u5148\u81f4\u8fdc\uff0c\u6708\u6ee1\u6c47\u5ddd", confidence: 0.99, box_px: [80, 260, 620, 34], font_pt_if_cjk: 20 }
      ]
    }]
  },
  expectedPageIds: ["page_002"]
});
assert.ok(sourceTitleMismatchQa.pages[0].blockingReasons.includes("source-title-mismatch"));
assert.deepEqual(sourceTitleMismatchQa.pages[0].missingSourceTitleTexts, ["\u4eba\u5148\u81f4\u8fdc\uff0c\u6708\u6ee1\u6c47\u5ddd"]);
const tableHeaderMustNotReplacePageTitleQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{
      pageId: "page_009",
      pageNumber: 9,
      ocrLines: [
        { text: "\u8863\u00b7\u5320\u5fc3\u6709\u5ea6", confidence: 0.99, box_px: [0, 0, 261, 38], font_pt_if_cjk: 22 },
        { text: "\u4ea7\u54c1\u5185\u5bb9", confidence: 0.99, box_px: [128, 68, 105, 36], font_pt_if_cjk: 20.9 }
      ]
    }]
  },
  visualHints: {
    pages: [{
      pageId: "page_009",
      pageNumber: 9,
      imageSha256: "table-header-title-drift",
      ocrLines: [{ text: "\u4ea7\u54c1\u5185\u5bb9", confidence: 0.99, box_px: [174, 42, 234, 57], font_pt_if_cjk: 33.1 }]
    }]
  },
  outline: { layoutSequence: Array.from({ length: 9 }, (_item, index) => ({ layout: index === 8 ? "table" : "content", title: index === 8 ? "\u4ea7\u54c1\u5185\u5bb9" : "" })) },
  expectedPageIds: ["page_009"]
});
assert.deepEqual(tableHeaderMustNotReplacePageTitleQa.pages[0].sourceTitleTexts, ["\u8863\u00b7\u5320\u5fc3\u6709\u5ea6"]);
assert.ok(tableHeaderMustNotReplacePageTitleQa.pages[0].blockingReasons.includes("source-title-mismatch"));
const interleavedCriticalTextQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{ pageId: "page_006", pageNumber: 6, ocrLines: [{ text: "举办全国品鉴会现场试吃，10万个月饼，500多个品种里挑选相应得票最高的品", confidence: 0.99 }] }]
  },
  visualHints: {
    pages: [{
      pageId: "page_006",
      pageNumber: 6,
      imageSha256: "interleaved-critical-text",
      ocrLines: [
        { text: "举办全国品鉴会现场试吃，10万个月饼，", confidence: 0.99 },
        { text: "荣誉证书", confidence: 0.99 },
        { text: "500多个品种里挑选相应得票最高的品", confidence: 0.99 }
      ]
    }]
  },
  expectedPageIds: ["page_006"]
});
assert.ok(!interleavedCriticalTextQa.pages[0].blockingReasons.includes("critical-data-or-contact-missing"));
assert.deepEqual(interleavedCriticalTextQa.pages[0].missingCriticalTexts, []);
const mutatedInterleavedCriticalTextQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{ pageId: "page_009", pageNumber: 9, ocrLines: [{ text: "低糖 莲蓉月饼 60g", confidence: 0.99 }] }]
  },
  visualHints: {
    pages: [{ pageId: "page_009", pageNumber: 9, imageSha256: "mutated-critical-text", ocrLines: [{ text: "低糖 莲薯月饼 60g", confidence: 0.99 }] }]
  },
  expectedPageIds: ["page_009"]
});
assert.ok(mutatedInterleavedCriticalTextQa.pages[0].blockingReasons.includes("critical-data-or-contact-missing"));
const splitTableUrlQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{ pageId: "page_009", pageNumber: 9, ocrLines: [{ text: "https://item.jd.com/10224227783390.html", confidence: 0.99 }] }]
  },
  visualHints: {
    pages: [{
      pageId: "page_009",
      pageNumber: 9,
      imageSha256: "split-table-url",
      ocrLines: [
        { text: "https://item.jd.", confidence: 0.99 },
        { text: "15000", confidence: 0.99 },
        { text: "com/102242277", confidence: 0.99 },
        { text: "双层伞布", confidence: 0.99 },
        { text: "83390.html", confidence: 0.99 }
      ]
    }]
  },
  outline: { layoutSequence: Array.from({ length: 9 }, (_item, index) => ({ layout: index === 8 ? "table" : "content" })) },
  expectedPageIds: ["page_009"]
});
assert.ok(!splitTableUrlQa.pages[0].blockingReasons.includes("critical-data-or-contact-missing"));
assert.deepEqual(splitTableUrlQa.pages[0].missingCriticalTexts, []);
const nativeUrlSupersedesOcrFragmentsQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{
      pageId: "page_009",
      pageNumber: 9,
      ocrLines: [
        { text: "https://itemi", confidence: 0.96 },
        { text: "d.com/10224227", confidence: 1 },
        { text: "783390.html", confidence: 0.99 },
        { text: "https://item.jd.com/10224227783390.html", confidence: 1, native_text: true }
      ]
    }]
  },
  visualHints: {
    pages: [{
      pageId: "page_009",
      pageNumber: 9,
      imageSha256: "native-url-supersedes-ocr-fragments",
      ocrLines: [
        { text: "https://item.jd.", confidence: 0.99 },
        { text: "com/102242277", confidence: 0.99 },
        { text: "83390.html", confidence: 0.99 }
      ]
    }]
  },
  outline: { layoutSequence: Array.from({ length: 9 }, (_item, index) => ({ layout: index === 8 ? "table" : "content" })) },
  expectedPageIds: ["page_009"]
});
assert.ok(!nativeUrlSupersedesOcrFragmentsQa.pages[0].blockingReasons.includes("critical-data-or-contact-missing"));
assert.deepEqual(nativeUrlSupersedesOcrFragmentsQa.pages[0].missingCriticalTexts, []);
const denseTableCellOrderQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{
      pageId: "page_009",
      pageNumber: 9,
      ocrLines: ["低糖", "莲蓉月饼", "60g", "斑兰芋泥味白玉酥月饼", "玉桂苹果软心乳酪月饼"].map((text) => ({ text, confidence: 0.99 }))
    }]
  },
  visualHints: {
    pages: [{ pageId: "page_009", pageNumber: 9, imageSha256: "dense-table-cell-order", ocrLines: [{ text: "低糖斑兰芋泥味白玉酥月饼60g", confidence: 0.99 }] }]
  },
  outline: { layoutSequence: Array.from({ length: 9 }, (_item, index) => ({ layout: index === 8 ? "table" : "content" })) },
  expectedPageIds: ["page_009"]
});
assert.ok(!denseTableCellOrderQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.deepEqual(denseTableCellOrderQa.pages[0].inventedCriticalBlockingTexts, []);
const closingLabelTableQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{
      pageId: "page_020",
      pageNumber: 20,
      ocrLines: ["Closing\u4e28Us\u4e28", "Category", "Product content", "Parameter", "Quantity", "Price", "Total", "15000", "626.80"].map((text) => ({ text }))
    }]
  },
  visualHints: {
    pages: [{
      pageId: "page_020",
      pageNumber: 20,
      imageSha256: "closing-table-visual",
      ocrLines: ["Closing\u4e28Us\u4e28", "Category", "Product content", "Parameter", "Quantity", "Price", "Total", "15000", "626.80"].map((text) => ({ text }))
    }]
  },
  outline: { layoutSequence: Array.from({ length: 20 }, () => ({ layout: "content" })) },
  expectedPageIds: ["page_020"]
});
assert.equal(closingLabelTableQa.pages[0].role, "closing");
assert.equal(closingLabelTableQa.pages[0].visualRole, "closing");
assert.ok(!closingLabelTableQa.pages[0].blockingReasons.includes("closing-label-on-content-page"));
assert.equal(closingLabelTableQa.summary.sourceHasSemanticClosing, true);
assert.equal(closingLabelTableQa.summary.closingRecommended, false);
const recurringHeaderTitleQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [1, 2, 3].map((pageNumber) => ({
      pageId: `page_${String(pageNumber).padStart(3, "0")}`,
      pageNumber,
      ocrLines: [
        { text: "INOVANCE", confidence: 0.99, box_px: [50, 20, 260, 54], font_pt_if_cjk: 31 },
        { text: pageNumber === 2 ? "员工关怀方案" : `章节 ${pageNumber}`, confidence: 0.99, box_px: [80, 110, 520, 62], font_pt_if_cjk: 36 }
      ]
    }))
  },
  visualHints: {
    pages: [1, 2, 3].map((pageNumber) => ({
      pageId: `page_${String(pageNumber).padStart(3, "0")}`,
      pageNumber,
      imageSha256: `recurring-header-${pageNumber}`,
      ocrLines: [{ text: pageNumber === 2 ? "员工关怀方案" : `章节 ${pageNumber}`, confidence: 0.99, box_px: [80, 110, 520, 62], font_pt_if_cjk: 36 }]
    }))
  },
  expectedPageIds: ["page_002"]
});
assert.deepEqual(recurringHeaderTitleQa.pages[0].sourceTitleTexts, ["员工关怀方案"]);
assert.ok(!recurringHeaderTitleQa.pages[0].blockingReasons.includes("source-title-mismatch"));
const inventedCriticalQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "INOVANCE", confidence: 0.95 }] }]
  },
  visualHints: {
    pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "brand-drift", ocrLines: [{ text: "INOVANCE", confidence: 0.95 }, { text: "NOVANCE", confidence: 0.9 }] }]
  },
  expectedPageIds: ["page_001"]
});
assert.ok(inventedCriticalQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.deepEqual(inventedCriticalQa.pages[0].inventedCriticalBlockingTexts, ["NOVANCE"]);
const splitInventedCriticalQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "INOVANCE", confidence: 0.95 }] }]
  },
  visualHints: {
    pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "split-brand-drift", ocrLines: [{ text: "NOV", confidence: 0.9 }, { text: "ANCE", confidence: 0.9 }] }]
  },
  expectedPageIds: ["page_001"]
});
assert.ok(splitInventedCriticalQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.deepEqual(splitInventedCriticalQa.pages[0].inventedCriticalBlockingTexts, ["NOV ANCE"]);
const fragmentedInventedCriticalQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "INOVANCE", confidence: 0.95 }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "fragmented-brand-drift", ocrLines: [{ text: "N", confidence: 0.9 }, { text: "OV", confidence: 0.9 }, { text: "ANCE", confidence: 0.9 }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(fragmentedInventedCriticalQa.pages[0].blockingReasons.includes("invented-critical-text"));
const exactSplitBrandQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "INOVANCE", confidence: 0.95 }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "exact-split-brand", ocrLines: [{ text: "IN", confidence: 0.95 }, { text: "OVANCE", confidence: 0.95 }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(!exactSplitBrandQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.ok(!exactSplitBrandQa.pages[0].reviewReasons.includes("invented-critical-text"));
const exactThreePartBrandQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "INOVANCE", confidence: 0.95 }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "exact-three-part-brand", ocrLines: [{ text: "I", confidence: 0.95 }, { text: "NO", confidence: 0.95 }, { text: "VANCE", confidence: 0.95 }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(!exactThreePartBrandQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.ok(!exactThreePartBrandQa.pages[0].reviewReasons.includes("invented-critical-text"));
const cjkBrandMutationQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "\u6c47\u5ddd\u6280\u672f", confidence: 0.95 }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "cjk-brand-drift", ocrLines: [{ text: "\u6c47\u5ddd\u6280\u6728", confidence: 0.95 }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(!cjkBrandMutationQa.pages[0].blockingReasons.includes("critical-brand-or-code-missing"));
assert.ok(cjkBrandMutationQa.pages[0].reviewReasons.includes("missing-critical-source-text"));
const mixedBrandMutationQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "OpenAI", confidence: 0.95 }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "mixed-brand-drift", ocrLines: [{ text: "OpenAl", confidence: 0.95 }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(mixedBrandMutationQa.pages[0].blockingReasons.includes("critical-brand-or-code-missing"));
const genericUppercaseQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "MID-AUTUMN", confidence: 0.95 }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "decorative-slogan", ocrLines: [{ text: "MID-AUTUMN", confidence: 0.95 }, { text: "TRADITIONAL CHINESE FESTIVALS", confidence: 0.95 }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(!genericUppercaseQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.ok(genericUppercaseQa.pages[0].reviewReasons.includes("invented-critical-text"));
const sourceBrandFragmentQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "AUTUMN", confidence: 0.99, ocr_sources: ["paddleocr-local", "rapidocr-onnxruntime"] }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "joined-source-fragment", ocrLines: [{ text: "MID-AUTUMN", confidence: 0.99, ocr_sources: ["paddleocr-local", "rapidocr-onnxruntime"] }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(!sourceBrandFragmentQa.pages[0].blockingReasons.includes("critical-brand-or-code-missing"));
const confirmedDeckFooterQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [
      { pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "benlai.com", confidence: 0.99 }] },
      { pageId: "page_002", pageNumber: 2, ocrLines: [{ text: "核心方案", confidence: 0.99 }] }
    ]
  },
  visualHints: {
    pages: [
      { pageId: "page_001", pageNumber: 1, imageSha256: "deck-footer-cover", ocrLines: [{ text: "benlai.com", confidence: 0.99 }] },
      { pageId: "page_002", pageNumber: 2, imageSha256: "deck-footer-content", ocrLines: [{ text: "核心方案", confidence: 0.99 }, { text: "benlai.com", confidence: 0.99 }] }
    ]
  },
  expectedPageIds: ["page_002"]
});
assert.ok(!confirmedDeckFooterQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.ok(!confirmedDeckFooterQa.pages[0].reviewReasons.includes("invented-critical-text"));
const joinedBrandQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "TRAVEL READY", confidence: 0.95 }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "joined-brand", ocrLines: [{ text: "TRAVELREADY", confidence: 0.95 }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(!joinedBrandQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.ok(!joinedBrandQa.pages[0].reviewReasons.includes("invented-critical-text"));
const shortInventedTokenQa = buildVisualTextQualityReport({
  sourceHints: { pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "INOVANCE", confidence: 0.95 }] }] },
  visualHints: { pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "short-noise", ocrLines: [{ text: "INOVANCE", confidence: 0.95 }, { text: "MIIN", confidence: 0.8 }] }] },
  expectedPageIds: ["page_001"]
});
assert.ok(!shortInventedTokenQa.pages[0].blockingReasons.includes("invented-critical-text"));
assert.ok(shortInventedTokenQa.pages[0].reviewReasons.includes("invented-critical-text"));
const partialSemanticTextQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [1, 2].map((pageNumber) => ({
      pageId: `page_${String(pageNumber).padStart(3, "0")}`,
      pageNumber,
      ocrLines: [{ text: pageNumber === 1 ? "项目封面" : "核心方案" }]
    }))
  },
  visualHints: {
    pages: [1, 2].map((pageNumber) => ({
      pageId: `page_${String(pageNumber).padStart(3, "0")}`,
      pageNumber,
      imageSha256: `visual-${pageNumber}`,
      ocrLines: [{ text: pageNumber === 1 ? "项目封面" : "核心方案" }]
    }))
  },
  outline: { layoutSequence: Array.from({ length: 20 }, () => ({ layout: "content" })) },
  expectedPageIds: ["page_001", "page_002"]
});
assert.equal(partialSemanticTextQa.summary.expectedPageCount, 2);
assert.equal(partialSemanticTextQa.summary.complete, true);
const summaryTextLossQa = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{
      pageId: "page_001",
      pageNumber: 1,
      ocrLines: ["项目总结", "目标完成情况", "关键成果一", "关键成果二", "风险说明", "经验复盘", "后续计划", "负责人安排"].map((text) => ({ text }))
    }]
  },
  visualHints: {
    pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "summary-visual", ocrLines: [{ text: "项目总结" }] }]
  },
  outline: { layoutSequence: [{ layout: "summary", title: "项目总结" }] },
  expectedPageIds: ["page_001"]
});
assert.equal(summaryTextLossQa.pages[0].role, "summary");
assert.ok(summaryTextLossQa.pages[0].blockingReasons.includes("substantial-source-text-loss"));
assert.equal(classifyDeckText("2026年预算"), "data");
assert.equal(classifyDeckText("18元/人"), "data");
assert.equal(classifyDeckText("完成率 25%"), "data");
assert.equal(classifyDeckText("benlai.com"), "contact");
assert.equal(classifyDeckText("\u6c47\u5ddd\u6280\u672f"), "brand_candidate");
assert.equal(classifyDeckText("OpenAI"), "brand_or_code");
assert.equal(classifyDeckText("OpenAl"), "brand_or_code");
assert.equal(classifyDeckText("\u6838\u5fc3\u6280\u672f"), "brand_candidate");
assert.equal(classifyDeckText("\u524d\u6cbf\u6280\u672f"), "brand_candidate");
assert.throws(
  () => assertWorkflowVisualGenerationAllowed({ dryRun: true, requestedBy: "frontend-route-a-two-page-test" }),
  (error) => error?.code === "CODEX_PPT_NON_PRODUCT_VISUAL_REQUIRES_OPT_IN"
);
assert.doesNotThrow(() => assertWorkflowVisualGenerationAllowed({ dryRun: true, allowNonProductVisual: true }));
const staleDeckInvalidation = invalidateStaleImageDeck({
  imageDeck: { path: "same-page-count-but-old-style.pptx", pageCount: 2 },
  visualQuality: { path: "old-quality.json" },
  visualImages: [
    { pageId: "page_001", path: "page_001.png", staleStyleReference: false },
    { pageId: "page_002", path: "page_002.png", staleStyleReference: true }
  ]
});
assert.equal(Boolean(staleDeckInvalidation.artifacts.imageDeck), false);
assert.equal(Boolean(staleDeckInvalidation.artifacts.visualQuality), false);
const staleWithoutDeckInvalidation = invalidateStaleImageDeck({
  visualQuality: { path: "old-quality.json" },
  editableFinal: { path: "old-final.pptx" },
  visualImages: [{ pageId: "page_001", path: "page_001.png", staleStyleReference: true }]
});
assert.equal(Boolean(staleWithoutDeckInvalidation.artifacts.visualQuality), false);
assert.equal(Boolean(staleWithoutDeckInvalidation.artifacts.editableFinal), false);
assert.deepEqual(getPendingVisualPageNumbers({
  artifacts: {
    renderedPages: [1, 2, 3, 4].map((pageNumber) => ({ pageNumber })),
    visualImages: [
      { pageNumber: 1, path: "page_001.png", staleStyleReference: false },
      { pageNumber: 2, path: "page_002.png", staleStyleReference: true }
    ]
  }
}), [2, 3, 4]);
assert.deepEqual(getPendingVisualPageNumbers({
  artifacts: {
    renderedPages: [1, 2, 3].map((pageNumber) => ({ pageNumber })),
    visualImages: [],
    visualSample: { pageNumber: 2, pageId: "page_002", path: "sample.png", sha256: "sample-sha" },
    codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256: "sample-sha" }]
  }
}), [1, 2, 3]);
assert.deepEqual(buildVisualGenerationScope({
  artifacts: {
    renderedPages: [{ pageNumber: 1 }],
    visualImages: [{ pageNumber: 1, path: "page_001.png", staleStyleReference: false }]
  }
}), {
  pendingPages: [],
  explicitPages: "",
  requestedPages: [],
  pageCount: 0,
  pageSelection: ""
});
const configuredImageProvider = getProviderConfig().image;
const authorizationConfirmedAt = new Date().toISOString();
const authorizationExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const pageScopedAuthorizationJob = {
  artifacts: {
    externalImageSpendAuthorizations: [{
      scope: "full-deck",
      imageCalls: 18,
      pages: Array.from({ length: 18 }, (_, index) => index + 3),
      baseUrl: configuredImageProvider.baseUrl,
      model: configuredImageProvider.model,
      confirmedAt: authorizationConfirmedAt,
      expiresAt: authorizationExpiresAt,
      consumedAt: ""
    }]
  }
};
assert.equal(getExternalImageAuthorizationStatus(pageScopedAuthorizationJob, {
  scope: "full-deck",
  imageCalls: 18,
  pages: Array.from({ length: 18 }, (_, index) => index + 3)
}).persisted, true);
assert.equal(getExternalImageAuthorizationStatus(pageScopedAuthorizationJob, {
  scope: "full-deck",
  imageCalls: 18,
  pages: Array.from({ length: 18 }, (_, index) => index + 1)
}).persisted, false);
assert.equal(getExternalImageAuthorizationStatus({
  artifacts: {
    externalImageSpendAuthorizations: [{
      ...pageScopedAuthorizationJob.artifacts.externalImageSpendAuthorizations[0],
      consumedAt: new Date().toISOString()
    }]
  }
}, {
  scope: "full-deck",
  imageCalls: 18,
  pages: Array.from({ length: 18 }, (_, index) => index + 3)
}).persisted, false);
assert.equal(getExternalImageAuthorizationStatus({
  artifacts: {
    externalImageSpendAuthorizations: [{
      ...pageScopedAuthorizationJob.artifacts.externalImageSpendAuthorizations[0],
      expiresAt: new Date(Date.now() - 1000).toISOString()
    }]
  }
}, {
  scope: "full-deck",
  imageCalls: 18,
  pages: Array.from({ length: 18 }, (_, index) => index + 3)
}).persisted, false);
assert.equal(sanitizeBatchError("Bearer abcdefghijklmnop sk-1234567890abcdef"), "Bearer *** sk-***");
const attemptedNetworkBatchPages = [];
const networkBatchErrors = [];
await runSequentialSlideTasks([{ pageId: "page_001" }, { pageId: "page_002" }, { pageId: "page_003" }], async (task) => {
  attemptedNetworkBatchPages.push(task.pageId);
  throw buildProviderConnectionError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }), "https://ai.example.test/v1/images/edits");
}, {
  onError: async (error, task) => networkBatchErrors.push({ pageId: task.pageId, error: sanitizeBatchError(error) })
});
assert.deepEqual(attemptedNetworkBatchPages, ["page_001"]);
assert.deepEqual(networkBatchErrors.map((item) => item.pageId), ["page_001"]);
const hiddenProviderError = await readProviderError(new Response(JSON.stringify({
  error: { message: "Bearer abcdefghijklmnop sk-1234567890abcdef" }
}), { status: 500, headers: { "content-type": "application/json" } }));
assert.equal(hiddenProviderError, "Provider service is temporarily unavailable.");
assert.doesNotMatch(hiddenProviderError, /Bearer|sk-/);
const packageScripts = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).scripts;
assert.match(packageScripts.start, /--use-env-proxy/);
assert.match(packageScripts.dev, /--use-env-proxy/);
assert.match(fs.readFileSync(path.join(process.cwd(), "scripts", "start-local.ps1"), "utf8"), /--use-env-proxy/);

const slideRecoveryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-slide-recovery-smoke-"));
try {
  const samplePath = path.join(slideRecoveryDir, "sample.png");
  const pageTwoPath = path.join(slideRecoveryDir, "page_002.png");
  fs.writeFileSync(samplePath, "approved-sample");
  fs.writeFileSync(pageTwoPath, "existing-page-two");
  const sampleSha256 = crypto.createHash("sha256").update(fs.readFileSync(samplePath)).digest("hex");
  const references = resolveCodexStyleReferenceImages({ artifacts: { visualSample: { path: samplePath } } }, {
    styleReferenceImages: [samplePath, samplePath]
  });
  assert.deepEqual(references, [samplePath]);
  const sampleJob = {
    artifacts: {
      visualSample: { path: samplePath, sha256: sampleSha256 },
      codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256 }]
    }
  };
  assert.equal(resolveAppliedSampleSha256(sampleJob, { referenceImagePaths: [samplePath] }), sampleSha256);
  assert.equal(resolveAppliedSampleSha256(sampleJob, { referenceImagePaths: [] }), "");
  const approvalManifestPath = path.join(slideRecoveryDir, "approval_manifest.json");
  fs.writeFileSync(approvalManifestPath, JSON.stringify({ version: 1, images: [] }), "utf8");
  const approvalReconciliationJob = {
    artifacts: {
      visualSample: { path: samplePath, sha256: sampleSha256 },
      visualManifest: { path: approvalManifestPath },
      visualImages: [
        { pageId: "page_001", pageNumber: 1, path: samplePath, referenceImagePaths: [samplePath], approvedSampleSha256: sampleSha256 },
        { pageId: "page_002", pageNumber: 2, path: pageTwoPath, referenceImagePaths: [], approvedSampleSha256: "old-sample" }
      ],
      visualQuality: { path: "old-quality.json" },
      editableFinal: { path: "old-final.pptx" }
    },
    events: []
  };
  await reconcileVisualArtifactsForApprovedSample(approvalReconciliationJob, { sampleSha256 }, "2026-08-06T00:00:00Z");
  assert.equal(approvalReconciliationJob.artifacts.visualImages[0].staleStyleReference, false);
  assert.equal(approvalReconciliationJob.artifacts.visualImages[1].staleStyleReference, true);
  assert.equal(Boolean(approvalReconciliationJob.artifacts.visualQuality), false);
  assert.equal(Boolean(approvalReconciliationJob.artifacts.editableFinal), false);
  assert.equal(JSON.parse(fs.readFileSync(approvalManifestPath, "utf8")).images[1].staleStyleReference, true);
  const staleMergedTasks = mergeCodexPptSlideTasks(
    [{ pageId: "page_002", pageNumber: 2, status: "recorded", imagePath: pageTwoPath }],
    [{ pageId: "page_002", pageNumber: 2, path: path.join(slideRecoveryDir, "page_002_prompt.json") }],
    { slides: [{ pageId: "page_002", pageNumber: 2, status: "recorded", imagePath: pageTwoPath }] },
    ["page_002"]
  );
  assert.equal(staleMergedTasks[0].status, "ready");
  assert.equal(staleMergedTasks[0].imagePath, "");
  const recovered = await prepareCodexPptSlideRun({
    id: "slide-recovery-smoke",
    rootDir: slideRecoveryDir,
    artifacts: {
      visualSample: { path: samplePath, pageId: "page_001", pageNumber: 1, sha256: sampleSha256, provider: "smoke", createdAt: "2026-08-06T00:00:00Z" },
      visualImages: [{ pageId: "page_002", pageNumber: 2, path: pageTwoPath, sha256: "page-two-sha", provider: "smoke", referenceImagePaths: [samplePath], approvedSampleSha256: sampleSha256 }],
      codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256 }]
    }
  }, {
    renderedPages: [
      { pageId: "page_001", pageNumber: 1, path: samplePath },
      { pageId: "page_002", pageNumber: 2, path: pageTwoPath }
    ],
    prompts: {
      pages: [
        { pageId: "page_001", pageNumber: 1, prompt: "one", styleReferenceImages: [samplePath] },
        { pageId: "page_002", pageNumber: 2, prompt: "two", styleReferenceImages: [samplePath] }
      ]
    },
    selectedPages: [1, 2]
  });
  const recoveredState = JSON.parse(fs.readFileSync(recovered.slideRunState.path, "utf8"));
  assert.equal(recoveredState.summary.recorded, 2);
  assert.equal(recoveredState.summary.complete, true);
  assert.equal(recoveredState.slides[0].dispatchMode, "accepted-sample");
  assert.equal(recoveredState.slides[1].dispatchMode, "manifest-recovery");
} finally {
  fs.rmSync(slideRecoveryDir, { recursive: true, force: true });
}

const ocrCoverageDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-ocr-coverage-smoke-"));
try {
  const sourcePath = path.join(ocrCoverageDir, "source.png");
  const visualPath = path.join(ocrCoverageDir, "visual.png");
  const hintsPath = path.join(ocrCoverageDir, "text_hints.json");
  fs.writeFileSync(sourcePath, "source");
  fs.writeFileSync(visualPath, "visual");
  fs.writeFileSync(hintsPath, JSON.stringify({ pages: [{ pageId: "page_001", pageNumber: 1, imagePath: visualPath }] }));
  const coverageJob = {
    artifacts: {
      renderedPages: [{ pageId: "page_001", pageNumber: 1, path: sourcePath }],
      ocrTextHints: { path: hintsPath }
    }
  };
  const resolvedOcrInputs = getOcrInputImages(coverageJob, { pages: [1] });
  assert.equal(resolvedOcrInputs.length, 1);
  assert.equal(resolvedOcrInputs[0].sha256, crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"));
  assert.equal(getWorkflowOcrCoverage(coverageJob, { pages: [1] }).complete, false);
  fs.writeFileSync(hintsPath, JSON.stringify({ pages: [{ pageId: "page_001", pageNumber: 1, imagePath: sourcePath }] }));
  assert.equal(getWorkflowOcrCoverage(coverageJob, { pages: [1] }).complete, false);
  const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  fs.writeFileSync(hintsPath, JSON.stringify({ pages: [{ pageId: "page_001", pageNumber: 1, imagePath: sourcePath, imageSha256: sourceSha256 }] }));
  assert.equal(getWorkflowOcrCoverage(coverageJob, { pages: [1] }).complete, true);
  const sourceStat = fs.statSync(sourcePath);
  fs.writeFileSync(sourcePath, "tamper");
  fs.utimesSync(sourcePath, sourceStat.atime, sourceStat.mtime);
  assert.equal(getWorkflowOcrCoverage(coverageJob, { pages: [1] }).complete, false);
  fs.writeFileSync(sourcePath, "source");
  fs.utimesSync(sourcePath, sourceStat.atime, sourceStat.mtime);
  assert.equal(getWorkflowOcrCoverage(coverageJob, { pages: [1] }).complete, true);
  coverageJob.artifacts.renderedPages[0].sha256 = "source-v1";
  assert.equal(getWorkflowOcrCoverage(coverageJob, { pages: [1] }).complete, false);
  fs.writeFileSync(hintsPath, JSON.stringify({ pages: [{ pageId: "page_001", pageNumber: 1, imagePath: sourcePath, imageSha256: "source-v1" }] }));
  assert.equal(getWorkflowOcrCoverage(coverageJob, { pages: [1] }).complete, true);
  const visualHintsPath = path.join(ocrCoverageDir, "visual_text_hints.json");
  fs.writeFileSync(visualHintsPath, JSON.stringify({ pages: [{
    pageId: "page_001",
    pageNumber: 1,
    imagePath: visualPath,
    imageSha256: "visual-v1"
  }] }));
  coverageJob.artifacts.visualImages = [{ pageId: "page_001", pageNumber: 1, path: visualPath, sha256: "visual-v1" }];
  coverageJob.artifacts.visualOcrTextHints = { path: visualHintsPath, coordinateModeVersion: "visual-coordinates-v2" };
  assert.equal(getWorkflowOcrCoverage(coverageJob, { source: "visual", pages: [1] }).complete, true);
  coverageJob.artifacts.visualImages[0].sha256 = "visual-v2";
  assert.equal(getWorkflowOcrCoverage(coverageJob, { source: "visual", pages: [1] }).complete, false);
} finally {
  fs.rmSync(ocrCoverageDir, { recursive: true, force: true });
}

assert.equal(isSourceTextInput("rendered-pages/page_001.md"), true);
const mergedOcrPage = mergeOcrPageEvidence([{
  pageId: "page_001",
  pageNumber: 1,
  backend: "paddleocr-local",
  lines: [
    { text: "汇川技术", confidence: 0.98, box_px: [80, 60, 240, 52] },
    { text: "中秋员工慰问提案", confidence: 0.96, box_px: [80, 130, 520, 58] }
  ]
}, {
  pageId: "page_001",
  pageNumber: 1,
  backend: "rapidocr-onnxruntime",
  lines: [
    { text: "汇川技术", confidence: 0.97, box_px: [82, 61, 238, 51] },
    { text: "benlai.com", confidence: 0.94, box_px: [1110, 650, 120, 24] }
  ]
}]);
assert.equal(mergedOcrPage.backend, "ocr-ensemble");
assert.deepEqual(mergedOcrPage.providerBackends, ["paddleocr-local", "rapidocr-onnxruntime"]);
assert.equal(mergedOcrPage.lines.filter((line) => line.text === "汇川技术").length, 1);
assert.equal(mergedOcrPage.lines.find((line) => line.text === "汇川技术")?.ocr_sources?.length, 2);
assert.ok(mergedOcrPage.lines.some((line) => line.text === "benlai.com"));
const conflictingOcrPage = mergeOcrPageEvidence([{
  pageId: "page_001",
  pageNumber: 1,
  backend: "paddleocr-local",
  lines: [{ text: "INOVANCC", confidence: 0.99, box_px: [80, 80, 260, 56], font_pt_if_cjk: 28 }]
}, {
  pageId: "page_001",
  pageNumber: 1,
  backend: "rapidocr-onnxruntime",
  lines: [{ text: "INOVANCE", confidence: 0.96, box_px: [82, 81, 258, 55], font_pt_if_cjk: 28 }]
}]);
const conflictingBrandLine = conflictingOcrPage.lines[0];
assert.equal(conflictingBrandLine.ensemble_agreement, false);
assert.equal(conflictingBrandLine.low_confidence, true);
assert.ok(conflictingBrandLine.ocr_alternatives.includes("INOVANCE"));
const conflictingOcrQuality = buildVisualTextQualityReport({
  sourceHints: {
    pages: [{
      pageId: "page_001",
      pageNumber: 1,
      ocrLines: [{ text: "INOVANCE", confidence: 0.99, native_text: true, box_px: [80, 80, 260, 56], font_pt_if_cjk: 28 }]
    }]
  },
  visualHints: {
    pages: [{
      pageId: "page_001",
      pageNumber: 1,
      imageSha256: "visual-conflict-v1",
      ocrLines: conflictingOcrPage.lines
    }]
  },
  expectedPageIds: ["page_001"]
});
assert.ok(!conflictingOcrQuality.pages[0].blockingReasons.includes("critical-brand-or-code-missing"));
assert.ok(!conflictingOcrQuality.pages[0].blockingReasons.includes("invented-critical-text"));
const mergedOcrHints = mergeWorkflowOcrTextHints({
  pages: [
    { pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "one" }] },
    { pageId: "page_002", pageNumber: 2, ocrLines: [{ text: "stale" }] }
  ],
  errors: []
}, {
  backend: "paddleocr-local",
  pages: [{ pageId: "page_002", pageNumber: 2, ocrLines: [{ text: "two" }] }],
  errors: []
}, [{ pageId: "page_002", pageNumber: 2 }]);
assert.deepEqual(mergedOcrHints.pages.map((page) => page.pageId), ["page_001", "page_002"]);
assert.equal(mergedOcrHints.pages[1].ocrLines[0].text, "two");
assert.equal(mergedOcrHints.pageCount, 2);
assert.equal(mergedOcrHints.textCount, 2);
const concurrentLatestJob = {
  id: "workflow_concurrent_ocr",
  currentStage: "visual_pages_ready",
  status: "visual_pages_ready",
  stageStatus: "complete",
  stages: {
    ocr_ready: { status: "complete", message: "source OCR ready" },
    visual_pages_ready: { status: "complete", message: "visuals ready" }
  },
  pages: [{ pageNumber: 1, status: "recorded", message: "visual page recorded" }],
  artifacts: {
    imageDeckReview: { status: "approved", summary: { readyForApproval: true } },
    visualImages: [{ pageId: "page_001", pageNumber: 1, path: "visual/page_001.png", sha256: "visual-v1" }]
  },
  events: []
};
const preservedOcrMerge = applyWorkflowOcrResultToJob(concurrentLatestJob, {
  visualEvidenceMode: true,
  hintsArtifact: { path: "visual_text_hints.json", evidenceSha256: "ocr-v1" },
  pageArtifacts: [{ pageId: "page_001", pageNumber: 1, imageSha256: "visual-v1" }],
  pageUpdates: [{ pageNumber: 1, status: "recorded", message: "OCR ready" }],
  provider: { provider: "paddleocr-local" },
  hints: { pageCount: 1, summary: { textCount: 3, lowConfidenceCount: 0, mojibakeCount: 0, quality: {} } },
  errors: [],
  preserveWorkflowStage: true
});
assert.equal(preservedOcrMerge.currentStage, "visual_pages_ready");
assert.equal(preservedOcrMerge.status, "visual_pages_ready");
assert.deepEqual(preservedOcrMerge.pages, concurrentLatestJob.pages);
assert.deepEqual(preservedOcrMerge.stages, concurrentLatestJob.stages);
assert.equal(preservedOcrMerge.artifacts.imageDeckReview.status, "approved");
assert.equal(preservedOcrMerge.artifacts.visualOcrPages.length, 1);
assert.equal(preservedOcrMerge.events.at(-1)?.type, "ocr.ready");
const stagedOcrMerge = applyWorkflowOcrResultToJob(concurrentLatestJob, {
  visualEvidenceMode: false,
  hintsArtifact: { path: "text_hints.json" },
  pageArtifacts: [{ pageId: "page_001", pageNumber: 1 }],
  pageUpdates: [{ pageNumber: 1, status: "recorded", message: "OCR ready" }],
  provider: { provider: "paddleocr-local" },
  hints: { pageCount: 1, summary: {} },
  errors: []
});
assert.equal(stagedOcrMerge.currentStage, "ocr_ready");
assert.equal(stagedOcrMerge.pages[0].message, "OCR ready");
assert.equal(isSourceTextInput("rendered-pages/page_001.png"), false);
assert.deepEqual(extractSourceTextLines("# 标题\n\n- 第一项\n- [第二项](https://example.com)"), ["标题", "第一项", "第二项"]);
assert.equal(isVisualSourceImage("rendered-pages/page_001.png"), true);
assert.equal(isVisualSourceImage("rendered-pages/page_001.md"), false);
const briefPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-brief-prompt-smoke-"));
try {
  const briefPath = path.join(briefPromptDir, "source.md");
  fs.writeFileSync(briefPath, "# PPT Brief Source\n用户需求：\n主题：PPT Agent 纯前端闭环测试。蓝白配色。\n已确认大纲：\n1. 封面", "utf8");
  const briefJob = { artifacts: { source: { kind: "brief_source", path: briefPath } } };
  assert.match(buildBriefSourcePrompt(briefJob), /PPT Agent 纯前端闭环测试/);
  const briefPayload = buildVisualPromptsPayload(briefJob, [{ pageId: "page_001", pageNumber: 1, path: briefPath }]);
  assert.match(briefPayload.pages[0].prompt, /Use its exact subject and requested title/);
  assert.doesNotMatch(briefPayload.pages[0].prompt, /SOURCE INFORMATION ASSET MAP/);
} finally {
  fs.rmSync(briefPromptDir, { recursive: true, force: true });
}

const contactPromptDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-contact-cta-smoke-"));
try {
  const sourceOcrPath = path.join(contactPromptDir, "text_hints.json");
  fs.writeFileSync(sourceOcrPath, JSON.stringify({
    pages: [{
      pageId: "page_002",
      pageNumber: 2,
      ocrLines: [{ text: "联系我们，", confidence: 0.99, box_px: [80, 620, 180, 36] }]
    }]
  }));
  const contactPromptJob = {
    id: "workflow_contact_cta",
    artifacts: {
      source: { kind: "source_pptx", path: path.join(contactPromptDir, "source.pptx") },
      ocrTextHints: { path: sourceOcrPath }
    }
  };
  const contactPromptPayload = buildVisualPromptsPayload(contactPromptJob, [
    { pageId: "page_001", pageNumber: 1, path: "page_001.png" },
    { pageId: "page_002", pageNumber: 2, path: "page_002.png" },
    { pageId: "page_003", pageNumber: 3, path: "page_003.png" }
  ]);
  const contactPrompt = contactPromptPayload.pages.find((page) => page.pageId === "page_002");
  assert.equal(contactPrompt.role, "content");
  assert.match(contactPrompt.prompt, /联系我们，/);
  assert.doesNotMatch(contactPrompt.prompt, /Remove these misleading terminal labels instead of preserving them: 联系我们，/i);
} finally {
  fs.rmSync(contactPromptDir, { recursive: true, force: true });
}

assert.equal(isPageResultEvidenceComplete({
  dispatch: { agent_id: "main", execution_mode: "local" },
  result: { agent_id: "main", record_mode: "local-main-agent", recorded_at: "2026-08-05T00:00:00Z", validation_passed: true }
}), true);
assert.equal(isPageResultEvidenceComplete({
  dispatch: { agent_id: "main", execution_mode: "worker" },
  result: { agent_id: "main", record_mode: "local-main-agent", recorded_at: "2026-08-05T00:00:00Z", validation_passed: true }
}), false);

assert.deepEqual(collectMissingForegroundAssets({
  visual_inventory: [
    { id: "product_badge", description: "Asset-sheet separated by image edit." },
    { id: "brand_lockup", description: "Asset-sheet separated brand logo." }
  ],
  images: [
    { id: "product_badge", path: "assets/foreground/product-badge.png" },
    { id: "brand_lockup", path: "assets/foreground/brand-logo.png" }
  ],
  asset_provenance: [
    { path: "assets/foreground/product-badge.png", source_type: "asset-sheet-separated" },
    { path: "assets/foreground/brand-logo.png", source_type: "asset-sheet-separated" }
  ]
}), []);

assert.deepEqual(evaluateEditableVisualFidelity({
  available: true,
  score: 0.927,
  edgeOverlap: 0.762,
  edgeRetention: 0.959,
  targetEdgeCount: 909
}), ["preview-visual-similarity-low"]);
assert.deepEqual(evaluateEditableVisualFidelity({
  available: true,
  score: 0.94,
  edgeOverlap: 0.78,
  edgeRetention: 0.96,
  targetEdgeCount: 909
}), []);
assert.deepEqual(evaluateEditableVisualFidelity({
  available: true,
  rawScore: 0.9299,
  score: 0.93,
  edgeOverlap: 0.78,
  edgeRetention: 0.96,
  targetEdgeCount: 909
}), ["preview-visual-similarity-low"]);
assert.deepEqual(evaluateEditableVisualFidelity({
  available: true,
  rawScore: 0.93,
  score: 0.93,
  edgeOverlap: 0.78,
  edgeRetention: 0.96,
  targetEdgeCount: 909
}), []);
assert.deepEqual(evaluateEditableVisualFidelity({
  available: true,
  score: 0.762,
  edgeOverlap: 0.126,
  edgeRetention: 0.256,
  targetEdgeCount: 945
}), ["preview-visual-similarity-low", "preview-visual-similarity-critical", "preview-structure-loss"]);
assert.deepEqual(evaluateEditableVisualFidelity({ available: false }), ["visual-comparison-unavailable"]);
assert.deepEqual(evaluateEditableVisualFidelity({
  available: true,
  score: 0.845,
  edgeOverlap: 0.658,
  edgeRetention: 0.9,
  targetEdgeCount: 2010,
  contentTileCount: 47,
  weakContentTileRatio: 0.17,
  lowContentTileScore: 0.651
}), ["preview-visual-similarity-low", "preview-structure-loss"]);
assert.equal(isBlockingEditableVisualIssue("preview-visual-similarity-low"), false);
assert.equal(isBlockingEditableVisualIssue("preview-visual-similarity-critical"), true);
const missingVisualCoverage = buildPartialFinalCoverage({
  sourceMeta: { pageCount: 4 },
  artifacts: {
    editableFinal: { path: "final.pptx", summary: { page_count: 2 } },
    renderedPages: [1, 2, 3, 4].map((pageNumber) => ({ pageId: `page_${String(pageNumber).padStart(3, "0")}` })),
    visualImages: [{ pageId: "page_001" }, { pageId: "page_003" }],
    editableWorkerTasks: [{ pageId: "page_001", status: "accepted" }, { pageId: "page_003", status: "accepted" }]
  }
});
assert.deepEqual(missingVisualCoverage.missingVisualPageIds, ["page_002", "page_004"]);
assert.equal(missingVisualCoverage.pageSelection, "page_002,page_004");
assert.equal(missingVisualCoverage.canContinueRemainingPages, true);
const partialRenderCoverage = buildPartialFinalCoverage({
  sourceMeta: { pageCount: 4 },
  artifacts: {
    editableFinal: { path: "final.pptx", summary: { page_count: 1 } },
    renderedPages: [{ pageId: "page_001" }],
    visualImages: [{ pageId: "page_001" }],
    editableWorkerTasks: [{ pageId: "page_001", status: "accepted" }]
  }
});
assert.deepEqual(partialRenderCoverage.missingVisualPageIds, ["page_002", "page_003", "page_004"]);
const missingEditableCoverage = buildPartialFinalCoverage({
  sourceMeta: { pageCount: 4 },
  artifacts: {
    editableFinal: { path: "final.pptx", summary: { page_count: 2 } },
    renderedPages: [1, 2, 3, 4].map((pageNumber) => ({ pageId: `page_${String(pageNumber).padStart(3, "0")}` })),
    visualImages: [1, 2, 3, 4].map((pageNumber) => ({ pageId: `page_${String(pageNumber).padStart(3, "0")}` })),
    editableWorkerTasks: [{ pageId: "page_001", status: "accepted" }, { pageId: "page_003", status: "accepted" }]
  }
});
assert.deepEqual(missingEditableCoverage.missingEditablePageIds, ["page_002", "page_004"]);
assert.equal(missingEditableCoverage.canContinueRemainingPages, false);
assert.equal(missingEditableCoverage.canContinueEditablePages, true);
assert.deepEqual(collectMissingForegroundAssets({
  visual_inventory: [
    { id: "feature_icons", description: "Five foreground icons separated by image edit." },
    { id: "layout_structure", description: "Native structural page badge, panels, and dividers." }
  ],
  images: [
    { id: "target_icon", path: "assets/target-icon.png" },
    { id: "people_icon", path: "assets/people-icon.png" }
  ],
  asset_provenance: [
    { path: "assets/target-icon.png", source_type: "asset-sheet-separated" },
    { path: "assets/people-icon.png", source_type: "asset-sheet-separated" }
  ]
}), []);

const styleLockSmokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-style-lock-smoke-"));
try {
  const approvedSamplePath = path.join(styleLockSmokeDir, "sample.png");
  fs.writeFileSync(approvedSamplePath, "sample");
  const approvedSampleSha256 = crypto.createHash("sha256").update(fs.readFileSync(approvedSamplePath)).digest("hex");
  const approvedSampleJob = {
    artifacts: {
      visualSample: { path: approvedSamplePath, sha256: approvedSampleSha256 },
      codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256: approvedSampleSha256 }]
    }
  };
  assert.equal(isCodexPptSampleApprovalCurrent(approvedSampleJob), true);
  const styleLockedPrompts = buildVisualPromptsPayload({
    id: "workflow_style_lock_smoke",
    artifacts: {
      visualSample: {
        path: approvedSamplePath,
        pageId: "page_001",
        pageNumber: 1,
        sha256: approvedSampleSha256,
        provider: "openai-compatible-image",
        dryRun: false
      },
      codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256: approvedSampleSha256 }],
      codexPptStyle: { styleBrief: "Approved warm editorial presentation style." }
    }
  }, [{ pageId: "page_002", pageNumber: 2, path: path.join(styleLockSmokeDir, "source.png") }], {
    sampleStyleFingerprint: {
      palette: ["light-vivid-orange", "light-soft-yellow"],
      brightness: "bright",
      saturation: "high-saturation",
      density: "balanced-detail",
      traits: ["balanced-whitespace", "soft-contrast"]
    }
  });
  const lockedPrompt = styleLockedPrompts.pages[0].prompt;
  assert.ok(lockedPrompt.includes("approved sample is the sole deck-level visual authority"));
  assert.ok(lockedPrompt.includes("CONTENT AUTHORITY"));
  assert.ok(lockedPrompt.includes("VISUAL AUTHORITY"));
  assert.ok(lockedPrompt.includes("STYLE REFERENCE CONTENT EXCLUSION"));
  assert.ok(lockedPrompt.includes("light-vivid-orange"));
  assert.ok(lockedPrompt.includes("Do not preserve or imitate the source page's palette"));
  assert.ok(lockedPrompt.includes("ROLE TYPOGRAPHY LIMITS"));
  assert.ok(lockedPrompt.includes("FONT FAMILY LOCK"));
  assert.ok(lockedPrompt.includes("MASTER ELEMENT LOCK"));
  assert.ok(lockedPrompt.includes("STYLE SYSTEM SUMMARY"));
  assert.ok(lockedPrompt.includes("approved sample is the final typography authority"));
  assert.ok(lockedPrompt.includes("Match the approved sample's visible type-family mood"));
  assert.ok(lockedPrompt.includes("Do not render slide numbers"));
  assert.ok(lockedPrompt.includes("FORBIDDEN OUTPUT"));
  assert.ok(!lockedPrompt.includes("Preserve clearly visible logos, brand color blocks"));
  const continuityPath = path.join(styleLockSmokeDir, "continuity.png");
  const continuityQaPath = path.join(styleLockSmokeDir, "continuity-qa.json");
  fs.writeFileSync(continuityPath, "continuity");
  fs.writeFileSync(continuityQaPath, JSON.stringify({ pages: [{ pageId: "page_003", status: "pass", blockingReasons: [] }] }));
  const continuityJob = {
    artifacts: {
      visualImages: [{ pageId: "page_003", pageNumber: 3, path: continuityPath, sha256: "continuity-sha" }],
      visualTextQuality: { path: continuityQaPath },
      codexPptStyle: { styleBrief: "Keep the current deck identity." }
    }
  };
  const continuityReference = await resolveRetainedVisualContinuityReference(continuityJob, "page_006");
  assert.equal(continuityReference?.pageId, "page_003");
  const continuityPrompt = buildVisualPromptsPayload(continuityJob, [{ pageId: "page_006", pageNumber: 6, path: path.join(styleLockSmokeDir, "source.png") }], {
    continuityReferenceImagePath: continuityPath,
    continuityReferencePageId: "page_003",
    continuityReferenceSha256: "continuity-sha",
    continuityStyleFingerprint: { palette: ["light-muted-gold"], brightness: "bright" }
  }).pages[0].prompt;
  assert.ok(continuityPrompt.includes("retained current-deck page"));
  assert.ok(continuityPrompt.includes("visual continuity reference"));
  assert.ok(continuityPrompt.includes("STYLE REFERENCE CONTENT EXCLUSION"));
  assert.ok(continuityPrompt.includes("light-muted-gold"));
  const customTypographyPrompt = buildVisualPromptsPayload({
    id: "workflow_custom_typography_smoke",
    artifacts: {
      codexPptStyle: {
        styleSpec: {
          typography: {
            roles: {
              content: { titlePt: [80, 90], subtitlePt: [38, 44], bodyPt: [26, 30], labelPt: [14, 18] }
            }
          }
        }
      }
    }
  }, [{ pageId: "page_001", pageNumber: 1, layout: "content" }]).pages[0].prompt;
  assert.ok(customTypographyPrompt.includes("title 80-90pt"));
  assert.ok(!customTypographyPrompt.includes("title 30-38pt"));
  const ocrHintsPath = path.join(styleLockSmokeDir, "source-ocr.json");
  fs.writeFileSync(ocrHintsPath, JSON.stringify({
    pages: [
      { pageId: "page_001", pageNumber: 1, ocrLines: [] },
      { pageId: "page_002", pageNumber: 2, ocrLines: [{ text: "Slide 2", confidence: 0.98 }, { text: "YOUR LOGO", confidence: 0.98 }, { text: "02 / 02", confidence: 0.98 }] }
    ]
  }));
  const normalizedPrompt = buildVisualPromptsPayload({
    id: "workflow_normalized_counter_smoke",
    artifacts: {
      visualSample: {
        path: approvedSamplePath,
        pageId: "page_001",
        pageNumber: 1,
        sha256: approvedSampleSha256,
        provider: "openai-compatible-image",
        dryRun: false
      },
      codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256: approvedSampleSha256 }],
      ocrTextHints: { path: ocrHintsPath },
      codexPptRerunGuidance: {
        page_002: { reasons: ["template-chrome-detected", "inconsistent-page-number-position"], note: "keep the master stable" }
      }
    }
  }, [
    { pageId: "page_001", pageNumber: 1, path: path.join(styleLockSmokeDir, "source-1.png") },
    { pageId: "page_002", pageNumber: 2, path: path.join(styleLockSmokeDir, "source-2.png") }
  ]).pages[1].prompt;
  assert.ok(normalizedPrompt.includes('render exactly "02 / 02" once'));
  assert.ok(normalizedPrompt.includes("SOURCE TEMPLATE CLEANUP"));
  assert.ok(normalizedPrompt.includes("Slide 2"));
  assert.ok(normalizedPrompt.includes("YOUR LOGO"));
  assert.ok(normalizedPrompt.includes("RERUN CORRECTION"));
  assert.ok(normalizedPrompt.includes("confirmed deck-wide master anchor"));
  assert.ok(!normalizedPrompt.includes("N/total page counters, YOUR BRAND"));
  const preservedCounterPrompt = buildVisualPromptsPayload({
    id: "workflow_preserved_counter_smoke",
    artifacts: {
      visualSample: {
        path: approvedSamplePath,
        pageId: "page_001",
        pageNumber: 1,
        sha256: approvedSampleSha256,
        provider: "openai-compatible-image",
        dryRun: false
      },
      codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256: approvedSampleSha256 }]
    }
  }, [
    { pageId: "page_001", pageNumber: 1, path: path.join(styleLockSmokeDir, "source-1.png") },
    { pageId: "page_002", pageNumber: 2, path: path.join(styleLockSmokeDir, "source-2.png") }
  ], { pageNumberPolicy: "preserve" }).pages[1].prompt;
  assert.ok(preservedCounterPrompt.includes("One intentional counter already present in the source is allowed"));
  assert.ok(!preservedCounterPrompt.includes("N/total page counters, YOUR BRAND"));
  const recordedPolicyPrompt = buildVisualPromptsPayload({
    id: "workflow_recorded_counter_policy_smoke",
    artifacts: {
      visualSample: {
        path: approvedSamplePath,
        pageId: "page_001",
        pageNumber: 1,
        sha256: approvedSampleSha256,
        provider: "openai-compatible-image",
        dryRun: false
      },
      codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256: approvedSampleSha256 }],
      codexPptStyle: { styleSpec: { master: { pageNumberPolicy: "preserve" } } },
      ocrTextHints: { path: ocrHintsPath }
    }
  }, [
    { pageId: "page_001", pageNumber: 1, path: path.join(styleLockSmokeDir, "source-1.png") },
    { pageId: "page_002", pageNumber: 2, path: path.join(styleLockSmokeDir, "source-2.png") }
  ]).pages[1].prompt;
  assert.ok(recordedPolicyPrompt.includes("One intentional counter already present in the source is allowed"));
  assert.ok(!recordedPolicyPrompt.includes('render exactly "02 / 02" once'));
  const noisyBrandOcrPath = path.join(styleLockSmokeDir, "source-brand-noise-ocr.json");
  fs.writeFileSync(noisyBrandOcrPath, JSON.stringify({
    pages: [
      { pageId: "page_001", pageNumber: 1, ocrLines: ["INOVANCE", "MICROSOFT", "PRODUCT", "ANALYTICS"].map((text) => ({ text, confidence: 0.98 })) },
      { pageId: "page_002", pageNumber: 2, ocrLines: ["INOVANCE", "MICROSOFT", "PRODUCT", "ANALYTICS"].map((text) => ({ text, confidence: 0.98 })) },
      { pageId: "page_003", pageNumber: 3, ocrLines: ["INOVANCE", "MICROSOFT", "PRODUCT", "ANALYTICS"].map((text) => ({ text, confidence: 0.98 })) },
      {
        pageId: "page_004",
        pageNumber: 4,
        ocrLines: [
          { text: "INOVANCE", confidence: 0.98 },
          { text: "NOVANCE", confidence: 0.91 },
          { text: "HNOVNOE", confidence: 0.9 },
          { text: "MICROSOFTAI", confidence: 0.96 },
          { text: "PRODUCTS", confidence: 0.96 },
          { text: "ANALYTIC", confidence: 0.96 },
          { text: "核心方案", confidence: 0.98 },
          { text: "120 套", confidence: 0.98 }
        ]
      }
    ]
  }));
  const brandNoisePrompt = buildVisualPromptsPayload({
    id: "workflow_source_brand_noise_smoke",
    artifacts: { ocrTextHints: { path: noisyBrandOcrPath } }
  }, Array.from({ length: 4 }, (_item, index) => ({
    pageId: `page_${String(index + 1).padStart(3, "0")}`,
    pageNumber: index + 1,
    path: path.join(styleLockSmokeDir, `brand-source-${index + 1}.png`)
  }))).pages[3].prompt;
  assert.ok(brandNoisePrompt.includes("INOVANCE"));
  assert.ok(brandNoisePrompt.includes("核心方案"));
  assert.ok(brandNoisePrompt.includes("120 套"));
  assert.ok(brandNoisePrompt.includes("MICROSOFTAI"));
  assert.ok(brandNoisePrompt.includes("PRODUCTS"));
  assert.ok(brandNoisePrompt.includes("ANALYTIC"));
  assert.doesNotMatch(brandNoisePrompt, /(?:^|\|\s*)NOVANCE(?:\s*\||\.)/);
  assert.ok(!brandNoisePrompt.includes("HNOVNOE"));
  const manualRequiredOcrPath = path.join(styleLockSmokeDir, "manual-required-brand-ocr.json");
  fs.writeFileSync(manualRequiredOcrPath, JSON.stringify({
    pages: [
      { pageId: "page_001", pageNumber: 1, ocrLines: [{ text: "INOVANCE", confidence: 0.98 }] },
      { pageId: "page_002", pageNumber: 2, ocrLines: [{ text: "INOVANCE", confidence: 0.98 }] },
      { pageId: "page_003", pageNumber: 3, ocrLines: [{ text: "INOVANCE", confidence: 0.98 }] },
      {
        pageId: "page_004",
        pageNumber: 4,
        requiredText: ["HNOVNOE", "HUMANOVERRIDE", "Thank You"],
        ocrLines: [
          { text: "HNOVNOE", confidence: 0.9, corrected: true },
          { text: "Thank You", confidence: 0.99, corrected: true }
        ]
      },
      { pageId: "page_005", pageNumber: 5, ocrLines: [{ text: "收尾说明", confidence: 0.98 }] }
    ]
  }));
  const manualRequiredPrompt = buildVisualPromptsPayload({
    id: "workflow_manual_required_brand_smoke",
    artifacts: { ocrTextHints: { path: manualRequiredOcrPath } }
  }, Array.from({ length: 5 }, (_item, index) => ({
    pageId: `page_${String(index + 1).padStart(3, "0")}`,
    pageNumber: index + 1
  }))).pages[3].prompt;
  assert.ok(manualRequiredPrompt.includes("HNOVNOE"));
  assert.ok(manualRequiredPrompt.includes("HUMANOVERRIDE"));
  assert.ok(manualRequiredPrompt.includes("Thank You"));
  assert.ok(!manualRequiredPrompt.includes("Remove these misleading terminal labels"));
  const denseTableOcrPath = path.join(styleLockSmokeDir, "dense-table-ocr.json");
  fs.writeFileSync(denseTableOcrPath, JSON.stringify({
    pages: [{
      pageId: "page_009",
      pageNumber: 9,
      ocrLines: [
        ...Array.from({ length: 22 }, (_item, index) => ({ text: `普通表格说明 ${index + 1}`, confidence: 0.98 })),
        { text: "https://item.jd.com/10224227783390.html", confidence: 0.99 }
      ]
    }]
  }));
  const denseTablePrompt = buildVisualPromptsPayload({
    id: "workflow_dense_table_prompt_smoke",
    artifacts: { ocrTextHints: { path: denseTableOcrPath } }
  }, [{ pageId: "page_009", pageNumber: 9, layout: "table" }]).pages[0].prompt;
  assert.ok(denseTablePrompt.includes("https://item.jd.com/10224227783390.html"));
  const staleOutlinePath = path.join(styleLockSmokeDir, "stale-source-outline.json");
  fs.writeFileSync(staleOutlinePath, JSON.stringify({
    version: 1,
    source: "frontend-upload-skill-first",
    layoutSequence: [
      { layout: "cover", title: "项目封面", evidence: "source-page-1", visualIntent: "参考源页类型：cover" },
      { layout: "cover", title: "Page 2", evidence: "source-page-2", visualIntent: "参考源页类型：cover" },
      { layout: "closing", title: "Page 3", evidence: "source-page-3", visualIntent: "参考源页类型：closing" }
    ]
  }));
  const repairedOutlinePages = mergeOutlineMetadata({
    artifacts: {
      source: { kind: "source", path: path.join(styleLockSmokeDir, "deck.pptx") },
      codexPptOutline: { path: staleOutlinePath }
    }
  }, [
    { pageId: "page_001", pageNumber: 1 },
    { pageId: "page_002", pageNumber: 2 },
    { pageId: "page_003", pageNumber: 3 }
  ]);
  assert.equal(repairedOutlinePages[0].layout, "cover");
  assert.equal(repairedOutlinePages[1].layout, "");
  assert.equal(repairedOutlinePages[1].visualIntent, "");
  assert.equal(repairedOutlinePages[1].outlineTitle, "");
  assert.equal(repairedOutlinePages[1].outlineEvidence, "");
  assert.equal(repairedOutlinePages[2].layout, "closing");
  assert.equal(repairedOutlinePages[2].visualIntent, "");
  const currentOutlinePath = path.join(styleLockSmokeDir, "current-source-outline.json");
  fs.writeFileSync(currentOutlinePath, JSON.stringify({
    version: 2,
    source: "workflow-outline",
    layoutSequence: [
      { layout: "cover", title: "项目封面" },
      { layout: "section", title: "章节一", visualIntent: "Use one image to cover the background" },
      { layout: "table", title: "报价汇总" }
    ]
  }));
  const currentOutlinePages = mergeOutlineMetadata({
    artifacts: {
      source: { kind: "source", path: path.join(styleLockSmokeDir, "deck.pptx") },
      codexPptOutline: { path: currentOutlinePath }
    }
  }, [
    { pageId: "page_001", pageNumber: 1 },
    { pageId: "page_002", pageNumber: 2 },
    { pageId: "page_003", pageNumber: 3 }
  ]);
  assert.equal(currentOutlinePages[1].layout, "section");
  assert.equal(currentOutlinePages[1].visualIntent, "Use one image to cover the background");
  const legacyRoleOutlinePath = path.join(styleLockSmokeDir, "legacy-role-outline.json");
  fs.writeFileSync(legacyRoleOutlinePath, JSON.stringify({
    version: 1,
    source: "frontend-upload-skill-first",
    layoutSequence: [
      { layout: "cover", title: "项目封面" },
      { layout: "section", title: "章节一" },
      { layout: "table", title: "报价汇总" },
      { layout: "closing", title: "谢谢" }
    ]
  }));
  const legacyRolePages = mergeOutlineMetadata({
    artifacts: {
      source: { kind: "source", path: path.join(styleLockSmokeDir, "deck.pptx") },
      codexPptOutline: { path: legacyRoleOutlinePath }
    }
  }, Array.from({ length: 4 }, (_item, index) => ({
    pageId: `page_${String(index + 1).padStart(3, "0")}`,
    pageNumber: index + 1
  })));
  assert.equal(legacyRolePages[1].layout, "section");
  assert.equal(legacyRolePages[2].layout, "table");
  assert.equal(legacyRolePages[3].layout, "closing");
  const legacyTableOutlinePath = path.join(styleLockSmokeDir, "legacy-table-outline.json");
  fs.writeFileSync(legacyTableOutlinePath, JSON.stringify({
    version: 1,
    source: "frontend-upload-skill-first",
    layoutSequence: [
      { layout: "cover" },
      { layout: "table" },
      { layout: "table" },
      { layout: "table" },
      { layout: "table" },
      { layout: "closing" }
    ]
  }));
  const legacyTablePages = mergeOutlineMetadata({
    artifacts: {
      source: { kind: "source", path: path.join(styleLockSmokeDir, "deck.pptx") },
      codexPptOutline: { path: legacyTableOutlinePath }
    }
  }, Array.from({ length: 6 }, (_item, index) => ({
    pageId: `page_${String(index + 1).padStart(3, "0")}`,
    pageNumber: index + 1
  })));
  assert.deepEqual(legacyTablePages.slice(1, 5).map((page) => page.layout), ["table", "table", "table", "table"]);
  const sourceRoleOcrPath = path.join(styleLockSmokeDir, "source-role-ocr.json");
  fs.writeFileSync(sourceRoleOcrPath, JSON.stringify({
    pages: [{
      pageId: "page_020",
      pageNumber: 20,
      ocrLines: ["Closing丨Us丨思", "Category", "Product content", "Parameter", "Quantity", "Price", "Total", "15000", "626.80"]
        .map((text) => ({ text, confidence: 0.98 }))
    }]
  }));
  const sourceRolePages = Array.from({ length: 20 }, (_item, index) => ({
    pageId: `page_${String(index + 1).padStart(3, "0")}`,
    pageNumber: index + 1,
    path: path.join(styleLockSmokeDir, `source-${index + 1}.png`),
    ...(index === 19 ? { layout: "closing", title: "Closing" } : {})
  }));
  const correctedSourceRolePrompt = buildVisualPromptsPayload({
    id: "workflow_source_role_smoke",
    artifacts: { ocrTextHints: { path: sourceRoleOcrPath } }
  }, sourceRolePages).pages[19];
  assert.equal(correctedSourceRolePrompt.role, "table");
  assert.ok(correctedSourceRolePrompt.prompt.includes("PAGE ROLE: table"));
  assert.ok(correctedSourceRolePrompt.prompt.includes("SOURCE ROLE CLEANUP"));
  assert.ok(correctedSourceRolePrompt.prompt.includes("Remove these misleading terminal labels"));
  const importedTitlePrompt = buildVisualPromptsPayload({
    id: "workflow_imported_title_authority_smoke",
    artifacts: {
      source: { kind: "source", path: path.join(styleLockSmokeDir, "deck.pptx") }
    }
  }, [{
    pageId: "page_002",
    pageNumber: 2,
    path: path.join(styleLockSmokeDir, "source-2.png"),
    outlineTitle: "\u573a\u666f\u3001\u7cbe\u5ea6\u3001\u613f\u529b"
  }]).pages[0].prompt;
  assert.ok(importedTitlePrompt.includes("OUTLINE PLANNING LABEL (not output copy)"));
  assert.ok(importedTitlePrompt.includes("Preserve the actual visible title in source image 1 exactly"));
  assert.ok(!importedTitlePrompt.includes("Slide title: \u573a\u666f\u3001\u7cbe\u5ea6\u3001\u613f\u529b"));
  fs.writeFileSync(approvedSamplePath, "sample-mutated-after-approval");
  assert.equal(isCodexPptSampleApprovalCurrent(approvedSampleJob), false);
} finally {
  fs.rmSync(styleLockSmokeDir, { recursive: true, force: true });
}

const makeStyleQa = ({ brightness, saturationDensity, edgeDensity, textLikeScore, titleEdgeDensity, hueCoverage = 0, hueHistogram = [], dominantHue = null }) => ({
  status: "pass",
  full: { brightness, saturationDensity, edgeDensity, textLikeScore, hueCoverage, hueHistogram, dominantHue },
  titleArea: { edgeDensity: titleEdgeDensity }
});
const twoPageStyleConsistency = buildDeckStyleConsistencyReport([
  { pageId: "page_001", pageNumber: 1, visualQa: makeStyleQa({ brightness: 0.79, saturationDensity: 0.52, edgeDensity: 0.05, textLikeScore: 0.014, titleEdgeDensity: 0.039 }) },
  { pageId: "page_002", pageNumber: 2, visualQa: makeStyleQa({ brightness: 0.87, saturationDensity: 0.15, edgeDensity: 0.13, textLikeScore: 0.055, titleEdgeDensity: 0.09 }) }
], makeStyleQa({ brightness: 0.79, saturationDensity: 0.53, edgeDensity: 0.05, textLikeScore: 0.014, titleEdgeDensity: 0.039 }));
assert.equal(twoPageStyleConsistency.status, "review");
assert.equal(twoPageStyleConsistency.baselineSource, "approved-visual-sample");
assert.deepEqual(twoPageStyleConsistency.driftPages.map((page) => page.pageId), ["page_002"]);
assert.ok(twoPageStyleConsistency.driftPages[0].reasons.includes("style-color-drift"));
const retainedReview = retainUnchangedImageDeckReviewMarks({
  status: "approved",
  marks: {
    page_006: { status: "pass", visualImageSha256: "same-sha" },
    page_009: { status: "rerun", visualImageSha256: "old-sha" }
  }
}, [
  { pageId: "page_006", pageNumber: 6, path: "page_006.png", sha256: "same-sha" },
  { pageId: "page_009", pageNumber: 9, path: "page_009.png", sha256: "new-sha" }
]);
assert.deepEqual(Object.keys(retainedReview.marks), ["page_006"]);
assert.equal(retainedReview.status, "in_progress");
assert.equal(retainedReview.summary.passCount, 1);
assert.equal(retainedReview.summary.readyForApproval, false);

const orangeHistogram = [0.05, 0.85, 0.1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const blueHistogram = [0, 0, 0, 0, 0, 0, 0, 0.05, 0.85, 0.1, 0, 0];
const hueDriftConsistency = buildDeckStyleConsistencyReport([
  { pageId: "page_003", pageNumber: 3, visualQa: makeStyleQa({ brightness: 0.79, saturationDensity: 0.52, edgeDensity: 0.05, textLikeScore: 0.014, titleEdgeDensity: 0.039, hueCoverage: 0.6, hueHistogram: blueHistogram, dominantHue: 240 }) }
], makeStyleQa({ brightness: 0.79, saturationDensity: 0.52, edgeDensity: 0.05, textLikeScore: 0.014, titleEdgeDensity: 0.039, hueCoverage: 0.6, hueHistogram: orangeHistogram, dominantHue: 30 }));
assert.equal(hueDriftConsistency.status, "review");
assert.ok(hueDriftConsistency.driftPages[0].reasons.includes("style-hue-drift"));
const adjacentOrangeLeft = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const adjacentOrangeRight = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const adjacentHueConsistency = buildDeckStyleConsistencyReport([
  { pageId: "page_004", pageNumber: 4, visualQa: makeStyleQa({ brightness: 0.79, saturationDensity: 0.52, edgeDensity: 0.05, textLikeScore: 0.014, titleEdgeDensity: 0.039, hueCoverage: 0.6, hueHistogram: adjacentOrangeRight, dominantHue: 60 }) }
], makeStyleQa({ brightness: 0.79, saturationDensity: 0.52, edgeDensity: 0.05, textLikeScore: 0.014, titleEdgeDensity: 0.039, hueCoverage: 0.6, hueHistogram: adjacentOrangeLeft, dominantHue: 30 }));
assert.equal(adjacentHueConsistency.status, "pass");

const styleGateSmokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-style-gate-smoke-"));
try {
  const qualityPath = path.join(styleGateSmokeDir, "visual_quality_report.json");
  const gateJob = {
    artifacts: {
      visualSample: { sha256: "sample-sha" },
      visualImages: [{ pageId: "page_002", pageNumber: 2, path: path.join(styleGateSmokeDir, "page_002.png"), sha256: "page-2-sha" }],
      visualQuality: { path: qualityPath }
    }
  };
  fs.writeFileSync(qualityPath, JSON.stringify({
    summary: {
      styleConsistency: {
        approvedSampleSha256: "sample-sha",
        driftPages: [{ pageId: "page_002", pageNumber: 2, reasons: ["style-hue-drift"] }]
      },
      semanticQuality: { complete: true, blockedCount: 0, blockedPageIds: [] }
    },
    pages: [{
      pageId: "page_002",
      pageNumber: 2,
      sha256: "page-2-sha",
      semanticQuality: { visualImageSha256: "page-2-sha", blockingReasons: [], reviewReasons: [] }
    }]
  }), "utf8");
  assert.doesNotThrow(() => assertVisualQualityAllowsReview(gateJob, "page_002"));
  const quality = JSON.parse(fs.readFileSync(qualityPath, "utf8"));
  quality.summary.styleConsistency.driftPages = [];
  fs.writeFileSync(qualityPath, JSON.stringify(quality), "utf8");
  assert.doesNotThrow(() => assertVisualQualityAllowsReview(gateJob, "page_002"));
  quality.summary.semanticQuality.blockedCount = 1;
  quality.pages[0].semanticQuality.blockingReasons = ["placeholder-text-detected"];
  quality.pages[0].blockingReasons = ["placeholder-text-detected"];
  fs.writeFileSync(qualityPath, JSON.stringify(quality), "utf8");
  assert.throws(() => assertVisualQualityAllowsReview(gateJob, "page_002"), (error) => error?.code === "IMAGE_DECK_SEMANTIC_QUALITY_BLOCKED");
  assert.doesNotThrow(() => assertVisualQualityAllowsReview(gateJob, "page_002", { allowSemanticBlocked: true }));
  quality.summary.semanticQuality.blockedCount = 0;
  quality.pages[0].semanticQuality.blockingReasons = [];
  quality.pages[0].blockingReasons = [];
  fs.writeFileSync(qualityPath, JSON.stringify(quality), "utf8");
  gateJob.artifacts.visualImages[0].sha256 = "changed-page-sha";
  assert.throws(() => assertVisualQualityAllowsReview(gateJob, "page_002"), (error) => error?.code === "IMAGE_DECK_VISUAL_QUALITY_STALE");
} finally {
  fs.rmSync(styleGateSmokeDir, { recursive: true, force: true });
}

const designSystem = getDesignSystem();
assert.equal(Object.hasOwn(designSystem, "templatePacks"), false);
assert.equal(Object.hasOwn(designSystem.skillRules, "oldDeck"), false);
assert.equal(Object.hasOwn(designSystem.skillRules, "templateReuse"), false);
assert.equal(Object.hasOwn(designSystem.skillRules, "templatePacks"), false);
assert.equal(getTemplatePack(EASTERN).slug, "skill-first-no-legacy-template");
assert.equal(getTemplatePackPrompt(TECH), "");
assert.equal(findLegacyStyleEvidence({ styleBrief: "轻盈渐变风" }), "轻盈渐变风");
assert.equal(findLegacyStyleEvidence({ styleBrief: "Premium clean business presentation" }), "");
const validStyleLockedTestEvidence = buildFullDeckTestEvidence({
  artifacts: {
    visualSample: { sha256: "sample-v1" },
    visualImages: [
      { pageId: "page_006", pageNumber: 6, path: "page_006.png", sha256: "sample-v1", imageInputMode: "source-page-edit", retainedApprovedSample: true },
      { pageId: "page_009", pageNumber: 9, path: "page_009.png", sha256: "page-9-v1", imageInputMode: "source-page-edit-plus-style-reference" }
    ],
    imageDeckReview: {
      status: "approved",
      summary: { totalPages: 2, passCount: 2, acceptCount: 0, allPagesReviewed: true, allMarksCurrent: true, readyForApproval: true },
      marks: {
        page_006: { status: "pass", visualImageSha256: "sample-v1" },
        page_009: { status: "pass", visualImageSha256: "page-9-v1" }
      },
      approvedAt: "2026-08-07T00:00:00.000Z"
    }
  }
});
assert.equal(validStyleLockedTestEvidence.pages.filter((page) => page.styleAuthority).length, 1);
assert.equal(validStyleLockedTestEvidence.pages.filter((page) => page.imageInputMode === "source-page-edit-plus-style-reference").length, 1);
assert.throws(() => buildFullDeckTestEvidence({
  artifacts: {
    visualSample: { sha256: "sample-v1" },
    visualImages: [
      { pageId: "page_006", pageNumber: 6, path: "page_006.png", sha256: "sample-v1", imageInputMode: "source-page-edit" },
      { pageId: "page_009", pageNumber: 9, path: "page_009.png", sha256: "page-9-v1", imageInputMode: "source-page-edit-plus-style-reference" }
    ],
    imageDeckReview: {
      status: "approved",
      summary: { totalPages: 2, passCount: 2, acceptCount: 0, allPagesReviewed: true, allMarksCurrent: true, readyForApproval: true },
      marks: {
        page_006: { status: "pass", visualImageSha256: "sample-v1" },
        page_009: { status: "pass", visualImageSha256: "page-9-v1" }
      }
    }
  }
}), (error) => error?.code === "CODEX_PPT_TWO_PAGE_TEST_REQUIRED");
const currentTwoPageApprovalJob = {
  artifacts: {
    visualSample: { sha256: "sample-v1" },
    visualImages: [
      { pageId: "page_001", pageNumber: 1, path: "page_001.png", sha256: "page-1-v1" },
      { pageId: "page_002", pageNumber: 2, path: "page_002.png", sha256: "page-2-v1" }
    ],
    codexPptApprovals: [{
      gate: "fullDeck",
      status: "approved",
      testDeck: {
        version: 1,
        sampleSha256: "sample-v1",
        pages: [
          { pageId: "page_001", pageNumber: 1, sha256: "page-1-v1" },
          { pageId: "page_002", pageNumber: 2, sha256: "page-2-v1" }
        ]
      }
    }]
  }
};
assert.equal(isCodexPptFullDeckApprovalCurrent(currentTwoPageApprovalJob), true);
assert.equal(isCodexPptFullDeckApprovalCurrent({
  artifacts: { ...currentTwoPageApprovalJob.artifacts, visualSample: { sha256: "sample-v2" } }
}), false);
assert.equal(isCodexPptSampleApprovalCurrent({
  artifacts: {
    visualSample: { sha256: "sample-v1" },
    codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256: "sample-v1" }]
  }
}), false);
assert.equal(isCodexPptSampleApprovalCurrent({
  artifacts: {
    visualSample: { sha256: "sample-v2" },
    codexPptApprovals: [{ gate: "sample", status: "approved", sampleSha256: "sample-v1" }]
  }
}), false);
assert.equal(isCodexPptFullDeckApprovalCurrent({
  artifacts: {
    ...currentTwoPageApprovalJob.artifacts,
    visualImages: [
      currentTwoPageApprovalJob.artifacts.visualImages[0],
      { ...currentTwoPageApprovalJob.artifacts.visualImages[1], sha256: "page-2-v2" }
    ]
  }
}), false);

const buildDeliveryReviewArtifacts = ({ blockedPageIds = [], styleDriftPageIds = [] } = {}) => {
  const pageIds = ["page_001", "page_002", "page_003", "page_004"];
  const visualImages = pageIds.map((pageId, index) => ({
    pageId,
    pageNumber: index + 1,
    path: `visual/${pageId}.png`,
    sha256: `${pageId}-sha`
  }));
  const blocked = new Set(blockedPageIds);
  const styleDrift = new Set(styleDriftPageIds);
  const marks = Object.fromEntries(pageIds.map((pageId) => {
    const needsAcceptance = blocked.has(pageId) || styleDrift.has(pageId);
    return [pageId, {
      pageId,
      status: needsAcceptance ? "accept" : "pass",
      visualImagePath: `visual/${pageId}.png`,
      visualImageSha256: `${pageId}-sha`,
      visualTextQualityPageEvidenceSha256: `${pageId}-evidence`,
      visualQualityEvidenceSha256: "delivery-style-evidence",
      semanticRiskAccepted: blocked.has(pageId),
      styleDriftAccepted: styleDrift.has(pageId)
    }];
  }));
  const acceptCount = Object.values(marks).filter((mark) => mark.status === "accept").length;
  return {
    visualSample: { sha256: "delivery-sample-sha" },
    visualImages,
    imageDeck: { path: "image-deck.pptx", pageCount: 4 },
    visualTextQuality: {
      path: "visual-text-quality.json",
      evidenceSha256: "delivery-semantic-evidence",
      summary: { complete: true, blockedCount: blockedPageIds.length, blockedPageIds },
      pageEvidenceSha256ByPage: Object.fromEntries(pageIds.map((pageId) => [pageId, `${pageId}-evidence`]))
    },
    visualQuality: {
      path: "visual-quality.json",
      evidenceSha256: "delivery-style-evidence",
      approvedSampleSha256: "delivery-sample-sha",
      pageImageSha256ByPage: Object.fromEntries(pageIds.map((pageId) => [pageId, `${pageId}-sha`])),
      summary: {
        semanticQuality: { complete: true, blockedCount: blockedPageIds.length, blockedPageIds },
        styleConsistency: {
          approvedSampleSha256: "delivery-sample-sha",
          driftPages: styleDriftPageIds.map((pageId) => ({ pageId, reasons: ["style-color-drift"] }))
        }
      }
    },
    imageDeckReview: {
      status: "approved",
      summary: {
        totalPages: 4,
        passCount: 4 - acceptCount,
        acceptCount,
        allPagesReviewed: true,
        allMarksCurrent: true,
        readyForApproval: true
      },
      marks
    }
  };
};

const persistedReviewJob = {
  artifacts: {
    visualImages: [{ pageId: "page_001", pageNumber: 1, path: "visual/page_001.png", sha256: "page-1-sha" }],
    visualQuality: {
      evidenceSha256: "style-evidence-v1",
      summary: {
        styleConsistency: {
          approvedSampleSha256: "sample-v1",
          driftPages: [{ pageId: "page_001", reasons: ["style-color-drift"] }]
        }
      }
    },
    imageDeckReview: {
      status: "approved",
      marks: {
        page_001: {
          pageId: "page_001",
          status: "accept",
          visualImagePath: "visual/page_001.png",
          visualImageSha256: "page-1-sha",
          visualTextQualityPageEvidenceSha256: "page-1-evidence",
          visualQualityEvidenceSha256: "style-evidence-v1",
          semanticRiskAccepted: true,
          styleDriftAccepted: true
        }
      },
      summary: {
        totalPages: 1,
        passCount: 0,
        acceptCount: 1,
        allPagesReviewed: true,
        allMarksCurrent: true,
        readyForApproval: true
      }
    }
  }
};
reconcileImageDeckReviewEvidence(persistedReviewJob, {
  evidenceSha256: "semantic-report-v2",
  pageEvidenceSha256ByPage: { page_001: "page-1-evidence" }
}, {
  blockedCount: 1,
  blockedPageIds: ["page_001"]
});
assert.equal(persistedReviewJob.artifacts.imageDeckReview.status, "approved");
assert.equal(persistedReviewJob.artifacts.imageDeckReview.summary.readyForApproval, true);
assert.equal(persistedReviewJob.artifacts.imageDeckReview.summary.allMarksCurrent, true);

const persistedReviewIntegrationDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-review-rebuild-smoke-"));
try {
  const sourceHintsPath = path.join(persistedReviewIntegrationDir, "source-hints.json");
  const visualHintsPath = path.join(persistedReviewIntegrationDir, "visual-hints.json");
  const visualQualityPath = path.join(persistedReviewIntegrationDir, "visual-quality.json");
  const sourceLine = { text: "INOVANCE", confidence: 0.99, native_text: true, box_px: [80, 80, 260, 56], font_pt_if_cjk: 28 };
  const visualLine = { text: "INOVANCE", confidence: 0.98, box_px: [80, 80, 260, 56], font_pt_if_cjk: 28 };
  fs.writeFileSync(sourceHintsPath, JSON.stringify({ pages: [{ pageId: "page_001", pageNumber: 1, ocrLines: [sourceLine] }] }));
  fs.writeFileSync(visualHintsPath, JSON.stringify({ pages: [{ pageId: "page_001", pageNumber: 1, imageSha256: "visual-v1", ocrLines: [visualLine] }] }));
  fs.writeFileSync(visualQualityPath, JSON.stringify({
    kind: "visual_quality_report",
    version: 2,
    status: "pass",
    summary: {
      styleConsistency: {
        baselineSource: "approved-visual-sample",
        approvedSampleSha256: "sample-v1",
        baseline: null,
        driftPages: []
      }
    },
    pages: [{
      pageId: "page_001",
      pageNumber: 1,
      sha256: "visual-v1",
      status: "pass",
      blockingReasons: [],
      manualReviewReasons: [],
      visualQa: { status: "pass" }
    }]
  }));
  const integrationJob = {
    dirs: { visualImages: persistedReviewIntegrationDir },
    artifacts: {
      visualSample: { sha256: "sample-v1" },
      visualImages: [{ pageId: "page_001", pageNumber: 1, path: "visual/page_001.png", sha256: "visual-v1" }],
      ocrTextHints: { path: sourceHintsPath },
      visualOcrTextHints: { path: visualHintsPath },
      visualQuality: { path: visualQualityPath }
    }
  };
  await writeWorkflowVisualTextQualityReport(integrationJob);
  const firstEvidence = integrationJob.artifacts.visualTextQuality.pageEvidenceSha256ByPage.page_001;
  integrationJob.artifacts.imageDeckReview = {
    status: "approved",
    marks: {
      page_001: {
        pageId: "page_001",
        status: "pass",
        visualImagePath: "visual/page_001.png",
        visualImageSha256: "visual-v1",
        visualTextQualityPageEvidenceSha256: firstEvidence,
        visualQualityEvidenceSha256: integrationJob.artifacts.visualQuality.evidenceSha256
      }
    },
    summary: { totalPages: 1, passCount: 1, acceptCount: 0, allPagesReviewed: true, allMarksCurrent: true, readyForApproval: true }
  };
  await writeWorkflowVisualTextQualityReport(integrationJob);
  assert.equal(integrationJob.artifacts.imageDeckReview.status, "approved");
  assert.equal(integrationJob.artifacts.imageDeckReview.summary.readyForApproval, true);
  assert.equal(integrationJob.artifacts.visualQuality.pageImageSha256ByPage.page_001, "visual-v1");
  assert.equal(integrationJob.artifacts.visualQuality.approvedSampleSha256, "sample-v1");
} finally {
  fs.rmSync(persistedReviewIntegrationDir, { recursive: true, force: true });
}

const derivedWorkerStatus = deriveWorkflowDeliveryStatus({
  sourceMeta: { pageCount: 4 },
  artifacts: {
    renderedPages: [{}, {}, {}, {}],
    ...buildDeliveryReviewArtifacts(),
    editableRun: { path: "run" },
    editableWorkerTasks: [
      { pageId: "page_001", status: "recorded" },
      { pageId: "page_002", status: "ready" },
      { pageId: "page_004", status: "ready" }
    ],
    externalImageSpendAuthorizations: []
  }
});
assert.equal(derivedWorkerStatus.nextStep.id, "start-page-workers");
assert.deepEqual(derivedWorkerStatus.nextStep.pages, ["page_002", "page_004"]);
assert.equal(derivedWorkerStatus.nextStep.pageSelection, "page_002,page_004");
assert.equal(derivedWorkerStatus.nextStep.externalImageCalls, 16);
assert.equal(derivedWorkerStatus.nextStep.authorization.required, true);
const blockedImageDeckDeliveryStatus = deriveWorkflowDeliveryStatus({
  sourceMeta: { pageCount: 4 },
  artifacts: {
    renderedPages: [{}, {}, {}, {}],
    visualImages: [{}, {}, {}, {}],
    imageDeck: { pageCount: 4 },
    visualTextQuality: { summary: { complete: true, blockedCount: 2, blockedPageIds: ["page_002", "page_004"] } },
    imageDeckReview: { status: "in_progress", summary: { totalPages: 4, readyForApproval: false } },
    editableRun: { path: "run" },
    editableWorkerTasks: [{ pageId: "page_002", status: "ready" }, { pageId: "page_004", status: "ready" }]
  }
});
assert.equal(blockedImageDeckDeliveryStatus.level, "blocked");
assert.equal(blockedImageDeckDeliveryStatus.nextStep.id, "review-image-deck");
assert.equal(blockedImageDeckDeliveryStatus.nextStep.externalImageCalls, undefined);
assert.ok(!blockedImageDeckDeliveryStatus.nextActions.some((action) => action.includes("可编辑重建批处理")));
const acceptedImageDeckRiskDeliveryStatus = deriveWorkflowDeliveryStatus({
  sourceMeta: { pageCount: 4 },
  artifacts: {
    renderedPages: [{}, {}, {}, {}],
    ...buildDeliveryReviewArtifacts({ blockedPageIds: ["page_002", "page_004"] })
  }
});
assert.equal(acceptedImageDeckRiskDeliveryStatus.level, "working");
assert.equal(acceptedImageDeckRiskDeliveryStatus.nextStep.id, "prepare-editable");
assert.ok(acceptedImageDeckRiskDeliveryStatus.warnings.some((warning) => warning.includes("自动内容风险已由人工逐页确认")));

const imageDeckQualityDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-agent-image-deck-quality-"));
const imageDeckQualityPath = path.join(imageDeckQualityDir, "visual-quality.json");
const writeImageDeckQuality = (styleConsistency = {}, semanticQuality = {}, pageSemantic = {}) => fs.writeFileSync(imageDeckQualityPath, JSON.stringify({
  summary: {
    styleConsistency: { approvedSampleSha256: "sample-current", driftPages: [], ...styleConsistency },
    semanticQuality: { complete: true, blockedCount: 0, blockedPageIds: [], ...semanticQuality }
  },
  pages: [
    {
      pageId: "page_001",
      sha256: "sha1",
      semanticQuality: { visualImageSha256: "sha1", evidenceSha256: "page-evidence-1", blockingReasons: [], reviewReasons: [], ...(pageSemantic.page_001 || {}) }
    },
    {
      pageId: "page_002",
      sha256: "sha2",
      semanticQuality: { visualImageSha256: "sha2", evidenceSha256: "page-evidence-2", blockingReasons: [], reviewReasons: [], ...(pageSemantic.page_002 || {}) }
    }
  ]
}));
writeImageDeckQuality();
const approvedImageDeckArtifacts = {
  visualSample: { sha256: "sample-current" },
  visualQuality: { path: imageDeckQualityPath, evidenceSha256: "style-evidence-v1" },
  visualTextQuality: {
    evidenceSha256: "semantic-evidence-v2",
    pageEvidenceSha256ByPage: { page_001: "page-evidence-1", page_002: "page-evidence-2" }
  },
  visualImages: [
    { pageId: "page_001", path: "visual/page_001.png", sha256: "sha1" },
    { pageId: "page_002", path: "visual/page_002.png", sha256: "sha2" }
  ],
  imageDeckReview: {
    status: "approved",
    summary: { totalPages: 2, passCount: 2, allPagesReviewed: true, allMarksCurrent: true, readyForApproval: true },
    marks: {
      page_001: { status: "pass", visualImagePath: "visual/page_001.png", visualImageSha256: "sha1", visualTextQualityPageEvidenceSha256: "page-evidence-1", visualQualityEvidenceSha256: "style-evidence-v1" },
      page_002: { status: "pass", visualImagePath: "visual/page_002.png", visualImageSha256: "sha2", visualTextQualityPageEvidenceSha256: "page-evidence-2", visualQualityEvidenceSha256: "style-evidence-v1" }
    }
  }
};
assert.equal(isImageDeckReviewApproved(approvedImageDeckArtifacts), true);
const partialApprovedImageDeckArtifacts = {
  ...approvedImageDeckArtifacts,
  renderedPages: Array.from({ length: 20 }, (_item, index) => ({
    pageId: `page_${String(index + 1).padStart(3, "0")}`,
    pageNumber: index + 1
  })),
  imageDeck: { path: "partial-image-deck.pptx", pageCount: 2 }
};
assert.equal(isImageDeckReviewApproved(partialApprovedImageDeckArtifacts), false);
assert.equal(isImageDeckReviewApproved(approvedImageDeckArtifacts, { expectedPages: 20 }), false);
assert.throws(() => assertWorkflowImageDeckReviewReady({
  sourceMeta: { pageCount: 20 },
  artifacts: approvedImageDeckArtifacts
}), /must be approved/i);
const partialApprovedDelivery = deriveWorkflowDeliveryStatus({
  sourceMeta: { pageCount: 20 },
  artifacts: partialApprovedImageDeckArtifacts
});
assert.equal(partialApprovedDelivery.nextStep.id, "continue-image-deck");
assert.notEqual(partialApprovedDelivery.nextStep.id, "prepare-editable");
const qualityBoundImageDeckArtifacts = {
  ...approvedImageDeckArtifacts,
  visualTextQuality: { ...approvedImageDeckArtifacts.visualTextQuality, evidenceSha256: "semantic-evidence-v2" },
  imageDeckReview: {
    ...approvedImageDeckArtifacts.imageDeckReview,
    marks: Object.fromEntries(Object.entries(approvedImageDeckArtifacts.imageDeckReview.marks).map(([pageId, mark]) => [pageId, {
      ...mark,
      visualTextQualityEvidenceSha256: "semantic-evidence-v2"
    }]))
  }
};
assert.equal(isImageDeckReviewApproved(qualityBoundImageDeckArtifacts), true);
assert.equal(isImageDeckReviewApproved({
  ...qualityBoundImageDeckArtifacts,
  imageDeckReview: {
    ...qualityBoundImageDeckArtifacts.imageDeckReview,
    marks: {
      ...qualityBoundImageDeckArtifacts.imageDeckReview.marks,
      page_001: {
        ...qualityBoundImageDeckArtifacts.imageDeckReview.marks.page_001,
        visualTextQualityPageEvidenceSha256: "page-evidence-stale"
      }
    }
  }
}), false);
assert.equal(isImageDeckReviewApproved({
  ...qualityBoundImageDeckArtifacts,
  visualQuality: { ...qualityBoundImageDeckArtifacts.visualQuality, evidenceSha256: "style-evidence-v2" }
}), false);
assert.equal(isImageDeckReviewApproved({
  ...approvedImageDeckArtifacts,
  visualImages: approvedImageDeckArtifacts.visualImages.map((image, index) => index === 0 ? { ...image, sha256: "" } : image)
}), false);
assert.equal(isImageDeckReviewApproved({
  ...approvedImageDeckArtifacts,
  imageDeckReview: {
    ...approvedImageDeckArtifacts.imageDeckReview,
    marks: {
      ...approvedImageDeckArtifacts.imageDeckReview.marks,
      page_001: { ...approvedImageDeckArtifacts.imageDeckReview.marks.page_001, visualImageSha256: "" }
    }
  }
}), false);
writeImageDeckQuality({ driftPages: [{ pageId: "page_002", pageNumber: 2, reasons: ["style-color-drift"] }] });
const styleDriftImageDeckArtifacts = {
  ...approvedImageDeckArtifacts,
  visualQuality: {
    path: imageDeckQualityPath,
    evidenceSha256: "style-evidence-v1",
    styleConsistency: {
      driftPages: [{ pageId: "page_002", pageNumber: 2, reasons: ["style-color-drift"] }]
    }
  },
  imageDeckReview: {
    ...approvedImageDeckArtifacts.imageDeckReview,
    summary: { ...approvedImageDeckArtifacts.imageDeckReview.summary, passCount: 1, acceptCount: 1 },
    marks: {
      ...approvedImageDeckArtifacts.imageDeckReview.marks,
      page_002: {
        status: "accept",
        styleDriftAccepted: true,
        visualImagePath: "visual/page_002.png",
        visualImageSha256: "sha2",
        visualTextQualityPageEvidenceSha256: "page-evidence-2",
        visualQualityEvidenceSha256: "style-evidence-v1"
      }
    }
  }
};
assert.equal(isImageDeckReviewApproved(styleDriftImageDeckArtifacts), true);
const unacceptedStyleDriftArtifacts = {
  ...styleDriftImageDeckArtifacts,
  imageDeck: { path: "image-deck.pptx", pageCount: 2 },
  visualTextQuality: {
    ...styleDriftImageDeckArtifacts.visualTextQuality,
    summary: { complete: true, blockedCount: 0, blockedPageIds: [] }
  },
  visualQuality: {
    ...styleDriftImageDeckArtifacts.visualQuality,
    approvedSampleSha256: "sample-current",
    pageImageSha256ByPage: { page_001: "sha1", page_002: "sha2" },
    summary: {
      semanticQuality: { complete: true, blockedCount: 0, blockedPageIds: [] },
      styleConsistency: {
        approvedSampleSha256: "sample-current",
        driftPages: [{ pageId: "page_002", pageNumber: 2, reasons: ["style-color-drift"] }]
      }
    }
  },
  imageDeckReview: {
    ...approvedImageDeckArtifacts.imageDeckReview,
    summary: { ...approvedImageDeckArtifacts.imageDeckReview.summary, passCount: 2, acceptCount: 0 },
    marks: approvedImageDeckArtifacts.imageDeckReview.marks
  }
};
assert.equal(isImageDeckReviewApproved(unacceptedStyleDriftArtifacts), false);
const unacceptedStyleDriftDelivery = deriveWorkflowDeliveryStatus({
  sourceMeta: { pageCount: 2 },
  artifacts: {
    renderedPages: [{}, {}],
    editableRun: { path: "run" },
    editableWorkerTasks: [{ pageId: "page_001", status: "ready" }, { pageId: "page_002", status: "ready" }],
    ...unacceptedStyleDriftArtifacts
  }
});
assert.equal(unacceptedStyleDriftDelivery.nextStep.id, "review-image-deck");
assert.equal(unacceptedStyleDriftDelivery.level, "working");
writeImageDeckQuality(
  {},
  { blockedCount: 1, blockedPageIds: ["page_001"] },
  { page_001: { blockingReasons: ["critical-brand-or-code-missing"] } }
);
const humanAcceptedSemanticRiskArtifacts = {
  ...approvedImageDeckArtifacts,
  imageDeckReview: {
    ...approvedImageDeckArtifacts.imageDeckReview,
    summary: { ...approvedImageDeckArtifacts.imageDeckReview.summary, passCount: 1, acceptCount: 1 },
    marks: {
      ...approvedImageDeckArtifacts.imageDeckReview.marks,
      page_001: {
        ...approvedImageDeckArtifacts.imageDeckReview.marks.page_001,
        status: "accept",
        semanticRiskAccepted: true,
        semanticBlockingReasons: ["critical-brand-or-code-missing"]
      }
    }
  }
};
assert.equal(isImageDeckReviewApproved(humanAcceptedSemanticRiskArtifacts), true);
assert.equal(isImageDeckReviewApproved({
  ...humanAcceptedSemanticRiskArtifacts,
  imageDeckReview: {
    ...humanAcceptedSemanticRiskArtifacts.imageDeckReview,
    marks: {
      ...humanAcceptedSemanticRiskArtifacts.imageDeckReview.marks,
      page_001: { ...humanAcceptedSemanticRiskArtifacts.imageDeckReview.marks.page_001, semanticRiskAccepted: false }
    }
  }
}), false);
assert.equal(isImageDeckReviewApproved({
  ...approvedImageDeckArtifacts,
  visualQuality: {}
}), false);
fs.writeFileSync(imageDeckQualityPath, JSON.stringify({
  summary: { styleConsistency: { approvedSampleSha256: "sample-old", driftPages: [] } },
  pages: [
    { pageId: "page_001", sha256: "sha1" },
    { pageId: "page_002", sha256: "sha2" }
  ]
}));
assert.equal(isImageDeckReviewApproved({
  ...approvedImageDeckArtifacts,
  visualQuality: { path: imageDeckQualityPath }
}), false);
writeImageDeckQuality({ driftPages: [{ pageId: "page_002", pageNumber: 2, reasons: ["style-color-drift"] }] });
assert.equal(isImageDeckReviewApproved({
  ...styleDriftImageDeckArtifacts,
  imageDeckReview: {
    ...styleDriftImageDeckArtifacts.imageDeckReview,
    summary: { ...styleDriftImageDeckArtifacts.imageDeckReview.summary, passCount: 2, acceptCount: 0 },
    marks: approvedImageDeckArtifacts.imageDeckReview.marks
  }
}), false);
assert.equal(isImageDeckReviewApproved({
  ...styleDriftImageDeckArtifacts,
  imageDeckReview: {
    ...styleDriftImageDeckArtifacts.imageDeckReview,
    marks: {
      ...styleDriftImageDeckArtifacts.imageDeckReview.marks,
      page_002: { ...styleDriftImageDeckArtifacts.imageDeckReview.marks.page_002, styleDriftAccepted: false }
    }
  }
}), false);
writeImageDeckQuality();
assert.equal(isImageDeckReviewApproved({
  ...approvedImageDeckArtifacts,
  imageDeckReview: {
    ...approvedImageDeckArtifacts.imageDeckReview,
    summary: { ...approvedImageDeckArtifacts.imageDeckReview.summary, readyForApproval: false }
  }
}), false);
assert.equal(isImageDeckReviewApproved({
  ...approvedImageDeckArtifacts,
  imageDeckReview: {
    ...approvedImageDeckArtifacts.imageDeckReview,
    marks: {
      ...approvedImageDeckArtifacts.imageDeckReview.marks,
      page_002: { status: "pass", visualImagePath: "visual/page_002.png", visualImageSha256: "old" }
    }
  }
}), false);
fs.rmSync(imageDeckQualityDir, { recursive: true, force: true });
assert.equal(derivedWorkerStatus.nextStep.authorization.persisted, false);

assert.equal(isFinalPptxProductReady({ productReady: true }), true);
assert.equal(isFinalPptxProductReady({ downloadable: true }), false);
assert.equal(isFinalPptxProductReady({ productReady: false, downloadable: true }), false);

assert.doesNotThrow(() => assertEditableDispatchAllowed({ stage: "dispatch_pages", pages: ["page_001"] }, "page_001"));
assert.doesNotThrow(() => assertEditableDispatchAllowed({ stage: "rebuild_page_locally", pageId: "page_001" }, "page_001", { localMode: true }));
assert.throws(
  () => assertEditableDispatchAllowed({ stage: "record_pages", pages: ["page_001"] }, "page_001"),
  /expected next stage dispatch_pages/
);
assert.throws(
  () => assertEditableDispatchAllowed({ stage: "dispatch_pages", pages: ["page_002"] }, "page_001"),
  /not in the current editppt dispatch set/
);

const brief = buildMaterialBrief([
  {
    name: "\u8f93\u5165\u8bf4\u660e",
    text: "\u7aef\u5348\u793c\u76d2\u552e\u4ef7 39\u5143\u300159\u5143\u3001159\u5143\u3002\u4e3b\u63a8\u4f4e\u7cd6\u7cbd\u793c\u76d2\u548c\u9ad8\u7aef\u6ecb\u8865\u793c\u76d2\uff0c\u89c4\u683c 300x200x80mm\u3002\u9002\u5408\u5458\u5de5\u798f\u5229\u3001\u5ba2\u6237\u62dc\u8bbf\u3001\u8282\u65e5\u793c\u8d60\u3002"
  }
]);

assert.deepEqual(brief.prices.slice(0, 3), ["39\u5143", "59\u5143", "159\u5143"]);
assert.ok(brief.productCandidates.includes("\u4f4e\u7cd6\u7cbd\u793c\u76d2"));
assert.ok(brief.productCandidates.includes("\u9ad8\u7aef\u6ecb\u8865\u793c\u76d2"));
assert.deepEqual(brief.dimensions, ["300x200x80mm"]);
assert.equal(brief.inputStrength, "strong");

const weakBrief = buildMaterialBrief([
  { name: "\u793c\u76d2\u4e3b\u56fe.png", text: "\u56fe\u7247\u7d20\u6750\u5df2\u4e0a\u4f20\uff1a\u793c\u76d2\u4e3b\u56fe.png\u3002\u751f\u6210\u65f6\u8bf7\u4e3a\u5176\u9884\u7559\u56fe\u7247\u69fd\u4f4d\u3002" },
  { name: "\u8f93\u5165\u8bf4\u660e", text: "\u9879\u76ee\u540d\u79f0\uff1a\u7aef\u5348\u793c\u76d2\n\u8865\u5145\u8bf4\u660e\uff1a\u505a\u4e00\u4efd\u7ed9\u9500\u552e\u56e2\u961f\u7528\u7684\u4ea7\u54c1\u6218\u5361\u3002" }
]);
assert.equal(weakBrief.inputStrength, "weak");
assert.equal(weakBrief.imageCount, 1);
assert.ok(weakBrief.confirmationFields.includes("\u4ef7\u683c/\u62a5\u4ef7/\u9884\u7b97\u6863\u4f4d"));

const weakRoute = routeDeck({ input: { pageCount: SYSTEM_RECOMMEND }, materialBrief: weakBrief, uploads: [{ originalName: "\u793c\u76d2\u4e3b\u56fe.png", mimeType: "image/png" }] });
assert.equal(weakRoute.inputStrength, "weak");
assert.ok(weakRoute.layoutSequence.some((step) => step.layout === "visual"));
assert.ok(weakRoute.layoutSequence.some((step) => step.storyRole === "\u5f85\u786e\u8ba4\u4fe1\u606f"));

const giftRoute = routeDeck({
  input: { pageCount: SYSTEM_RECOMMEND, style: EASTERN },
  materialBrief: weakBrief,
  uploads: [{ originalName: "\u793c\u76d2\u4e3b\u56fe.png", mimeType: "image/png" }]
});
assert.equal(giftRoute.templatePack.slug, "skill-first-no-legacy-template");
assert.equal(giftRoute.layoutSequence[1].layout, "visual");

const techRoute = routeDeck({
  input: { pageCount: "12", style: TECH, notes: "\u6280\u672f\u65b9\u6848 \u6570\u636e\u6c47\u62a5 KPI \u5206\u6790" },
  materialBrief: brief,
  uploads: []
});
assert.equal(techRoute.templatePack.slug, "skill-first-no-legacy-template");
assert.ok(techRoute.layoutSequence.some((step) => step.layout === "pricing"));

const oldDeckBrief = buildMaterialBrief([{ name: "case.pptx", text: "cover\nprice 39 59 159\nrisk delivery complaint\ncategory matrix" }]);
oldDeckBrief.sourceReport = {
  hasOldDeck: true,
  aestheticDiagnosis: {
    overallScore: 60,
    lowScoreSlides: [2],
    highDensitySlides: [3],
    slides: [
      { page: 1, type: "cover", diagnosisScore: 82, layoutStrategy: "cover_hero" },
      { page: 2, type: "product_cost", diagnosisScore: 55, layoutStrategy: "cost_cards" },
      { page: 3, type: "project_review", diagnosisScore: 64, layoutStrategy: "review_four_blocks" }
    ]
  }
};
oldDeckBrief.pages = [
  { page: 1, title: "Source cover", text: "cover", sourceSlideType: "cover", diagnosisScore: 82, layoutStrategy: "cover_hero" },
  { page: 2, title: "Source price", text: "price 39 59 159", sourceSlideType: "product_cost", diagnosisScore: 55, layoutStrategy: "cost_cards" },
  { page: 3, title: "Source risk", text: "risk delivery complaint", sourceSlideType: "project_review", diagnosisScore: 64, layoutStrategy: "review_four_blocks" },
  { page: 4, title: "Source matrix", text: "category matrix", sourceSlideType: "category_matrix", diagnosisScore: 74, layoutStrategy: "category_matrix" }
];
const oldDeckRoute = routeDeck({ mode: "optimize", input: { pageCount: SYSTEM_RECOMMEND }, materialBrief: oldDeckBrief, uploads: [{ originalName: "case.pptx" }] });
assert.equal(oldDeckRoute.sourceReport.aestheticDiagnosis.overallScore, 60);
assert.ok(oldDeckRoute.layoutSequence.some((step) => step.sourceSlideType === "product_cost" && step.layout === "pricing"));
assert.ok(oldDeckRoute.layoutSequence.some((step) => step.sourceSlideType === "project_review" && step.layout === "risk-checklist"));
assert.equal(oldDeckRoute.templateReusePlan.status, "removed");
assert.equal(oldDeckRoute.layoutSequence.some((step) => step.templateReuse), false);
const pptUploadDeck = validateDeck({
  title: "Uploaded PPT rewrite",
  slides: oldDeckBrief.pages.map((page) => ({
    title: page.title,
    layout: page.sourceSlideType === "cover" ? "cover" : page.sourceSlideType === "category_matrix" ? "cards" : "visual",
    bullets: [page.text],
    sourceSlideType: page.sourceSlideType
  }))
}, oldDeckRoute).deck;
const pptUploadJob = {
  id: "smoke_uploaded_ppt_visual_project",
  mode: "optimize",
  input: { routePlan: oldDeckRoute, materialBrief: oldDeckBrief },
  deck: pptUploadDeck,
  files: [{ id: "upload_ppt_1", originalName: "case.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", path: "C:/tmp/case.pptx", source: "upload" }],
  exports: {}
};
pptUploadJob.assetManifest = buildAssetManifest({ files: pptUploadJob.files, materialBrief: oldDeckBrief, deck: pptUploadDeck });
pptUploadJob.assetManifestQa = validateAssetManifest(pptUploadJob.assetManifest);
assert.equal(pptUploadJob.assetManifestQa.checks.sourceRefsPresent, true);
assert.ok(pptUploadJob.assetManifest.source_refs.some((ref) => ref.type === "source-ppt" && ref.name === "case.pptx"));
const pptUploadVisualProject = await ensureVisualProjectForJob(pptUploadJob);
const pptUploadDeckSpec = JSON.parse(fs.readFileSync(pptUploadVisualProject.deckSpecPath, "utf8"));
assert.ok(pptUploadDeckSpec.asset_manifest.source_refs.some((ref) => ref.type === "source-ppt"));
assert.equal(fs.existsSync(pptUploadVisualProject.outlinePath), true);
assert.equal(fs.existsSync(pptUploadVisualProject.deckSpecPath), true);
const pptUploadPrompt = JSON.parse(fs.readFileSync(path.join(pptUploadVisualProject.promptsDir, "slide_01.json"), "utf8"));
assert.ok(pptUploadPrompt.asset_rules);
assert.ok(pptUploadPrompt.prompt.includes("Visual target is not the final editable PPT background") || pptUploadPrompt.prompt.includes("Background policy"));
const pptUploadSlideJobs = JSON.parse(fs.readFileSync(pptUploadVisualProject.slideJobsPath, "utf8"));
assert.ok(pptUploadSlideJobs.worker_constraints.some((item) => /asset_manifest/.test(item)));

const emptyBrief = buildMaterialBrief([{ name: "\u8f93\u5165\u8bf4\u660e", text: "\u9879\u76ee\u540d\u79f0\uff1a\u65b0\u54c1\u53d1\u5e03" }]);
assert.equal(emptyBrief.inputStrength, "empty");
assert.ok(emptyBrief.confirmationFields.length >= 3);

const textOnlyBrief = buildMaterialBrief([{ name: "\u4e00\u53e5\u9700\u6c42", text: "\u505a\u4e00\u4efd\u9ad8\u7ea7\u89c6\u89c9\u611f\u7684\u65b0\u54c1\u53d1\u5e03 PPT" }]);
const textOnlyRoute = routeDeck({ input: { pageCount: SYSTEM_RECOMMEND }, materialBrief: textOnlyBrief, uploads: [] });
const textOnlyDeck = validateDeck({
  title: "\u65b0\u54c1\u53d1\u5e03",
  slides: [
    { title: "\u65b0\u54c1\u53d1\u5e03", layout: "cover", bullets: ["\u9ad8\u7ea7\u89c6\u89c9\u611f", "\u53ef\u7f16\u8f91 PPTX"] },
    { title: "\u6838\u5fc3\u4eae\u70b9", layout: "visual", bullets: ["\u54c1\u724c\u6c14\u8d28", "\u4ea7\u54c1\u4ef7\u503c"] }
  ]
}, textOnlyRoute).deck;
const textOnlyJob = {
  id: "smoke_text_only_visual_project",
  mode: "generate",
  input: { routePlan: textOnlyRoute, materialBrief: textOnlyBrief },
  deck: textOnlyDeck,
  files: [],
  exports: {}
};
textOnlyJob.assetManifest = buildAssetManifest({ files: [], materialBrief: textOnlyBrief, deck: textOnlyDeck });
textOnlyJob.assetManifestQa = validateAssetManifest(textOnlyJob.assetManifest);
assert.equal(textOnlyJob.assetManifestQa.checks.sourceRefsPresent, true);
assert.ok(textOnlyJob.assetManifest.assets.some((asset) => asset.kind === "text" && asset.editableRole === "textBox"));
const textOnlyVisualProject = await ensureVisualProjectForJob(textOnlyJob);
assert.equal(fs.existsSync(textOnlyVisualProject.outlinePath), true);
assert.equal(fs.existsSync(textOnlyVisualProject.deckSpecPath), true);
assert.equal(fs.existsSync(path.join(textOnlyVisualProject.promptsDir, "slide_01.json")), true);
const textOnlyDeckSpec = JSON.parse(fs.readFileSync(textOnlyVisualProject.deckSpecPath, "utf8"));
assert.ok(textOnlyDeckSpec.style_system);
assert.equal(textOnlyDeckSpec.output_contract.editable_final_pptx, "SceneGraph-rendered final delivery");
assert.ok(textOnlyDeckSpec.asset_manifest.source_refs.length >= 1);

const validated = validateDeck({
  title: "\u5b57\u7b26\u4e32\u5b57\u6bb5\u517c\u5bb9\u6d4b\u8bd5",
  slides: [
    {
      title: "\u5c01\u9762",
      layout: "cover",
      bullets: "39\u5143\uff1b59\u5143\uff1b159\u5143",
      dataPoints: "39\u5143\n59\u5143\n159\u5143",
      imageSlots: ""
    },
    {
      title: "\u4ef7\u683c\u9875",
      layout: "pricing",
      bullets: "39\u5143\uff1a\u5165\u95e8\u9884\u7b97\uff1b59\u5143\uff1a\u4e3b\u63a8\u6863\u4f4d\uff1b159\u5143\uff1a\u5347\u7ea7\u6863\u4f4d",
      dataPoints: "39\u5143\n59\u5143\n159\u5143",
      imageSlots: ""
    }
  ]
});

assert.equal(validated.deck.slides[1].layout, "closing");
assert.deepEqual(validated.deck.slides[0].bullets, ["39\u5143", "59\u5143"]);
assert.deepEqual(validated.deck.slides[1].dataPoints, ["39\u5143", "59\u5143", "159\u5143"]);

const visualTarget = buildVisualTarget({
  job: { deck: validated.deck, files: [] },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
const assetManifest = buildAssetManifest({
  files: [{ id: "logo_1", originalName: "brand-logo.png", mimeType: "image/png", path: "C:/tmp/logo.png" }],
  materialBrief: brief,
  deck: validated.deck
});
const assetManifestQa = validateAssetManifest(assetManifest);
assert.equal(assetManifestQa.status, "pass");
assert.ok(assetManifest.source_refs.length >= 1);
assert.equal(assetManifestQa.checks.sourceRefsPresent, true);
assert.ok(assetManifest.assets.some((asset) => asset.kind === "logo" && asset.canEnterBackground === false));
assert.ok(assetManifest.assets.some((asset) => asset.kind === "text" && asset.editableRole === "textBox"));
const chineseAssetManifest = buildAssetManifest({
  files: [
    { id: "cn_logo", originalName: "本来生活品牌标识.png", mimeType: "image/png", path: "C:/tmp/cn-logo.png" },
    { id: "cn_product", originalName: "端午礼盒产品主图.png", mimeType: "image/png", path: "C:/tmp/product.png" },
    { id: "cn_chart", originalName: "供应链数据图表.png", mimeType: "image/png", path: "C:/tmp/chart.png" },
    { id: "cn_icon", originalName: "蓝色符号图标.png", mimeType: "image/png", path: "C:/tmp/icon.png" },
    { id: "cn_bg", originalName: "橙色主视觉背景.png", mimeType: "image/png", path: "C:/tmp/bg.png" }
  ],
  materialBrief: weakBrief,
  deck: {
    slides: [{
      title: "中文素材识别",
      layout: "visual",
      bullets: "产品图、Logo；价格，供应链",
      dataPoints: "39元；59元、159元"
    }]
  }
});
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_logo" && asset.kind === "logo" && asset.canEnterBackground === false));
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_product" && asset.kind === "product" && asset.editableRole === "independentImage"));
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_chart" && asset.kind === "chart" && asset.canEnterBackground === false));
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_icon" && asset.kind === "icon" && asset.editableRole === "independentImage"));
assert.ok(chineseAssetManifest.assets.some((asset) => asset.id === "cn_bg" && asset.kind === "decoration" && asset.canEnterBackground === true));
assert.deepEqual(
  chineseAssetManifest.assets.filter((asset) => asset.kind === "text" && asset.role === "body").map((asset) => asset.text),
  ["产品图", "Logo", "价格", "供应链"]
);
assert.deepEqual(
  chineseAssetManifest.assets.filter((asset) => asset.kind === "text" && asset.role === "data").map((asset) => asset.text),
  ["39元", "59元", "159元"]
);
const screenshotManifest = buildAssetManifest({
  files: [{ id: "shot_1", originalName: "old-page-screenshot-01.png", mimeType: "image/png", path: "C:/tmp/old-page-screenshot-01.png", materialRole: "page-screenshot" }],
  materialBrief: weakBrief,
  deck: { slides: [{ title: "Screenshot reference only", layout: "visual" }] }
});
const screenshotAsset = screenshotManifest.assets.find((asset) => asset.kind === "page-screenshot");
assert.equal(screenshotAsset.canEnterBackground, false);
assert.equal(validateAssetManifest(screenshotManifest).checks.pageScreenshotsReferenceOnly, true);
const previousCloudMatting = globalThis.process?.env?.CLOUD_MATTING_ENABLED;
if (globalThis.process?.env) globalThis.process.env.CLOUD_MATTING_ENABLED = "false";
const cutoutFallback = await cutoutImage({
  id: "jpg_cutout_candidate",
  originalName: "product-photo.jpg",
  mimeType: "image/jpeg",
  path: path.join(process.cwd(), "missing-product-photo.jpg")
});
if (globalThis.process?.env) {
  if (previousCloudMatting === undefined) delete globalThis.process.env.CLOUD_MATTING_ENABLED;
  else globalThis.process.env.CLOUD_MATTING_ENABLED = previousCloudMatting;
}
assert.equal(cutoutFallback.ok, false);
assert.equal(cutoutFallback.attempts[0].method, "local-flood-fill");
assert.equal(cutoutFallback.attempts[0].ok, false);
assert.equal(cutoutFallback.attempts[1].method, "cloud-image-edit");
assert.equal(cutoutFallback.attempts[1].ok, false);
assert.ok(cutoutFallback.attempts[1].error.includes("CLOUD_MATTING_ENABLED=false"));
assert.equal(visualTarget.noFullSlideRasterAsFinal, true);
assert.equal(visualTarget.sample.status, "not-generated");
assert.ok(visualTarget.sample.prompt.includes("visual reference only"));
const sceneGraph = buildSceneGraph({
  job: { deck: validated.deck, files: [], assetManifest },
  routePlan: giftRoute,
  materialBrief: weakBrief,
  visualTarget
});
const sceneGraphQa = validateSceneGraph(sceneGraph);
assert.equal(sceneGraph.constraints.noFullSlideRaster, true);
assert.equal(sceneGraph.version, 2);
assert.equal(sceneGraph.layerModel.texts.includes("native"), true);
assert.ok(sceneGraph.slides[0].layers.background);
const overriddenSceneGraph = applySceneGraphOverrides(sceneGraph, {
  slides: {
    slide_01: {
      source: "online-editor",
      texts: { title: "Edited SceneGraph Title" }
    }
  }
});
assert.equal(overriddenSceneGraph.slides[0].texts.find((item) => item.role === "title").text, "Edited SceneGraph Title");
assert.equal(validateSceneGraph(overriddenSceneGraph).checks.noFullSlideRaster, true);
assert.equal(sceneGraph.slides.length, validated.deck.slides.length);
assert.ok(sceneGraphQa.textBoxes >= 2);
assert.ok(sceneGraphQa.shapeCount >= 2);
assert.equal(sceneGraphQa.checks.noFullSlideRaster, true);
assert.equal(sceneGraph.slides[0].source.textCoverage.missingExpectedItems.length, 0);
assert.ok(sceneGraph.slides[0].source.textCoverage.expectedItems <= sceneGraph.slides[0].source.textCoverage.sourceItems);
const missingTextQa = validateSceneGraph({
  ...sceneGraph,
  slides: [{
    ...sceneGraph.slides[0],
    source: {
      ...(sceneGraph.slides[0].source || {}),
      textCoverage: {
        ...(sceneGraph.slides[0].source?.textCoverage || {}),
        missingExpectedItems: ["title"]
      }
    }
  }]
});
assert.equal(missingTextQa.status, "warn");
assert.ok(missingTextQa.warnings.some((item) => /expected editable text missing/.test(item)));
const missingTextRepair = buildSceneGraphRepairRecord({
  ...sceneGraph,
  slides: [{ ...sceneGraph.slides[0], texts: [], source: { ...(sceneGraph.slides[0].source || {}), textCoverage: { missingExpectedItems: ["title"] } } }]
}, { items: [] }, validateSceneGraph({
  ...sceneGraph,
  slides: [{ ...sceneGraph.slides[0], texts: [], source: { ...(sceneGraph.slides[0].source || {}), textCoverage: { missingExpectedItems: ["title"] } } }]
}));
assert.ok(missingTextRepair.actions.some((item) => item.action === "rebuild-native-text-boxes"));
const repairedMissingText = applySceneGraphRepairPlan({
  ...sceneGraph,
  slides: [{ ...sceneGraph.slides[0], texts: [], source: { ...(sceneGraph.slides[0].source || {}), textCoverage: { missingExpectedItems: ["title"] } } }]
}, missingTextRepair);
assert.equal(repairedMissingText.sceneGraph.slides[0].texts.some((item) => item.role === "title" && item.editable), true);
const chineseMissingDataRepair = buildSceneGraphRepairRecord({
  slides: [{ id: "slide_missing_data", source: { title: "价格数据页", data: "39元" }, texts: [{ id: "title", role: "title", text: "价格数据页" }], images: [], shapes: [], decorations: [] }]
}, { items: [] }, {
  errors: ["slide_missing_data: missing editable key data / 价格数据"],
  warnings: []
});
const repairedChineseMissingData = applySceneGraphRepairPlan({
  slides: [{ id: "slide_missing_data", source: { title: "价格数据页", data: "39元" }, texts: [{ id: "title", role: "title", text: "价格数据页" }], images: [], shapes: [], decorations: [] }]
}, chineseMissingDataRepair);
assert.ok(repairedChineseMissingData.sceneGraph.slides[0].texts.some((item) => item.role === "data" && item.text === "39元"));
const missingTextHybridQa = buildHybridQa({
  deck: { slides: [{ title: "Missing title", layout: "cover" }] },
  sceneGraphQa: missingTextQa,
  files: [],
  assetManifest: { assets: [], source_refs: [{ id: "source_slide_01" }] },
  assetManifestQa: { checks: { sourceRefsPresent: true }, errors: [], warnings: [] }
}, {}, []);
assert.equal(missingTextHybridQa.categories.content.status, "block");
assert.ok(missingTextHybridQa.categories.content.blockers.some((item) => item.includes("missing-editable-content")));
const canvasSceneGraph = buildSceneGraph({
  job: {
    deck: {
      title: "canvas",
      slides: [
        {
          title: "Canvas title",
          layout: "cover",
          canvasEdits: { title: { box: { x: 20, y: 10, w: 50, h: 12 } } }
        }
      ]
    },
    files: []
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
assert.equal(Math.round(canvasSceneGraph.slides[0].texts.find((item) => item.role === "title").box.x * 10) / 10, 2.7);
const canvasLayerSceneGraph = buildSceneGraph({
  job: {
    deck: {
      title: "canvas-layers",
      slides: [
        {
          title: "Canvas image and shape",
          layout: "visual",
          imageSlots: ["hero-product.png"],
          canvasEdits: {
            asset_0: { type: "image", box: { x: 60, y: 20, w: 22, h: 28 }, fit: "cover", opacity: 0.8 },
            shape_0: { type: "shape", box: { x: 0, y: 0, w: 100, h: 2 }, fill: "#123456", line: "#123456", opacity: 0.7 }
          }
        }
      ]
    },
    files: [{ id: "hero", originalName: "hero-product.png", mimeType: "image/png", path: "C:/tmp/hero-product.png", materialRole: "foreground" }]
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
assert.equal(canvasLayerSceneGraph.slides[0].images[0].fit, "cover");
assert.equal(Math.round(canvasLayerSceneGraph.slides[0].images[0].box.x * 10) / 10, 8);
assert.equal(canvasLayerSceneGraph.slides[0].decorations[0].fill, "123456");
assert.equal(canvasLayerSceneGraph.slides[0].decorations[0].transparency, 30);
const visualSampleExcludedGraph = buildSceneGraph({
  job: {
    deck: { title: "visual target exclusion", slides: [{ title: "Cover", layout: "cover", imageSlots: ["sample"] }] },
    files: [{ originalName: "sample.png", mimeType: "image/png", path: "C:/tmp/sample.png", materialRole: "visual-target-reference" }]
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
assert.equal(visualSampleExcludedGraph.slides[0].images.filter((image) => image.path).length, 0);
assert.equal(visualSampleExcludedGraph.slides[0].images[0]?.required, true);
assert.equal(visualSampleExcludedGraph.slides[0].images[0]?.provenance?.selectionReason, "no-page-bound-image-found");
const cutoutPreferredGraph = buildSceneGraph({
  job: {
    deck: { title: "cutout priority", slides: [{ title: "Product hero", layout: "visual", imageSlots: ["hero-product.png"] }] },
    files: [
      { id: "hero_original", originalName: "hero-product.png", mimeType: "image/png", path: "C:/tmp/hero-product.png", materialRole: "foreground-cutout-candidate", needsCutout: true, mattingStatus: "planned-not-implemented" },
      { id: "hero_cutout", originalName: "hero-product_cutout.png", mimeType: "image/png", path: "C:/tmp/hero-product_cutout.png", materialRole: "foreground-cutout", derived: true, sourceImageId: "hero_original", sourceImageName: "hero-product.png", needsCutout: false, mattingStatus: "local-pass" }
    ]
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
assert.equal(cutoutPreferredGraph.slides[0].images[0].path, "C:/tmp/hero-product_cutout.png");
assert.equal(cutoutPreferredGraph.slides[0].images[0].fullSlide, false);
assert.equal(cutoutPreferredGraph.slides[0].images[0].provenance.selectionReason, "preferred-foreground-cutout");
assert.equal(cutoutPreferredGraph.slides[0].images[0].provenance.mattingStatus, "local-pass");
const fullSlideRiskGraph = {
  version: 2,
  slides: [{
    id: "slide_01",
    constraints: { editable: true, noFullSlideRaster: true },
    texts: [{ id: "title", role: "title", text: "native", box: { x: 1, y: 1, w: 4, h: 1 } }],
    shapes: [],
    decorations: [],
    images: [{ id: "bad", path: "C:/tmp/full.png", box: { x: 0, y: 0, w: 13.333, h: 7.5 }, fullSlide: false }]
  }]
};
const fullSlideRasterQa = validateSceneGraph(fullSlideRiskGraph);
assert.equal(fullSlideRasterQa.status, "block");
assert.ok(fullSlideRasterQa.errors.some((item) => item.includes("full-slide raster")));
const fullSlideRepair = buildSceneGraphRepairRecord(fullSlideRiskGraph, { items: [] }, fullSlideRasterQa);
assert.ok(fullSlideRepair.actions.some((item) => item.action === "remove-full-slide-raster-risk"));
const repairedFullSlide = applySceneGraphRepairPlan(fullSlideRiskGraph, fullSlideRepair);
assert.equal(repairedFullSlide.repairRecord.completed.some((item) => item.action === "remove-full-slide-raster-risk"), true);
assert.ok(repairedFullSlide.sceneGraph.slides[0].images[0].box.w < 13.333);
const backgroundViolationGraph = {
  version: 2,
  slides: [{
    id: "slide_01",
    constraints: { editable: true, noFullSlideRaster: true },
    layers: { background: { containsCriticalText: true, containsLogo: true, containsProductHero: true, containsKeyData: true }, texts: [], shapes: [], assets: [] },
    source: { title: "Recovered proposal title" },
    texts: [],
    shapes: [],
    decorations: [],
    images: []
  }]
};
const backgroundViolationQa = validateSceneGraph(backgroundViolationGraph);
assert.equal(backgroundViolationQa.status, "block");
assert.ok(backgroundViolationQa.errors.some((item) => item.includes("background layer contains critical content")));
const backgroundRepair = buildSceneGraphRepairRecord(backgroundViolationGraph, { items: [] }, backgroundViolationQa);
assert.ok(backgroundRepair.actions.some((item) => item.action === "sanitize-background-layer"));
const repairedBackground = applySceneGraphRepairPlan(backgroundViolationGraph, backgroundRepair);
assert.equal(repairedBackground.sceneGraph.slides[0].layers.background.containsCriticalText, false);
assert.equal(repairedBackground.sceneGraph.slides[0].texts.some((item) => item.role === "title" && item.editable), true);
assert.equal(repairedBackground.sceneGraph.slides[0].images.some((item) => item.role === "logo" && item.required && item.fullSlide === false), true);
assert.equal(repairedBackground.sceneGraph.slides[0].images.some((item) => item.role === "product" && item.required && item.fullSlide === false), true);
assert.equal(validateSceneGraph(repairedBackground.sceneGraph).status, "warn");
const missingImageGraph = {
  version: 2,
  slides: [{
    id: "slide_01",
    constraints: { editable: true, noFullSlideRaster: true, visualPriority: "high" },
    layers: { background: {}, texts: [], shapes: [], assets: [] },
    texts: [{ id: "title", role: "title", text: "native", box: { x: 1, y: 1, w: 4, h: 1 } }],
    shapes: [],
    decorations: [],
    images: []
  }]
};
const missingImageQa = validateSceneGraph(missingImageGraph);
assert.equal(missingImageQa.status, "warn");
assert.ok(missingImageQa.warnings.some((item) => item.includes("missing-required-image-object")));
const missingImageRepair = buildSceneGraphRepairRecord(missingImageGraph, { items: [] }, missingImageQa);
assert.ok(missingImageRepair.actions.some((item) => item.action === "bind-or-generate-independent-image"));
const repairedMissingImage = applySceneGraphRepairPlan(missingImageGraph, missingImageRepair);
assert.equal(repairedMissingImage.sceneGraph.slides[0].images.some((item) => item.required && item.fullSlide === false && item.editable), true);
assert.equal(repairedMissingImage.repairRecord.completed.some((item) => item.action === "bind-or-generate-independent-image" && item.materialStatus === "pending-bind-or-generate"), true);
const missingImageHybridQa = buildHybridQa({
  deck: { slides: [{ title: "Missing image", layout: "visual" }] },
  sceneGraphQa: validateSceneGraph(repairedMissingImage.sceneGraph),
  files: [],
  assetManifest: { assets: [], source_refs: [{ id: "source_slide_01" }] },
  assetManifestQa: { checks: { sourceRefsPresent: true }, errors: [], warnings: [] }
}, {}, []);
assert.equal(missingImageHybridQa.categories.assets.status, "block");
assert.ok(missingImageHybridQa.categories.assets.blockers.some((item) => item.includes("missing-required-independent-images")));
assert.equal(buildFinalExportGate({ formats: ["pdf"], hybridQa: missingImageHybridQa }).blocked, true);
assert.equal(buildFinalExportGate({ formats: ["pptx"], hybridQa: missingImageHybridQa }).blocked, false);
const pdfPendingGraph = buildSceneGraph({
  job: {
    deck: { title: "pdf", slides: [{ title: "PDF page", layout: "cover" }] },
    files: [{ originalName: "source.pdf", mimeType: "application/pdf", path: "C:/tmp/source.pdf" }]
  },
  routePlan: giftRoute,
  materialBrief: weakBrief
});
const pdfPendingQa = validateSceneGraph(pdfPendingGraph);
assert.equal(pdfPendingGraph.editableManifest.pdfPending, true);
assert.equal(pdfPendingQa.status, "warn");
assert.ok(pdfPendingQa.warnings.some((item) => /PDF source pages/.test(item)));
const visualCompare = compareVisualTarget(sceneGraph, visualTarget);
assert.ok(visualCompare.score > 0);
assert.ok(["pass", "warn"].includes(visualCompare.status));
const repairRecord = buildSceneGraphRepairRecord(sceneGraph, visualCompare, sceneGraphQa);
assert.ok(["not-needed", "planned", "blocked"].includes(repairRecord.status));
assert.equal(repairRecord.policy.includes("never paste visual target"), true);
const previewCompare = compareRenderedPreviewToVisualTarget({
  sceneGraph,
  visualTarget,
  previewImages: ["/outputs/job/exports/png/slide-1.png", "/outputs/job/exports/png/slide-2.png"],
  previewQa: [
    { status: "pass", risks: [], full: { variance: 34, brightness: 0.7, edgeDensity: 0.04, saturationDensity: 0.15 } },
    { status: "warn", risks: ["text-safe-area-too-busy"], full: { variance: 22, brightness: 0.65, edgeDensity: 0.08, saturationDensity: 0.12 } }
  ],
  targetQa: { status: "pass", risks: [], full: { variance: 32, brightness: 0.68, edgeDensity: 0.05, saturationDensity: 0.13 } }
});
assert.equal(previewCompare.method, "pptx-preview-pixel-qa");
assert.ok(previewCompare.score > 0);
assert.ok(["pass", "warn"].includes(previewCompare.status));
const blankPreviewCompare = compareRenderedPreviewToVisualTarget({
  sceneGraph,
  visualTarget,
  previewImages: ["/outputs/job/exports/png/slide-1.png"],
  previewQa: [{ status: "warn", risks: ["image-may-be-too-blank"], full: { variance: 4, brightness: 0.9, edgeDensity: 0.004, saturationDensity: 0.01 } }]
});
const blankRepair = buildSceneGraphRepairRecord(sceneGraph, blankPreviewCompare, sceneGraphQa);
assert.ok(blankRepair.actions.some((item) => item.action === "increase-visual-hierarchy"));
const repairedBlank = applySceneGraphRepairPlan(sceneGraph, blankRepair);
assert.ok(repairedBlank.repairRecord.completed.some((item) => item.action === "increase-visual-hierarchy"));
assert.ok(repairedBlank.sceneGraph.slides[0].decorations.length > sceneGraph.slides[0].decorations.length);

const smokePptxJob = {
  id: "smoke_editability",
  mode: "generate",
  input: { routePlan: giftRoute, materialBrief: weakBrief },
  deck: {
    title: "Smoke Editable Export",
    slides: [
      { title: "Native cover", layout: "cover", bullets: ["text box", "shape object"] },
      { title: "Native closing", layout: "closing", bullets: ["editable PPTX"] }
    ]
  },
  files: [],
  exports: {}
};
smokePptxJob.assetManifest = buildAssetManifest({ files: smokePptxJob.files, materialBrief: weakBrief, deck: smokePptxJob.deck });
smokePptxJob.assetManifestQa = validateAssetManifest(smokePptxJob.assetManifest);
const visualProject = await ensureVisualProjectForJob(smokePptxJob);
assert.equal(fs.existsSync(visualProject.outlinePath), true);
assert.equal(fs.existsSync(visualProject.deckSpecPath), true);
assert.equal(fs.existsSync(visualProject.slideJobsPath), true);
const visualDeckSpec = JSON.parse(fs.readFileSync(visualProject.deckSpecPath, "utf8"));
assert.ok(visualDeckSpec.asset_manifest.source_refs.length >= 1);
assert.equal(visualDeckSpec.output_contract.visual_target_pptx.includes("not editable"), true);
assert.equal(path.extname(visualProject.contactSheetPath).toLowerCase(), ".png");
assert.equal(fs.existsSync(visualProject.contactSheetPath), true);
const identicalVisualComparison = comparePngVisualFidelity(visualProject.contactSheetPath, visualProject.contactSheetPath);
assert.equal(identicalVisualComparison.available, true);
assert.equal(identicalVisualComparison.score, 1);
const editableVisualQaDir = fs.mkdtempSync(path.join(os.tmpdir(), "editable-visual-qa-"));
try {
  fs.copyFileSync(visualProject.contactSheetPath, path.join(editableVisualQaDir, "source.png"));
  fs.copyFileSync(visualProject.contactSheetPath, path.join(editableVisualQaDir, "preview.png"));
  const passingEditableVisualQa = await inspectEditablePageVisualFidelity(editableVisualQaDir, "page_001");
  assert.equal(passingEditableVisualQa.passed, true);
  assert.equal(fs.existsSync(path.join(editableVisualQaDir, "product-visual-qa.json")), true);
  fs.rmSync(path.join(editableVisualQaDir, "preview.png"), { force: true });
  const missingPreviewVisualQa = await inspectEditablePageVisualFidelity(editableVisualQaDir, "page_001");
  assert.equal(missingPreviewVisualQa.passed, false);
  assert.deepEqual(missingPreviewVisualQa.issues, ["visual-comparison-unavailable"]);
} finally {
  fs.rmSync(editableVisualQaDir, { recursive: true, force: true });
}
const unsupportedVisualPath = path.join(os.tmpdir(), `unsupported-visual-${Date.now()}.png`);
fs.writeFileSync(unsupportedVisualPath, "not-a-png", "utf8");
assert.equal(comparePngVisualFidelity(visualProject.contactSheetPath, unsupportedVisualPath).available, false);
fs.rmSync(unsupportedVisualPath, { force: true });
assert.equal(visualProject.editable, false);
const generatedVisual = await generateVisualProjectSlides(smokePptxJob, {
  maxSlides: 1,
  generateImage: async () => ({ path: smokePptxJob.visualProject.contactSheetPath, provider: "smoke-generator", visualQa: { status: "pass" } })
});
assert.equal(generatedVisual.status, "recorded");
assert.equal(fs.existsSync(path.join(smokePptxJob.visualProject.originImageDir, "slide_01.png")), true);
assert.equal(fs.existsSync(smokePptxJob.visualProject.visualTargetPptxPath), true);
const visualTargetEditability = await inspectEditablePptx(smokePptxJob.visualProject.visualTargetPptxPath);
assert.equal(visualTargetEditability.editable, false);
assert.ok(visualTargetEditability.fullSlidePictures >= 1);
assert.equal(smokePptxJob.visualProject.visualTargetPptxKind, "full-slide-image-intermediate");
const generatedAllVisualTargets = await generateVisualProjectSlides(smokePptxJob, {
  maxSlides: Infinity,
  generateImage: async () => ({ path: smokePptxJob.visualProject.contactSheetPath, provider: "smoke-generator", visualQa: { status: "pass" } })
});
assert.equal(generatedAllVisualTargets.status, "recorded");
assert.equal(fs.existsSync(path.join(smokePptxJob.visualProject.originImageDir, "slide_02.png")), true);
assert.equal(smokePptxJob.visualProject.generatedImages, smokePptxJob.deck.slides.length);
assert.equal(smokePptxJob.visualProject.status, "ready");
const smokePptxPath = await buildDeck(smokePptxJob);
assert.equal(fs.existsSync(smokePptxPath), true);
assert.equal(path.basename(smokePptxPath), "editable-final.pptx");
const editableWorkerManifest = await writeEditableSceneGraphArtifacts(smokePptxJob);
assert.equal(editableWorkerManifest.status, "recorded");
assert.equal(fs.existsSync(smokePptxJob.visualProject.slideSceneGraphManifestPath), true);
assert.equal(fs.existsSync(path.join(smokePptxJob.visualProject.sceneGraphDir, "slide_01.json")), true);
const slideSceneGraphArtifact = JSON.parse(fs.readFileSync(path.join(smokePptxJob.visualProject.sceneGraphDir, "slide_01.json"), "utf8"));
assert.equal(slideSceneGraphArtifact.worker.type, "single-slide-editable-worker");
assert.equal(slideSceneGraphArtifact.qa.noFullSlideRaster, true);
assert.equal(smokePptxJob.renderReport.renderMode, "sceneGraph");
assert.ok(smokePptxJob.sceneGraph?.slides?.length >= 2);
assert.ok(smokePptxJob.sceneGraph.visualProject.referenceOnly);
assert.ok(smokePptxJob.sceneGraph.slides[0].source.visualTargetImage?.endsWith("slide_01.png"));
assert.equal(smokePptxJob.sceneGraph.slides[0].images.some((image) => image.path === smokePptxJob.sceneGraph.slides[0].source.visualTargetImage), false);
assert.equal(smokePptxJob.sceneGraphQa.checks.noFullSlideRaster, true);
const editability = await inspectEditablePptx(smokePptxPath);
assert.equal(editability.checks.nativeTextBoxes, true);
assert.equal(editability.checks.nativeShapes, true);
assert.equal(editability.checks.noFullSlideRaster, true);
assert.equal(editability.fullSlidePictures, 0);
assert.ok(editability.nativeTextBoxes >= 2);
assert.ok(editability.nativeShapes >= 2);
assert.equal(path.extname(smokePptxPath).toLowerCase(), ".pptx");
assert.equal(smokePptxJob.quality.pptxEditability.status, "pass");
assert.ok(smokePptxJob.quality.pptxEditability.nativeTextBoxes >= 2);

const imageEditableJob = {
  id: "smoke_editable_image_object",
  mode: "generate",
  input: { routePlan: giftRoute, materialBrief: weakBrief },
  deck: {
    title: "Smoke Editable Image Object",
    slides: [
      { title: "Product visual", layout: "visual", imageSlots: ["product-hero.png"], bullets: ["independent image object"] },
      { title: "Image stays editable", layout: "closing", bullets: ["not a full-slide raster"] }
    ]
  },
  files: [{
    id: "product_image_1",
    originalName: "product-hero.png",
    mimeType: "image/png",
    path: smokePptxJob.visualProject.contactSheetPath,
    materialRole: "product",
    source: "upload"
  }],
  exports: {}
};
imageEditableJob.assetManifest = buildAssetManifest({
  files: imageEditableJob.files,
  materialBrief: weakBrief,
  deck: imageEditableJob.deck
});
imageEditableJob.assetManifestQa = validateAssetManifest(imageEditableJob.assetManifest);
const imageEditablePptxPath = await buildDeck(imageEditableJob);
const imageEditable = await inspectEditablePptx(imageEditablePptxPath);
assert.equal(path.basename(imageEditablePptxPath), "editable-final.pptx");
assert.ok(imageEditableJob.sceneGraph.slides[0].images.some((image) => image.path === smokePptxJob.visualProject.contactSheetPath));
assert.ok(imageEditableJob.sceneGraph.slides[0].images.some((image) => image.provenance?.source === "product"));
assert.equal(imageEditableJob.sceneGraph.slides[0].layers.background.containsProductHero, false);
assert.ok(imageEditable.nativePictures >= 1);
assert.equal(imageEditable.fullSlidePictures, 0);
assert.equal(imageEditable.checks.noFullSlideRaster, true);

const pageBoundJob = {
  id: "smoke_page_bound_visual_target",
  mode: "generate",
  input: { routePlan: giftRoute, materialBrief: weakBrief },
  deck: {
    title: "Page Bound Visual Target",
    slides: [
      { title: "Cover with product", layout: "cover", imageSlots: ["slide-one-product"], bullets: ["hero product"] },
      { title: "Case with second product", layout: "visual", imageSlots: ["slide-two-product"], bullets: ["different page asset"] },
      { title: "Closing without source image", layout: "closing", imageSlots: ["missing-closing-asset"], bullets: ["must not reuse another page image"] }
    ]
  },
  files: [
    { id: "asset_slide_1_product", originalName: "slide-one-product.png", mimeType: "image/png", path: "E:\\PPT工具\\tmp\\slide-one-product.png", materialRole: "product", sourceSlide: 1 },
    { id: "asset_slide_2_product", originalName: "slide-two-product.png", mimeType: "image/png", path: "E:\\PPT工具\\tmp\\slide-two-product.png", materialRole: "product", sourceSlide: 2 }
  ],
  exports: {}
};
pageBoundJob.assetManifest = buildAssetManifest({
  files: pageBoundJob.files,
  materialBrief: weakBrief,
  deck: pageBoundJob.deck
});
assert.ok(pageBoundJob.assetManifest.slideBindings?.[0]?.criticalImageIds.includes("asset_slide_1_product"));
assert.ok(pageBoundJob.assetManifest.slideBindings?.[1]?.criticalImageIds.includes("asset_slide_2_product"));
await ensureVisualProjectForJob(pageBoundJob, { force: true });
const promptJobs = JSON.parse(fs.readFileSync(pageBoundJob.visualProject.slideJobsPath, "utf8"));
assert.equal(promptJobs.selected_backend, "cloud-image-first-local-fallback");
assert.ok(promptJobs.worker_constraints.some((item) => /selected image backend/.test(item)));
assert.ok(promptJobs.slides[0].prompt.includes("codex-ppt quality"));
assert.ok(promptJobs.slides[0].prompt.includes("image_area_target"));
assert.ok(promptJobs.slides[0].input_images.some((image) => image.id === "asset_slide_1_product"));
assert.equal(promptJobs.slides[0].input_images.some((image) => image.id === "asset_slide_2_product"), false);
const pageBoundTarget = buildVisualTarget({ job: pageBoundJob, routePlan: giftRoute, materialBrief: weakBrief });
const pageBoundSceneGraph = buildSceneGraph({ job: pageBoundJob, routePlan: giftRoute, materialBrief: weakBrief, visualTarget: pageBoundTarget });
const slideOneImage = pageBoundSceneGraph.slides[0].images[0];
const slideTwoImage = pageBoundSceneGraph.slides[1].images[0];
const slideThreeImage = pageBoundSceneGraph.slides[2].images[0];
assert.equal(slideOneImage.provenance.sourceSlide, 1);
assert.equal(slideTwoImage.provenance.sourceSlide, 2);
assert.equal(slideThreeImage.path, "");
assert.equal(slideThreeImage.required, true);
assert.equal(slideThreeImage.provenance.selectionReason, "no-page-bound-image-found");
const slideArea = 13.333 * 7.5;
assert.ok((slideOneImage.box.w * slideOneImage.box.h) / slideArea >= 0.34);
assert.ok((slideTwoImage.box.w * slideTwoImage.box.h) / slideArea >= 0.30);
const pageBoundCompare = compareVisualTarget(pageBoundSceneGraph, pageBoundTarget);
assert.ok(pageBoundCompare.items[2].warnings.includes("missing-required-image-object"));
assert.equal(pageBoundCompare.items[0].warnings.some((warning) => /^image-area-too-small/.test(warning)), false);

const passHybridQa = buildHybridQa(smokePptxJob, smokePptxJob.quality, smokePptxJob.previewImages || []);
assert.equal(passHybridQa.categories.editable.status, "pass");
assert.equal(passHybridQa.facts.fullSlidePictures, 0);
const blockedHybridQa = buildHybridQa({
  ...smokePptxJob,
  quality: {
    ...(smokePptxJob.quality || {}),
    pptxEditability: { editable: false, fullSlidePictures: 1, warnings: ["full-slide-picture-risk:1"] }
  }
}, { pptxEditability: { editable: false, fullSlidePictures: 1, warnings: ["full-slide-picture-risk:1"] } }, []);
assert.equal(blockedHybridQa.categories.editable.status, "block");
assert.equal(blockedHybridQa.status, "block");
const blockedFinalGate = buildFinalExportGate({ formats: ["pptx", "pdf"], hybridQa: blockedHybridQa });
assert.equal(blockedFinalGate.blocked, true);
assert.equal(blockedFinalGate.requestedFinalFormats[0], "pdf");
const draftOnlyGate = buildFinalExportGate({ formats: ["pptx"], hybridQa: blockedHybridQa });
assert.equal(draftOnlyGate.blocked, false);
const allowedBlockedGate = buildFinalExportGate({ formats: ["png"], hybridQa: blockedHybridQa, allowBlockedExport: true });
assert.equal(allowedBlockedGate.blocked, false);
const visualReferenceExportJob = {
  id: "smoke_visual_reference_exclusion",
  mode: "generate",
  input: { routePlan: giftRoute, materialBrief: weakBrief },
  deck: { title: "Visual reference exclusion", slides: [{ title: "Do not paste reference", layout: "cover", imageSlots: ["visual-target.png"] }] },
  files: [{ originalName: "visual-target.png", mimeType: "image/png", path: path.join(process.cwd(), "missing-visual-target.png"), materialRole: "visual-target-reference" }],
  exports: {}
};
const visualReferencePptxPath = await buildDeck(visualReferenceExportJob);
const visualReferenceEditability = await inspectEditablePptx(visualReferencePptxPath);
assert.equal(visualReferenceExportJob.sceneGraph.slides[0].images.some((image) => image.provenance?.source === "visual-target-reference" || image.path?.includes("visual-target.png")), false);
assert.equal(visualReferenceExportJob.sceneGraph.slides[0].images.filter((image) => image.path).length, 0);
assert.equal(visualReferenceEditability.nativePictures, 0);
await assert.rejects(
  () => buildDeck({
    id: "smoke_no_scenegraph_fallback",
    mode: "generate",
    input: { routePlan: giftRoute, materialBrief: weakBrief },
    deck: { title: "No fallback", slides: [] },
    files: [],
    exports: {}
  }),
  /SceneGraph has no slides/
);
const cloudImageConfig = getCloudImageConfig();
assert.equal(typeof cloudImageConfig.enabled, "boolean");
assert.ok(cloudImageConfig.baseUrl);
assert.ok(cloudImageConfig.model);

const frontendSource = fs.readFileSync(path.join(process.cwd(), "src", "main.jsx"), "utf8");
const apiClientSource = fs.readFileSync(path.join(process.cwd(), "src", "api", "client.js"), "utf8");
const guidedActionSource = fs.readFileSync(path.join(process.cwd(), "src", "workflow", "guidedAction.js"), "utf8");
const indexSource = fs.readFileSync(path.join(process.cwd(), "server", "index.js"), "utf8");
const storeSource = fs.readFileSync(path.join(process.cwd(), "server", "store.js"), "utf8");
const sourceRendererSource = fs.readFileSync(path.join(process.cwd(), "server", "sourceRenderer.js"), "utf8");
const doctorSource = fs.readFileSync(path.join(process.cwd(), "server", "doctor.js"), "utf8");
const productVisualReadinessRunnerSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowProductVisualReadinessRunner.js"), "utf8");
const workflowEditableSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowEditable.js"), "utf8");
const workflowDeliverySource = fs.readFileSync(path.join(process.cwd(), "server", "workflowDelivery.js"), "utf8");
const workflowFinalEvidenceSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowFinalEvidence.js"), "utf8");
const workflowJobsSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowJobs.js"), "utf8");
const workflowVisibilitySource = fs.readFileSync(path.join(process.cwd(), "shared", "workflowVisibility.js"), "utf8");
const workflowManualReviewSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowManualReview.js"), "utf8");
const workflowWorkerQueueSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowWorkerQueue.js"), "utf8");
const workflowWorkerBatchRunnerSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowWorkerBatchRunner.js"), "utf8");
assert.ok(workflowManualReviewSource.includes("scanWorkflowFinalEvidence"));
assert.ok(workflowManualReviewSource.includes("visualQaSignature"));
const editableRecordSource = workflowEditableSource.slice(workflowEditableSource.indexOf("export async function recordWorkflowEditablePage"), workflowEditableSource.indexOf("function syncEditableWorkerTaskAfterRecord"));
assert.ok(editableRecordSource.indexOf("inspectEditablePageVisualFidelity") < editableRecordSource.indexOf("runEditppt(args"));
assert.ok(indexSource.includes('code: error.code || "EDITABLE_PAGE_RECORD_FAILED"'));
assert.ok(frontendSource.includes("/ 门槛"));
assert.ok(indexSource.includes("Final visual QA retry was only partially applied"));
assert.ok(frontendSource.includes("result?.ok === false || Number(result?.failed || 0) > 0"));
assert.ok(frontendSource.includes("页面重置只完成了一部分"));
assert.ok(frontendSource.includes("失败页不会自动再次运行"));
assert.ok(frontendSource.includes("查看并重置"));
assert.ok(frontendSource.includes("清理并重新准备"));
assert.ok(frontendSource.includes("stale-generated-artifacts"));
const finalManualReviewActionSource = frontendSource.slice(frontendSource.indexOf("async function approveFinalManualReview"), frontendSource.indexOf("async function markPageVisualReview"));
assert.ok(!finalManualReviewActionSource.includes("window.confirm"));
assert.ok(!frontendSource.includes("dual-preview-grid"));
assert.ok(!frontendSource.includes("GenerationGateFlow"));
assert.ok(!frontendSource.includes("StylePreviewGate"));
assert.ok(!frontendSource.includes("VisualProjectWorkspace"));
assert.ok(!frontendSource.includes("settingsStatus"));
assert.ok(frontendSource.includes("rightPanelTabs"));
assert.ok(frontendSource.includes("SettingsPanel"));
assert.ok(frontendSource.includes("hasUploadedMaterials"));
assert.ok(frontendSource.includes("{hasUploadedMaterials && ("));
assert.ok(frontendSource.includes("outline-strategy-toggle"));
assert.ok(frontendSource.includes("stage-empty-state"));
assert.ok(!frontendSource.includes("TemplatePreflightSelector"));
assert.ok(!indexSource.includes('/api/jobs/:id/template'));
assert.ok(!frontendSource.includes("function HistoryPanel"));
assert.ok(!frontendSource.includes("jobHealthClass"));
assert.ok(!frontendSource.includes("workflow-reference-advanced"));
assert.ok(!frontendSource.includes("WorkflowSampleLibraryPanel"));
assert.ok(!frontendSource.includes("workflow-sample-library"));
assert.ok(!frontendSource.includes("useWorkflowSample"));
assert.ok(!frontendSource.includes("FALLBACK_THEMES"));
assert.ok(!frontendSource.includes('style: "轻盈渐变风"'));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "server", "deckRouter.js"), "utf8").includes("轻盈渐变风"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "design-system", "themes.json"), "utf8").includes("轻盈渐变风"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "design-system", "aesthetic-recipes.json"), "utf8").includes("轻盈渐变风"));
assert.ok(!frontendSource.includes("api.designSystem"));
assert.ok(!/form\.style|styleBrief:\s*form\.style|themeName:\s*""|themeSlug:\s*""/.test(frontendSource));
assert.ok(!frontendSource.includes("themes={themes}"));
assert.ok(!frontendSource.includes("风格参考库"));
assert.ok(!frontendSource.includes("风格库综合指纹"));
assert.ok(!frontendSource.includes("还没有风格参考图"));
assert.ok(!frontendSource.includes("暂无风格参考"));
assert.ok(!frontendSource.includes("\\u98ce\\u683c\\u53c2\\u8003\\u5e93"));
assert.ok(!frontendSource.includes('projectName: "2026 端午礼盒"'));
assert.ok(!frontendSource.includes('audience: "销售团队内部战卡"'));
assert.ok(frontendSource.includes("可选参考图（非模板）"));
const frontendStyleSource = fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8");
const layoutSource = fs.readFileSync(path.join(process.cwd(), "design-system", "layouts.json"), "utf8");
const checklistSource = fs.readFileSync(path.join(process.cwd(), "design-system", "checklist.md"), "utf8");
assert.ok(!/销售战卡|成交话术|销售预算|卖点卡片|单品详情|组合推荐|风险清单|价格梯度/.test(layoutSource));
assert.ok(!/销售战卡|成交话术|销售预算/.test(checklistSource));
assert.ok(!frontendStyleSource.includes(".theme-row"));
assert.ok(!frontendStyleSource.includes(".theme-card"));
assert.ok(!frontendStyleSource.includes(".orchestration-grid"));
assert.ok(frontendSource.includes("可选参考图"));
assert.ok(frontendSource.includes("确认所有就绪关卡（不生成图片）"));
assert.ok(frontendSource.includes("不会生成图片"));
assert.ok(frontendSource.includes("formatReadyApprovalGateLabels"));
assert.ok(frontendSource.includes("getNoCostCodexApprovalSummary"));
assert.ok(frontendSource.includes("approveNoCostCodexGates"));
assert.ok(frontendSource.includes("skill-first-next-card"));
assert.ok(frontendSource.includes("下一步：无费用确认"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".skill-first-next-card"));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/preflight'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/prompt-preview'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/approval/preflight'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/approval/approve'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-full-deck/approval/preflight'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-full-deck/approval/approve'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-full-deck/preflight'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-sample/run'));
assert.ok(indexSource.includes('/api/v1-acceptance/product-visual-full-deck/run'));
assert.ok(indexSource.includes('app.get("/api/v1-acceptance"'));
assert.ok(indexSource.includes("buildLatestV1AcceptancePayload"));
assert.ok(indexSource.includes("hydrateProductVisualActionPayload"));
assert.ok(indexSource.includes("promptPreviewJobId: readinessJobId"));
assert.ok(apiClientSource.includes('fetch("/api/v1-acceptance"'));
assert.ok(!apiClientSource.includes('fetch("/api/v1-acceptance/latest"'));
assert.ok(indexSource.includes("matchesLatestReport"));
assert.ok(indexSource.includes("产品级视觉预检已过期"));
const v1AcceptanceReportSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8");
assert.ok(v1AcceptanceReportSource.includes("buildRealPptRegressionCommand"));
assert.ok(v1AcceptanceReportSource.includes("spendPlan"));
assert.ok(v1AcceptanceReportSource.includes("buildProductVisualSpendPlan"));
assert.ok(v1AcceptanceReportSource.includes("totalExternalImageCalls"));
assert.ok(v1AcceptanceReportSource.includes("isV1ScopedReport"));
assert.ok(v1AcceptanceReportSource.includes("findLatestV1ScopedReport"));
assert.ok(v1AcceptanceReportSource.includes("if (requiredForV1)"));
assert.ok(v1AcceptanceReportSource.includes("latestUpdated: requiredForV1"));
assert.ok(v1AcceptanceReportSource.includes("latestRepaired"));
assert.ok(v1AcceptanceReportSource.includes("product-visual-full-deck-approval-preflight"));
assert.ok(v1AcceptanceReportSource.includes("product-visual-full-deck-approval-approve"));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualSamplePreflight"));
assert.ok(productVisualReadinessRunnerSource.includes("promptPreviewStatus"));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualSampleApprovalPreflight"));
assert.ok(productVisualReadinessRunnerSource.includes("approveProductVisualSample"));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualFullDeckApprovalPreflight"));
assert.ok(productVisualReadinessRunnerSource.includes("approveProductVisualFullDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("buildSampleReviewChecklist"));
assert.ok(productVisualReadinessRunnerSource.includes("sampleReviewChecklist"));
assert.ok(productVisualReadinessRunnerSource.includes("preflightCodexPptGate"));
assert.ok(productVisualReadinessRunnerSource.includes("approveCodexPptGate"));
assert.ok(productVisualReadinessRunnerSource.includes("buildProductVisualNextStagePlan"));
assert.ok(productVisualReadinessRunnerSource.includes("nextStagePlan"));
assert.ok(productVisualReadinessRunnerSource.includes("recommendedTestPages"));
assert.ok(productVisualReadinessRunnerSource.includes("estimatedFullDeckImageCalls"));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualFullDeckPreflight"));
assert.ok(productVisualReadinessRunnerSource.includes("runProductVisualSample"));
assert.ok(productVisualReadinessRunnerSource.includes("runProductVisualFullDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("generateWorkflowVisualImages"));
assert.ok(productVisualReadinessRunnerSource.includes("requiresImageDeckReview: true"));
assert.ok(!productVisualReadinessRunnerSource.includes("await assembleWorkflowImageDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("syncProductVisualDeckToV1AcceptanceReport"));
assert.ok(productVisualReadinessRunnerSource.includes("writeV1AcceptanceReport"));
assert.ok(productVisualReadinessRunnerSource.includes("latestUpdated: writeResult.latestUpdated"));
const productVisualReadinessCliSource = fs.readFileSync(path.join(process.cwd(), "scripts", "product-visual-readiness.mjs"), "utf8");
assert.ok(productVisualReadinessCliSource.includes("latest-product-visual-readiness.json"));
assert.ok(productVisualReadinessCliSource.includes("writeLatestNoCostReadiness"));
assert.ok(productVisualReadinessCliSource.includes("!generateSample && !generateDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("safeToRunAutomatically: true"));
assert.ok(productVisualReadinessRunnerSource.includes("requiresExplicitSpendConfirmation: false"));
assert.ok(productVisualReadinessRunnerSource.includes("nextRequiresExplicitSpendConfirmation: true"));
assert.ok(productVisualReadinessRunnerSource.includes("externalImageCalls: 0"));
assert.ok(productVisualReadinessRunnerSource.includes('requiredConfirmation: "externalImageSpend"'));
assert.ok(productVisualReadinessRunnerSource.includes("externalImageCalls: 1"));
assert.ok(productVisualReadinessRunnerSource.includes("confirmProductVisualSample"));
assert.ok(productVisualReadinessRunnerSource.includes("confirmProductVisualFullDeck"));
assert.ok(productVisualReadinessRunnerSource.includes("sampleLink: makeWorkflowArtifactLink"));
assert.ok(productVisualReadinessRunnerSource.includes("buildSourcePageLinkForSample"));
assert.ok(productVisualReadinessRunnerSource.includes("sourcePageLink"));
assert.ok(productVisualReadinessRunnerSource.includes('"rendered-page"'));
assert.ok(productVisualReadinessRunnerSource.includes("imageDeckLink: null"));
assert.ok(productVisualReadinessRunnerSource.includes("visualQualityLink: makeWorkflowArtifactLink"));
assert.ok(productVisualReadinessRunnerSource.includes("visualQuality: finalJob.artifacts?.visualQuality"));
assert.ok(productVisualReadinessRunnerSource.includes("visualImageLinks: buildVisualImageLinks"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8").includes("writeVisualQualityReport"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8").includes("detectSourceTextLoss"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8").includes("possible-title-or-text-loss"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "imageQa.js"), "utf8").includes("titleArea"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowPageRetry.js"), "utf8").includes("getVisualQualityRetryPreflight"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "index.js"), "utf8").includes("/api/workflow-jobs/:id/visual-quality/retry-preflight"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowArtifacts.js"), "utf8").includes("visual-quality"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_SAMPLE_CONFIRMATION_REQUIRED"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_SAMPLE_PROMPT_PREVIEW_REQUIRED"));
assert.ok(productVisualReadinessRunnerSource.includes("assertProductVisualSamplePromptPreviewReady"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_SAMPLE_PROMPT_PREVIEW_ARTIFACT_REQUIRED"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_SAMPLE_PROMPT_PREVIEW_STALE"));
assert.ok(productVisualReadinessRunnerSource.includes("confirmPromptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("promptPreviewJobId"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_FULL_DECK_CONFIRMATION_REQUIRED"));
assert.ok(productVisualReadinessRunnerSource.includes("pageSelection"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowAuthorizations.js"), "utf8").includes("normalizePages"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowAuthorizations.js"), "utf8").includes("pageSelection"));
assert.ok(productVisualReadinessRunnerSource.includes("resolveLocalSourcePath"));
assert.ok(productVisualReadinessRunnerSource.includes("normalizeLocalPathCandidates"));
assert.ok(productVisualReadinessRunnerSource.includes('candidate.replace(/\\\\\\\\+/g, "\\\\")'));
assert.ok(productVisualReadinessRunnerSource.includes("localizeSampleApprovalIssue"));
assert.ok(productVisualReadinessRunnerSource.includes("请先生成 1 页真实 codex-ppt 视觉样张"));
assert.ok(productVisualReadinessRunnerSource.includes("getLatestReadinessFreshness"));
assert.ok(productVisualReadinessRunnerSource.includes("PRODUCT_VISUAL_READINESS_STALE"));
assert.ok(productVisualReadinessRunnerSource.includes("buildExecutionSnapshot"));
assert.ok(productVisualReadinessRunnerSource.includes("executionSnapshot"));
assert.ok(productVisualReadinessRunnerSource.includes('status: readyIfConfirmed ? "ready-after-confirmation" : "blocked"'));
assert.ok(productVisualReadinessRunnerSource.includes("getProductVisualSamplePromptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("buildVisualPromptsPayload"));
assert.ok(productVisualReadinessRunnerSource.includes("persistProductVisualSamplePromptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("codexPptSamplePromptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("promptPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("buildAuthorizationPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("authorizationPreview"));
assert.ok(productVisualReadinessRunnerSource.includes("sourceReferenceRequired"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowArtifacts.js"), "utf8").includes("codex-ppt-sample-prompt-preview"));
assert.ok(productVisualReadinessRunnerSource.includes("isSourceReferencedVisualSample"));
assert.ok(productVisualReadinessRunnerSource.includes("source-page-edit"));
assert.ok(productVisualReadinessRunnerSource.includes("image-edit-provider"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "providers.js"), "utf8").includes("/images/edits"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8").includes("editImageWithProvider"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("productActions"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("buildProductVisualProductActions"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("confirmPromptPreview"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("product-visual-test-deck-run"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("product-visual-custom-pages-run"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("buildV1PhaseProgress"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("phaseProgress"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("buildCompletionAudit"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("completionAudit"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowV1AcceptanceReport.js"), "utf8").includes("remainingExternalImageCalls"));
assert.ok(frontendSource.includes("DualRouteDashboard"));
assert.ok(frontendSource.includes("buildDualRouteState"));
assert.ok(frontendSource.includes("const completedEditablePages = Math.max(recordedEditablePages, finalPages)"));
assert.ok(frontendSource.includes("const testPageCount = Math.max(1, Number(routeState.routeA.twoPageTestTarget || 1))"));
assert.ok(!frontendSource.includes("(Array.isArray(job.errors) && job.errors.length && !state.routeA.imageDeckReady)"));
assert.ok(frontendSource.includes("artifactEditableTasks.length >= topLevelEditableTasks.length"));
assert.ok(frontendSource.indexOf("|| sourcePages") < frontendSource.indexOf("|| artifacts.ocrTextHints?.pageCount"));
assert.ok(frontendSource.includes("totalPages: expectedPreviewPages"));
assert.ok(frontendSource.includes("visualPreviewSlots"));
assert.ok(frontendSource.includes("正在本地检查"));
assert.ok(frontendSource.includes("recordCodexPptInformationAssets"));
assert.ok(frontendSource.includes("informationAssetMapReady"));
assert.ok(frontendSource.includes("ocrTextReady"));
assert.ok(!frontendSource.includes("frontend-route-a-source-text"));
assert.ok(indexSource.includes("visual-sample-source-ocr"));
assert.ok(frontendSource.includes("SampleReviewDialog"));
assert.ok(frontendSource.includes("ReviewThreePointChecklist"));
assert.ok(frontendSource.includes("function localizeReviewText"));
assert.ok(frontendSource.includes("完整原始页"));
assert.ok(frontendSource.includes("通过样张或整套图片前，请先与原始页逐项对比。"));
assert.ok(frontendSource.includes("数据数值和相互关系没有改变。"));
assert.ok(frontendSource.includes("图片模型通常需要 1-2 分钟，请保持页面打开"));
assert.ok(frontendSource.includes("frontend-route-a-image-deck-rerun"));
assert.ok(frontendSource.includes("frontend-route-a-image-deck-batch-rerun"));
assert.ok(frontendSource.includes("visual-quality/rebuild-from-existing"));
assert.ok(frontendSource.includes("1. 信息是否保真"));
assert.ok(frontendSource.includes("2. 字是否清楚"));
assert.ok(frontendSource.includes("3. 设计是否更好看"));
assert.ok(frontendSource.includes("可以就通过，不可以就重新生成"));
assert.ok(frontendSource.includes("findSampleAssetPage"));
assert.ok(frontendSource.includes("const canApprove = Boolean(sampleHref && sourceHref)"));
const sampleReviewSource = frontendSource.slice(frontendSource.indexOf("function SampleReviewDialog"), frontendSource.indexOf("function ReviewThreePointChecklist"));
assert.ok(!sampleReviewSource.includes("打开样张"));
assert.ok(frontendSource.includes("setSampleReviewOpen(true);"));
assert.ok(frontendSource.includes("frontend-route-a-sample-review-approval"));
assert.ok(frontendSource.includes("frontend-route-a-sample-review-regenerate"));
assert.ok(frontendSource.includes("ImageDeckReviewDialog"));
assert.ok(frontendSource.includes("imageDeckReviewReady"));
assert.ok(frontendSource.includes("approveImageDeckReviewFromPanel"));
assert.ok(frontendSource.includes("markImageDeckReviewPage"));
assert.ok(frontendSource.includes("markImageDeckBlockedPagesForRerun"));
assert.ok(frontendSource.includes("将 {semanticBlockedPageIds.size} 页加入重做"));
assert.ok(frontendSource.includes("一排排对比原始页和生成页"));
assert.ok(frontendSource.includes("image-deck-review-rows"));
assert.ok(frontendSource.includes("image-deck-review-row-actions"));
assert.ok(frontendSource.includes("image-deck-style-overview"));
assert.ok(frontendSource.includes("整套图片质量总览"));
assert.ok(frontendSource.includes("const displayPageNumber = String(actualPageNumber).padStart(2, \"0\")"));
assert.ok(frontendSource.includes("通过本页"));
assert.ok(frontendSource.includes("标记重做"));
assert.ok(frontendSource.includes("reviewedCount === visualImages.length"));
assert.ok(frontendSource.includes("确认测试通过并继续"));
assert.ok(frontendSource.includes("提交整套复核结果"));
assert.ok(frontendSource.includes("图片版已生成，等待内容与视觉复核"));
assert.ok(frontendSource.includes("下载待复核图片版 PPT"));
assert.ok(!frontendSource.includes("完整视觉统一版本已生成"));
assert.ok(frontendSource.includes("完整图片版待内容与视觉复核"));
assert.ok(frontendSource.includes("页面已经齐全，但风格差异尚未逐页确认"));
assert.ok(frontendSource.includes("imageDeckAvailable"));
assert.ok(frontendSource.includes("fullVisualCoverageReady"));
assert.ok(frontendSource.includes("不是完整交付"));
assert.ok(frontendSource.includes("可编辑样稿确实未达标"));
assert.ok(frontendSource.includes("检查可重做页面"));
assert.ok(frontendSource.includes("不要直接重新合成"));
const imageDeckReviewSource = frontendSource.slice(frontendSource.indexOf("function ImageDeckReviewDialog"), frontendSource.indexOf("function findSampleAssetPage"));
assert.ok(!imageDeckReviewSource.includes("image-deck-review-pages"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes("sample-review-dialog"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes("image-deck-review-dialog"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes("image-deck-review-pages"));
assert.ok(indexSource.includes("/api/workflow-jobs/:id/codex-ppt/information-assets"));
assert.ok(indexSource.includes("assertWorkflowInformationAssetMapReady(currentJob)"));
assert.ok(indexSource.includes("assertWorkflowOcrTextHintsReady(currentJob, { pages:"));
assert.ok(indexSource.includes("OCR_TEXT_HINTS_REQUIRED"));
assert.ok(indexSource.includes('requestedBy: "visual-sample-source-ocr"'));
assert.ok(indexSource.includes("const sampleOptions = { ...body, pageNumber: samplePageNumber }"));
assert.ok(!frontendSource.includes('requestedBy: "frontend-route-a-source-text"'));
assert.ok(apiClientSource.includes("latestWorkflowError?.message"));
assert.ok(indexSource.includes("/api/workflow-jobs/:id/image-deck/review/pages/:pageId"));
assert.ok(indexSource.includes("/api/workflow-jobs/:id/image-deck/review/approve"));
assert.ok(workflowEditableSource.includes("请先完成整套图片内容与视觉复核，再启动可编辑页面重建。"));
assert.ok(indexSource.includes('error.code || "WORKFLOW_GATE_BLOCKED"'));
assert.ok(indexSource.includes("runWithCurrentVisualQuality"));
assert.ok(indexSource.includes("IMAGE_DECK_VISUAL_QUALITY_STALE"));
assert.ok(frontendSource.includes("样张已确认，这里检查两页是否保持同一风格"));
assert.ok(indexSource.includes("IMAGE_DECK_REVIEW_REQUIRED"));
const workflowImageDeckReviewSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowImageDeckReview.js"), "utf8");
assert.ok(workflowImageDeckReviewSource.includes("assertWorkflowImageDeckReviewReady"));
assert.ok(workflowImageDeckReviewSource.includes("visualQualityEvidenceSha256"));
assert.ok(workflowImageDeckReviewSource.includes("getExpectedWorkflowPageCount(job)"));
assert.ok(workflowImageDeckReviewSource.includes("resetImageDeckPageForRerun"));
assert.ok(workflowImageDeckReviewSource.includes("reset from image deck review rerun"));
assert.ok(workflowImageDeckReviewSource.includes("GLOBAL_IMAGE_DECK_KEYS"));
assert.ok(!workflowImageDeckReviewSource.slice(0, workflowImageDeckReviewSource.indexOf("];"))
  .includes('"ocrTextHints"'));
assert.ok(!workflowImageDeckReviewSource.slice(0, workflowImageDeckReviewSource.indexOf("];"))
  .includes('"editableRecords"'));
assert.ok(workflowImageDeckReviewSource.includes('artifacts[key] = artifacts[key].filter'));
assert.ok(workflowImageDeckReviewSource.includes("staleVisualPageIds"));
assert.ok(workflowImageDeckReviewSource.includes(".review-rerun-archive"));
assert.ok(workflowImageDeckReviewSource.includes("resetCodexPptSlideRunForRerun"));
assert.ok(workflowImageDeckReviewSource.includes("summarizeSlideRun"));
const workflowInformationAssetsSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowInformationAssets.js"), "utf8");
const workflowVisualsSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowVisuals.js"), "utf8");
assert.ok(workflowInformationAssetsSource.includes("buildWorkflowInformationAssetMap"));
assert.ok(workflowInformationAssetsSource.includes("fidelity-assets"));
assert.ok(workflowInformationAssetsSource.includes("reusableAssets"));
assert.ok(workflowInformationAssetsSource.includes("cropImage"));
assert.ok(workflowInformationAssetsSource.includes("sourceBoxPx"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowArtifacts.js"), "utf8").includes("codex-ppt-fidelity-assets"));
assert.ok(workflowVisualsSource.includes("SOURCE INFORMATION ASSET MAP"));
assert.ok(workflowVisualsSource.includes("assertWorkflowImageDeckReviewReady(job)"));
assert.ok(workflowVisualsSource.includes("Design around preserved assets"));
assert.ok(workflowVisualsSource.includes("Keep the generated visual intact"));
assert.ok(!workflowVisualsSource.includes("applyFidelityOverlayToVisualImage"));
assert.ok(!workflowVisualsSource.includes("design-layer-plus-source-assets"));
assert.ok(!workflowVisualsSource.includes("applyProgramTextOverlayToVisualImage"));
assert.ok(!workflowVisualsSource.includes("program-rendered-source-text"));
assert.ok(!workflowVisualsSource.includes("program_text_overlay_spec"));
const visualIntactDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "ppt-visual-intact-smoke-"));
try {
  const makeBmp = (width, height, [red, green, blue]) => {
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    const pixelSize = rowSize * height;
    const buffer = Buffer.alloc(54 + pixelSize);
    buffer.write("BM", 0, "ascii");
    buffer.writeUInt32LE(buffer.length, 2);
    buffer.writeUInt32LE(54, 10);
    buffer.writeUInt32LE(40, 14);
    buffer.writeInt32LE(width, 18);
    buffer.writeInt32LE(height, 22);
    buffer.writeUInt16LE(1, 26);
    buffer.writeUInt16LE(24, 28);
    buffer.writeUInt32LE(pixelSize, 34);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = 54 + y * rowSize + x * 3;
        buffer[offset] = blue;
        buffer[offset + 1] = green;
        buffer[offset + 2] = red;
      }
    }
    return buffer;
  };
  const outputPath = path.join(visualIntactDir, "generated.bmp");
  const assetPath = path.join(visualIntactDir, "strict-asset.bmp");
  const ocrPath = path.join(visualIntactDir, "ocr.json");
  const fidelityPath = path.join(visualIntactDir, "fidelity.json");
  await fsPromises.writeFile(outputPath, makeBmp(64, 64, [245, 245, 245]));
  await fsPromises.writeFile(assetPath, makeBmp(24, 24, [220, 20, 60]));
  await fsPromises.writeFile(ocrPath, JSON.stringify({ pages: [{ pageId: "page_001", ocrLines: [{ text: "必须保留", box_px: [6, 34, 42, 16], confidence: 0.99 }] }] }), "utf8");
  await fsPromises.writeFile(fidelityPath, JSON.stringify({ pages: [{ pageId: "page_001", assets: [{ type: "chart-table", path: assetPath, sourceBoxPx: [8, 8, 24, 24] }] }] }), "utf8");
  const before = crypto.createHash("sha256").update(await fsPromises.readFile(outputPath)).digest("hex");
  const record = await buildVisualImageRecord({
    result: { provider: "smoke-verification", generated: true },
    job: {
      id: "workflow_visual_intact_smoke",
      artifacts: {
        ocrTextHints: { path: ocrPath },
        codexPptFidelityAssets: { path: fidelityPath }
      }
    },
    page: { pageId: "page_001", pageNumber: 1, path: outputPath },
    pageNumber: 1,
    outputPath,
    prompt: "behavior verification"
  });
  const after = crypto.createHash("sha256").update(await fsPromises.readFile(outputPath)).digest("hex");
  assert.equal(after, before, "image-stage record building must not mutate generated pixels");
  assert.equal(Object.hasOwn(record, "fidelityOverlay"), false);
  assert.equal(Object.hasOwn(record, "textOverlay"), false);
} finally {
  await fsPromises.rm(visualIntactDir, { recursive: true, force: true });
}
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowCodexPptWorkerQueue.js"), "utf8").includes("job,"));
assert.ok(frontendSource.includes("不需要用户操作的步骤会在后台处理"));
assert.ok(frontendSource.includes("TopbarQuickPanel"));
assert.ok(frontendSource.includes("topbarPanel"));
assert.ok(frontendSource.includes("topbar-system-entry"));
assert.ok(frontendSource.includes("aria-label=\"系统面板\""));
assert.ok(frontendSource.includes("topbar-mode-caret"));
assert.ok(frontendSource.includes("DualCleanupPanel"));
assert.ok(frontendSource.includes("高级详情"));
assert.ok(frontendSource.includes("agent-workbench-grid"));
assert.ok(frontendSource.includes("AgentPreviewPanel"));
assert.ok(frontendSource.includes("当前下一步"));
assert.ok(frontendSource.includes("agent-flow-panel"));
assert.ok(frontendSource.includes("dual-dashboard-left"));
assert.ok(frontendSource.includes("dual-task-tabs"));
assert.ok(frontendSource.includes("[\"all\", \"全部\"]"));
assert.ok(frontendSource.includes("dual-task-search"));
assert.ok(frontendSource.includes("workflowTaskMatchesSearch"));
assert.ok(frontendSource.includes("查看已移除任务"));
assert.ok(frontendSource.includes("查看并恢复"));
assert.ok(frontendSource.includes("onArchivedVisibilityChange"));
assert.ok(frontendSource.includes("showArchived ? archivedJobs : activeJobs"));
assert.ok(frontendSource.includes("displayedTaskRows"));
assert.ok(frontendSource.includes("displayedCleanupRows"));
assert.ok(frontendSource.includes("搜索已移除任务"));
assert.ok(frontendSource.includes("dual-task-more"));
assert.ok(frontendSource.includes("getWorkflowTaskBucket"));
assert.ok(frontendSource.includes("dual-task-remove"));
assert.ok(frontendSource.includes("setTaskFilter(id)"));
assert.ok(frontendSource.includes("setTaskSearch(event.target.value)"));
assert.ok(frontendSource.includes("setCreateOpen(true)"));
assert.ok(frontendSource.includes("handleArchiveTask(event, item)"));
assert.ok(frontendSource.includes("const routeBStarted = Boolean("));
assert.ok(frontendSource.includes('if (routeBStarted && state.routeB.status !== "ready") return "running";'));
assert.ok(frontendSource.includes("onConfirm={askUserConfirm}"));
assert.ok(frontendSource.includes("onArchiveJob={toggleWorkflowArchive}"));
assert.ok(frontendSource.includes("onArchivedVisibilityChange={setWorkflowArchiveVisibility}"));
assert.ok(frontendSource.includes("onRouteAAction={runRouteAAction}"));
assert.ok(frontendSource.includes("onRouteBAction={runRouteBAction}"));
assert.ok(frontendSource.includes("onDeliveryModeChange={setPendingDeliveryMode}"));
assert.ok(frontendSource.includes("onOpenSampleReview={openSampleReviewPanel}"));
assert.ok(frontendSource.includes("onOpenImageDeckReview={openImageDeckReviewPanel}"));
assert.ok(frontendSource.includes("onCreateWorkflow?.({"));
assert.ok(frontendSource.includes("enforcePredictableCost: true"));
assert.ok(frontendSource.includes("maxImageCalls: costPreview?.plannedImageCalls"));
assert.ok(frontendSource.includes('onDeliveryModeChange?.("visual")'));
assert.ok(frontendSource.includes('onDeliveryModeChange?.("editable")'));
assert.ok(frontendSource.includes("topbar-system-entry"));
assert.ok(frontendSource.includes("topbar-popover-tabs"));
assert.ok(frontendSource.includes("dual-advanced-body"));
assert.ok(!frontendSource.includes("dual-cleanup-entry"));
assert.ok(frontendSource.includes("ConfirmDialog"));
assert.ok(frontendSource.includes("askUserConfirm"));
assert.ok(frontendSource.includes('function askUserConfirm({ title = "确认操作", body = "", primaryLabel = "确认", danger = false, variant = "", kicker = "", reviewItems = [], note = "" } = {})'));
assert.ok(frontendSource.includes("variant,"));
assert.ok(frontendSource.includes("kicker,"));
assert.ok(frontendSource.includes("reviewItems,"));
assert.ok(frontendSource.includes("note"));
assert.ok(frontendSource.includes('variant: "route-a"'));
assert.ok(frontendSource.includes("route-a-confirm-dialog"));
assert.ok(frontendSource.includes("route-a-confirm-checks"));
assert.ok(frontendSource.includes("reviewItems"));
assert.ok(frontendSource.includes("这一步只确认大纲、视觉方向和图片生成方式"));
assert.ok(frontendSource.includes("生成后先看原始页和样张对比"));
assert.ok(frontendSource.includes("整套生成后仍会逐页复核"));
assert.ok(frontendSource.includes("确认开始路线 B"));
assert.ok(frontendSource.includes("confirmRouteBStartIfNeeded"));
assert.ok(frontendSource.includes("needsRouteBConfirmation"));
assert.ok(frontendSource.includes("workflowNextActionPreflight(workflowJob.id, body)"));
assert.ok(frontendSource.includes("frontend-route-b-local-setup"));
assert.ok(frontendSource.includes("api.syncWorkflowWorkerTasks(workflowJob.id)"));
assert.ok(frontendSource.includes("api.buildWorkflowWorkerBriefs(workflowJob.id"));
assert.ok(frontendSource.includes("api.probeWorkflowPageSpecProvider(workflowJob.id"));
assert.ok(frontendSource.includes('workflowJob?.artifacts?.editableWorkerBatchRuns'));
assert.ok(frontendSource.includes('run?.status === "running"'));
assert.ok(frontendSource.includes("api.workflowWorkerBatchPreflight(workflowJob.id"));
assert.ok(frontendSource.includes("api.startWorkflowWorkerBatch(workflowJob.id"));
assert.ok(frontendSource.includes("生成下一批 ${EDITABLE_WORKER_BATCH_SIZE} 页（剩余 ${state.routeB.readyEditablePages} 页）"));
assert.ok(frontendSource.includes("开始生成 ${state.routeB.readyEditablePages} 页可编辑 PPT"));
assert.ok(frontendSource.includes("本批完成后保留结果；剩余 ${candidateTasks.length - runnableTasks.length} 页可继续下一批"));
assert.ok(frontendSource.includes("const VISUAL_FULL_DECK_BATCH_SIZE = 3"));
assert.ok(frontendSource.includes('本批次生成第 ${batchPages.join("、")} 页，最多调用 ${pages} 次 gpt-image-2 外部图片 API'));
assert.ok(frontendSource.includes("请先复核本批次新增页面；通过后再生成下一批"));
assert.ok(frontendSource.includes("confirmRouteB: true"));
assert.ok(frontendSource.includes("job?.artifacts?.editableWorkerTasks?.tasks"));
assert.ok(frontendSource.includes("job?.artifacts?.editableWorkerTasks"));
assert.ok(frontendSource.includes("可编辑版确认"));
assert.ok(frontendSource.includes("后台准备 editppt、文字识别和页面任务"));
assert.ok(frontendSource.includes("不需要用户操作的步骤会在后台处理；需要确认时才会弹窗。"));
assert.ok(frontendSource.includes("正式可编辑 PPT 需要全部页面复核通过后才能下载。"));
assert.ok(frontendSource.indexOf("if (finalGate.productReady)") < frontendSource.indexOf("if (finalGate.downloadable)"));
assert.ok(!frontendSource.includes("finalGate.productReady || finalGate.downloadable"));
assert.ok(!frontendSource.includes("deliveryGate?.downloadable === true || deliveryGate?.productReady === true"));
const routeAActionSource = frontendSource.slice(frontendSource.indexOf("async function runRouteAAction"), frontendSource.indexOf("async function runRouteBAction"));
const routeBActionSource = frontendSource.slice(frontendSource.indexOf("async function runRouteBAction"), frontendSource.indexOf("async function planOutline", frontendSource.indexOf("async function runRouteBAction")));
assert.ok(routeAActionSource.includes("runRouteAAction"), "runRouteAAction should exist");
assert.ok(routeBActionSource.includes("runRouteBAction"), "runRouteBAction should exist");
for (const [name, source] of [["runRouteAAction", routeAActionSource], ["runRouteBAction", routeBActionSource]]) {
  assert.ok(!source.includes("window.confirm"), `${name} should use the page confirm dialog`);
  assert.ok(!source.includes("window.alert"), `${name} should not use blocking browser alerts`);
}
assert.ok(frontendSource.includes("dual-route-choice"));
assert.ok(!frontendSource.includes("route-step-track"));
assert.ok(!frontendSource.includes("routeASteps"));
assert.ok(!frontendSource.includes("routeBSteps"));
assert.ok(frontendSource.includes("agent-pipeline"));
assert.ok(frontendSource.includes("previewPageIds"));
assert.ok(frontendSource.includes("secondaryActions = actions.filter((action) => action !== primaryAction).slice(0, 1)"));
assert.ok(frontendSource.includes("dual-help-panel"));
assert.ok(frontendSource.includes("showCreatePanel"));
assert.ok(!frontendSource.includes("titlePrimaryDisabled"));
assert.ok(!frontendSource.includes("dual-title-actions"));
assert.ok(frontendSource.includes("生成大纲"));
assert.ok(frontendSource.includes("分析内容"));
assert.ok(frontendSource.includes("确认样张"));
assert.ok(frontendSource.includes("生成整套图片"));
assert.ok(frontendSource.includes("图片版 + 可编辑版"));
assert.ok(frontendSource.includes("模型与生成设置"));
assert.ok(frontendSource.includes("测试图片生成"));
assert.ok(frontendSource.includes("可编辑重建文字识别"));
assert.ok(frontendSource.includes("图片版生成确认"));
assert.ok(frontendSource.includes("route=B editable requested"));
assert.ok(frontendSource.includes("dual-dashboard-main"));
assert.ok(!frontendSource.includes("dual-dashboard-right"));
assert.ok(frontendSource.includes("<AgentFlowPanel"));
assert.ok(frontendSource.includes("<AgentPreviewPanel"));
assert.ok(!frontendSource.includes('badge="路线 A"'));
assert.ok(frontendSource.includes("artifacts/image-deck?download=1"));
assert.ok(frontendSource.includes("artifacts/final-pptx?download=1"));
assert.ok(frontendSource.includes("state.routeB.deliverableReady"));
assert.ok(frontendSource.includes("WorkflowDeliveryPortal"));
assert.ok(frontendSource.includes("onOpenFailedPages"));
assert.ok(frontendSource.includes("setShowRepairGuide(true)"));
assert.ok(frontendSource.includes("WorkflowDeliverySummary"));
assert.ok(frontendSource.includes("deliveryReviewAutoOpen"));
assert.ok(frontendSource.includes("onReviewAutoOpened"));
assert.ok(frontendSource.includes("WorkflowDeliverySimpleCheck"));
assert.ok(frontendSource.includes("WorkflowDeliveryUserHint"));
assert.ok(!frontendSource.includes("WorkflowStrip"));
assert.ok(!frontendSource.includes("workflow-strip"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes("workflow-strip"));
assert.ok(frontendSource.includes("这里只看能不能交付"));
assert.ok(frontendSource.includes("开始人工复核"));
assert.ok(frontendSource.includes("图片测试稿"));
assert.ok(frontendSource.includes("不能作为客户交付文件"));
assert.ok(frontendSource.includes("workflow-simple-delivery-strip"));
assert.ok(!frontendSource.includes("workflow-delivery-advanced-details"));
assert.ok(!frontendSource.includes("WorkflowPlainAgentDashboardClean"));
assert.ok(!frontendSource.includes("PPT Agent 正在处理"));
assert.ok(frontendSource.includes("checks.fullSourceCoverage === true"));
assert.ok(!frontendSource.includes("ProductV1AcceptancePanel"));
assert.ok(!frontendSource.includes("ProductV1RealDeckAcceptanceCard"));
assert.ok(!frontendSource.includes("ProductVisualPromptPreview"));
assert.ok(!frontendSource.includes("product-v1-product-visual-actions-contract"));
assert.ok(workflowEditableSource.includes("getWorkflowEditablePreparePreflight"));
assert.ok(workflowEditableSource.includes('error.code = "EDITABLE_PREPARE_REFRESH_REQUIRED"'));
assert.ok(workflowEditableSource.includes("archiveGeneratedEditableRun"));
assert.ok(workflowEditableSource.includes("restoreRecordedEditablePages"));
assert.ok(workflowWorkerQueueSource.includes("failureRelease"));
assert.ok(workflowWorkerQueueSource.includes("Reset a failed task before retrying it"));
assert.ok(workflowWorkerQueueSource.includes("stale-generated-artifacts"));
assert.ok(workflowWorkerQueueSource.includes("withWorkflowJobLock"));
assert.ok(workflowWorkerQueueSource.includes("EDITABLE_WORKER_ATTEMPT_STALE"));
assert.ok(workflowWorkerQueueSource.includes("Worker lease expired. Manual reset is required before rerun."));
assert.ok(workflowWorkerBatchRunnerSource.includes("recoveryRequiredPageIds"));
assert.ok(workflowWorkerBatchRunnerSource.includes("startWorkflowEditableWorkerBatchUnlocked"));
assert.ok(workflowWorkerBatchRunnerSource.includes("Reset failed pages after reviewing their failure reason before retrying"));
assert.ok(workflowEditableSource.includes("preservedRecordedPageIds"));
assert.ok(workflowEditableSource.includes("getEditableTextHintEvidence"));
assert.ok(workflowEditableSource.includes("OCR coverage"));
assert.ok(workflowEditableSource.includes("syncEditableRunState"));
assert.ok(workflowEditableSource.includes('PYTHONUTF8: "1"'));
assert.ok(workflowEditableSource.includes("OCR/editppt text hints are not ready"));
assert.ok(indexSource.includes("/api/workflow-jobs/:id/editable/prepare/preflight"));
assert.ok(workflowEditableSource.includes("assertEditableDispatchAllowed"));
assert.ok(workflowEditableSource.includes("EDITABLE_DISPATCH_STAGE_MISMATCH"));
assert.ok(workflowEditableSource.includes("EDITABLE_DISPATCH_PAGE_NOT_SELECTED"));
assert.ok(workflowEditableSource.includes("rebuild_page_locally"));
assert.ok(workflowEditableSource.includes('pageDir = path.join(runDir, "pages", pageId)'));
assert.ok(workflowEditableSource.includes("syncEditableWorkerTaskAfterRecord"));

assert.ok(apiClientSource.includes("workflowEditablePreparePreflight"));
assert.ok(frontendSource.includes("WorkflowEditablePreparePreflightPanel"));
assert.ok(frontendSource.includes("workflow-editable-prepare-preflight"));
assert.ok(frontendSource.includes("(markQualityCurrent && mark?.semanticRiskAccepted)"));
assert.ok(frontendSource.includes("(markQualityCurrent && mark?.styleDriftAccepted)"));
assert.ok(frontendSource.includes("mark.visualQualityEvidenceSha256 === visualQualityEvidenceSha256"));
assert.ok(frontendSource.includes("isFrontendImageDeckReviewApproved(artifacts, twoPageTestTarget)"));
assert.ok(frontendSource.includes("Boolean(image.sha256 && evidence.imageSha256 && image.sha256 === evidence.imageSha256)"));
assert.ok(frontendSource.includes("可编辑重建准备"));
assert.ok(frontendSource.includes("整套图片生成"));
assert.ok(frontendSource.includes("图片生成服务"));
assert.ok(frontendSource.includes("流程检查"));
assert.ok(!frontendSource.includes("image-to-editable-ppt 准备"));
assert.ok(!frontendSource.includes("codex-ppt 全量图片阶段"));
assert.ok(!frontendSource.includes("Codex 图片页任务"));
assert.ok(!frontendSource.includes("Skill 路径状态"));
assert.ok(!frontendSource.includes("Skill 路径等待检查"));
assert.ok(!frontendSource.includes("codex-ppt 到可编辑 PPT"));
assert.ok(!frontendSource.includes("image-to-editable-ppt 可编辑页"));
assert.ok(!frontendSource.includes("对当前单页运行 image-to-editable-ppt"));
assert.ok(!frontendSource.includes("codex-ppt 视觉样张"));
assert.ok(!frontendSource.includes("页面 worker 启动前"));
assert.ok(!frontendSource.includes("WorkflowEditableFailureRecoveryCard"));
assert.ok(!frontendSource.includes("workflow-editable-failure-card"));
assert.ok(frontendSource.includes("resetLatestFailurePages"));
assert.ok(frontendSource.includes("resetLatestDeliveryFailurePages"));
assert.ok(frontendSource.includes("workflowWorkerTaskAction(job.id, pageId, \"reset\""));
assert.ok(!frontendSource.includes("最近失败恢复"));
assert.ok(frontendSource.includes("deliveryWorkerRunBundle"));
assert.ok(frontendSource.includes("previewLatestFailureWorkerStart"));
assert.ok(frontendSource.includes("startLatestFailureWorker"));
assert.ok(frontendSource.includes("latestDeliveryFailurePageSelection"));
assert.ok(frontendSource.includes("if (!job?.id || !latestDeliveryFailurePageSelection) return null;"));
assert.ok(frontendSource.includes("pages: latestDeliveryFailurePageSelection"));
assert.ok(frontendSource.includes("workflowPageSelectionsMatch(preflightPageSelection, latestDeliveryFailurePageSelection)"));
assert.ok(frontendSource.includes("pages: startBody.pages || latestDeliveryFailurePageSelection"));
assert.ok(frontendSource.includes("workflowWorkerPageSelection(status)"));
assert.ok(frontendSource.includes("workflowPreflightPageSelection(workerPreflightBundle)"));
assert.ok(frontendSource.includes("confirmLlmProviderRecovered: Boolean(llmRecovery.required ? llmRecovery.confirmed : false)"));
assert.ok(frontendSource.includes("deliveryLlmRecoveredConfirmed"));
assert.ok(frontendSource.includes("确认页面重建模型服务可用"));
assert.ok(frontendSource.includes("setWorkerPreflightBundle(null)"));
assert.ok(frontendSource.includes("workflowPageSelectionsMatch"));
assert.ok(frontendSource.includes("normalizeWorkflowPageSelection"));
assert.ok(apiClientSource.includes("finalizeWorkflowEditableRun"));
assert.ok(frontendSource.includes("recomposeEditableFinal"));
assert.ok(!frontendSource.includes("WorkflowEditableFinalizeAction"));
assert.ok(frontendSource.includes("allowPartialSample: isPartial"));
assert.ok(frontendSource.includes("不消耗外部额度"));
assert.ok(frontendSource.includes("重新合成最终可编辑 PPT"));
assert.ok(frontendSource.includes("重新合成最终 PPT"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".workflow-editable-finalize-action"));
assert.ok(frontendSource.includes("deliveryWorkerBatchSize"));
assert.ok(frontendSource.includes("deliverySelectedWorkerPageIds"));
assert.ok(frontendSource.includes("latestDeliveryRun"));
assert.ok(!frontendSource.includes("WorkflowAgentWorkerRunStatusClean"));
assert.ok(!frontendSource.includes("本批正在重建"));
assert.ok(!frontendSource.includes("授权本批 ${selectedBatchImageCalls} 次图片额度"));
assert.ok(!frontendSource.includes("确认并启动 ${selectedBatchCount || \"\"} 页重建"));
assert.ok(!frontendSource.includes("workflow-agent-dashboard-checklist"));
assert.ok(frontendSource.includes("将记录 ${imageCalls} 次图片生成额度授权"));
assert.ok(frontendSource.includes("这一步只记录授权账本，不会立刻启动后台任务"));
assert.ok(frontendSource.includes("后续启动页面重建会真实调用外部模型/图片服务"));
assert.ok(frontendSource.includes("已取消页面任务额度授权"));
const workflowNextActionSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowNextAction.js"), "utf8");
const pageRebuildAssemblerSource = fs.readFileSync(path.join(process.cwd(), "scripts", "page-rebuild-assembler.mjs"), "utf8");
const modelPageSpecWorkerSource = fs.readFileSync(path.join(process.cwd(), "scripts", "model-page-spec-worker.mjs"), "utf8");
const buildWorkerBriefsSource = fs.readFileSync(path.join(process.cwd(), "scripts", "build-worker-briefs.mjs"), "utf8");
const visualAssetHelperSource = fs.readFileSync(path.join(process.cwd(), "scripts", "visual-asset-helper.mjs"), "utf8");
const pageWorkerRunnerSource = fs.readFileSync(path.join(process.cwd(), "scripts", "page-worker-runner.mjs"), "utf8");
assert.ok(pageWorkerRunnerSource.includes("const parts = splitCommandLine(workerCommand);"));
assert.ok(pageWorkerRunnerSource.includes("return spawn(parts[0], parts.slice(1)"));
assert.ok(pageWorkerRunnerSource.includes('bundle.next?.stage === "rebuild_page_locally"'));
assert.ok(pageWorkerRunnerSource.includes("await claimTask(baseUrl, jobId, task.pageId, agentId"));
assert.ok(pageWorkerRunnerSource.indexOf("await claimTask(baseUrl, jobId, task.pageId, agentId") < pageWorkerRunnerSource.indexOf("const child = spawnWorkerCommand"));
assert.ok(pageWorkerRunnerSource.includes("await releaseClaimAfterWorkerFailure(baseUrl, jobId, task.pageId, agentId, attempt, error)"));
assert.ok(pageWorkerRunnerSource.includes("PPT_WORKER_ATTEMPT_ID"));
assert.ok(pageWorkerRunnerSource.includes("PPT_WORKER_LEASE_TOKEN"));
assert.ok(pageWorkerRunnerSource.includes("confirmLost: true"));
assert.ok(pageWorkerRunnerSource.includes("allowQueueOnlyReset: true"));
assert.ok(pageWorkerRunnerSource.includes("Number.isInteger(code) ? code : 1"));
assert.ok(pageWorkerRunnerSource.includes("shell: false"));
assert.ok(visualAssetHelperSource.includes("runEditpptImageJobs"));
assert.ok(visualAssetHelperSource.includes('"image",\n      operation'));
assert.ok(visualAssetHelperSource.includes("detectEditpptImageBackend"));
assert.ok(visualAssetHelperSource.includes("refusing to guess provenance"));
assert.ok(visualAssetHelperSource.includes("has no producing-backend provenance"));
assert.ok(visualAssetHelperSource.includes('path.join(pageDir, ".retry-archive")'));
assert.ok(visualAssetHelperSource.includes("matchesArchivedOutput(record, plannedItem?.generated)"));
assert.ok(visualAssetHelperSource.includes('record.output_sha256 || ""'));
assert.ok(!visualAssetHelperSource.includes(".editppt-api-backend-only"));
assert.ok(!visualAssetHelperSource.includes("editImageWithProvider"));
assert.ok(!visualAssetHelperSource.includes("generateImageWithProvider"));
assert.ok(!modelPageSpecWorkerSource.includes("Math.min(bundle.maxTokens || 1800, 1800)"));
assert.ok(modelPageSpecWorkerSource.includes("parseBoundedNumber(bundle.maxTokens || 9000"));
assert.ok(modelPageSpecWorkerSource.includes("Model response was truncated before complete page-rebuild-spec JSON."));
assert.ok(modelPageSpecWorkerSource.includes("ensureAvailableForegroundAssetsRepresented(spec, bundle)"));
assert.ok(modelPageSpecWorkerSource.includes("deduplicatePositionedAssets(spec, bundle)"));
assert.ok(modelPageSpecWorkerSource.includes("hasCompletePositionedAsset(image, pageDir)"));
assert.ok(modelPageSpecWorkerSource.includes('source_type: "imagegen"'));
assert.ok(modelPageSpecWorkerSource.includes("Reused ${assets.length} available source-faithful foreground asset(s) at original page coordinates."));
assert.ok(modelPageSpecWorkerSource.includes("source_box_px: coerceBox(asset.source_box_px)"));
assert.ok(modelPageSpecWorkerSource.includes("visual_inventory item ${item.id || item.description || \"unnamed\"} has no matching positioned shape or image."));
assert.ok(modelPageSpecWorkerSource.includes("Do not reduce gradient, glow, texture, layered transparency, or overlapping decorative orbs to flat native circles."));
assert.ok(modelPageSpecWorkerSource.includes("normalizeDeclaredVisualAssetJobs(spec.needed_visual_asset_jobs, pageRequest)"));
assert.ok(modelPageSpecWorkerSource.includes("spec.needed_visual_asset_jobs = normalizeDeclaredVisualAssetJobs"));
assert.ok(modelPageSpecWorkerSource.includes("|| coerceBox(availableAsset?.source_box_px)"));
assert.ok(modelPageSpecWorkerSource.includes("item.asset_id"));
assert.ok(modelPageSpecWorkerSource.includes("!isFullSlideBackgroundAsset(asset, bundle.pageRequest?.source_size_px)"));
assert.ok(modelPageSpecWorkerSource.includes("box_px: coerceBox(image.box_px) || coerceBox(asset?.source_box_px) || image.box_px"));
assert.ok(modelPageSpecWorkerSource.includes('fs.rm(path.join(pageDir, "visual-asset-jobs.json"), { force: true })'));
assert.ok(modelPageSpecWorkerSource.includes("collectMissingComplexBackgroundAssetJobs(spec, pageRequest)"));
assert.ok(modelPageSpecWorkerSource.includes("ensureAvailableComplexBackgroundAssetsRepresented(spec, bundle, pageRequest)"));
assert.ok(modelPageSpecWorkerSource.includes("const box = coerceBox(asset.source_box_px) || [0, 0, width, height]"));
assert.ok(modelPageSpecWorkerSource.includes("const representedByImage = images.some"));
assert.ok(modelPageSpecWorkerSource.includes('asset_type: "full-slide base visual layer"'));
assert.ok(modelPageSpecWorkerSource.includes("Remove all text, logos, badges, icons, photos, and other foreground objects"));
assert.ok(modelPageSpecWorkerSource.includes("must use a source-faithful image asset, not only native shapes."));
assert.ok(modelPageSpecWorkerSource.includes("readVerifiedRecordedAssetIndex"));
assert.ok(modelPageSpecWorkerSource.includes("isNeededVisualAssetJobCovered"));
assert.ok(modelPageSpecWorkerSource.includes("isTextOnlyBrandRegion"));
assert.ok(modelPageSpecWorkerSource.includes('font_size_calibration = "source-title-ink-height"'));
assert.ok(modelPageSpecWorkerSource.includes('position_calibration = "source-ink-top"'));
assert.ok(modelPageSpecWorkerSource.includes("roundRectOutline"));
assert.ok(modelPageSpecWorkerSource.includes("boxCenterDistance"));
assert.ok(modelPageSpecWorkerSource.includes("sourcePixelsPerPoint"));
assert.ok(modelPageSpecWorkerSource.includes("semanticAssetTokens"));
assert.ok(!modelPageSpecWorkerSource.includes('"inovance"'));
assert.ok(!modelPageSpecWorkerSource.toLowerCase().includes("mooncake"));
assert.ok(modelPageSpecWorkerSource.includes("if (cleanBackground && !recordedJob) continue"));
assert.ok(buildWorkerBriefsSource.includes("state.artifacts?.visualOcrTextHints?.path || state.artifacts?.ocrTextHints?.path"));
const truncationGuardIndex = modelPageSpecWorkerSource.indexOf("isTruncatedFinishReason(finishReason)");
assert.ok(truncationGuardIndex > 0);
assert.ok(modelPageSpecWorkerSource.indexOf("parseJsonContent(content)", truncationGuardIndex) > truncationGuardIndex);
assert.ok(workflowNextActionSource.includes("tryBuildFastEditablePageWorkerPreflight"));
assert.ok(workflowNextActionSource.includes("listWorkflowEditableWorkerTasks"));
assert.ok(workflowNextActionSource.includes("lightweight: true"));
assert.ok(workflowNextActionSource.includes("editable/page-workers"));
assert.ok(workflowNextActionSource.includes("启动页面 worker 前，需要先记录 gpt-image-2 图片额度授权。"));
assert.ok(workflowNextActionSource.includes("不会自动静默消耗外部 API"));
assert.ok(workflowNextActionSource.includes("requiresExternalImageConfirmation: true"));
assert.ok(workflowNextActionSource.includes("Route B requires explicit user confirmation before starting editable PPT rebuild."));
assert.ok(workflowNextActionSource.includes("isImageDeckReviewApproved"));
assert.ok(workflowNextActionSource.includes("isWorkflowJobImageDeckReviewApproved(job)"));
assert.ok(workflowNextActionSource.includes("job.sourceMeta?.pageCount"));
assert.ok(workflowNextActionSource.includes("Route B requires image deck review approval before editable prepare."));
assert.ok((workflowNextActionSource.match(/Route B requires image deck review approval before editable prepare\./g) || []).length >= 2);
assert.ok(workflowNextActionSource.includes("文字、数据、页码或页面角色等自动风险"));
assert.ok(workflowNextActionSource.includes("该动作本身不会立即调用外部 API"));
assert.ok(workflowNextActionSource.includes('action: "image-deck/review"'));
assert.ok(workflowNextActionSource.includes('id: "review-image-deck-style"'));
assert.ok(workflowNextActionSource.includes("requiresImageDeckReview"));
assert.ok(workflowNextActionSource.includes("const preparedJob = await runStage(jobId, \"editable_prepared\""));
assert.ok(workflowNextActionSource.includes("{ job: preparedJob }"));
const imageDeckReviewBackendSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowImageDeckReview.js"), "utf8");
assert.ok(imageDeckReviewBackendSource.includes('source: "image-deck-review"'));
assert.ok(imageDeckReviewBackendSource.includes('options.resetForRerun === true'));
assert.ok(imageDeckReviewBackendSource.includes("visualQualityReview"));
assert.ok(imageDeckReviewBackendSource.includes("IMAGE_DECK_STYLE_DRIFT_REQUIRES_ACCEPTANCE"));
assert.ok(imageDeckReviewBackendSource.includes("styleDriftAccepted"));
assert.ok(imageDeckReviewBackendSource.includes("recordWorkflowImageDeckPagesForRerun"));
assert.ok(imageDeckReviewBackendSource.includes("options.confirmResetForRerun !== true"));
assert.ok(imageDeckReviewBackendSource.includes("IMAGE_DECK_RERUN_CONFIRMATION_REQUIRED"));
assert.ok(imageDeckReviewBackendSource.includes("workflow.image_deck_pages_reset_for_rerun"));
assert.ok(imageDeckReviewBackendSource.includes("captureImageDeckRerunGuidance"));
assert.ok(imageDeckReviewBackendSource.includes("codexPptRerunGuidance"));
assert.ok(imageDeckReviewBackendSource.includes('"visualTextQuality"'));
assert.ok(imageDeckReviewBackendSource.includes("await writeWorkflowVisualTextQualityReport(job)"));
assert.ok(apiClientSource.includes("/image-deck/review/rerun-pages"));
assert.ok(frontendSource.includes("confirmResetForRerun: true"));
assert.ok(!workflowEditableSource.includes("approvedAt >= qualityCreatedAt"));
assert.ok(frontendSource.includes('const EDITABLE_WORKER_BATCH_SIZE = 2'));
assert.ok(frontendSource.includes("setEditableWorkerRunBundle"));
assert.ok(frontendSource.includes("latestEditableWorkerFailure?.recommendedAction"));
assert.ok(frontendSource.includes("api.workflowWorkerRuns(job.id, controller.signal)"));
assert.ok(frontendSource.includes("const preferredPages = new Set"));
assert.ok(frontendSource.includes("onRouteBAction({ pages: latestEditableWorkerFailure.pages })"));
assert.ok(frontendSource.includes('preferredTasks.slice(0, EDITABLE_WORKER_BATCH_SIZE)'));
assert.ok(frontendSource.includes('function hasCurrentVisualOcrCoverage'));
assert.ok(frontendSource.includes('coordinateModeVersion !== "visual-coordinates-v2"'));
assert.ok(frontendSource.includes('source: "visual"'));
assert.ok(frontendSource.includes('syncToEditableRun: true'));
assert.ok(frontendSource.includes('const activeEditableBatchPages = activeEditableRuns.reduce'));
assert.ok(frontendSource.includes('const runningEditablePages = activeEditableBatchPages || claimedEditablePages'));
const pageWorkerBatchSource = fs.readFileSync(path.join(process.cwd(), "scripts", "page-worker-batch.mjs"), "utf8");
const workflowOcrSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowOcr.js"), "utf8");
assert.ok(workflowOcrSource.includes('const VISUAL_COORDINATE_MODE_VERSION = "visual-coordinates-v2"'));
assert.ok(workflowOcrSource.includes('mergeOcrPageEvidence(successfulPages'));
assert.ok(workflowOcrSource.includes('outputName: "paddleocr.json"'));
assert.ok(workflowOcrSource.includes('outputName: "rapidocr.json"'));
assert.ok(workflowOcrSource.includes('backend: providerBackends.length > 1 ? "ocr-ensemble"'));
assert.ok(workflowOcrSource.includes("'use_doc_unwarping': False"));
assert.ok(workflowOcrSource.includes('if x2 > x1 and y2 > y1'));
assert.ok(workflowOcrSource.includes('ppt-agent-ocr-${process.pid}'));
assert.ok(workflowOcrSource.includes('await fs.copyFile(imagePath, stagedPath)'));
assert.ok(workflowOcrSource.includes('const existingOcrLines = Array.isArray(page.ocrLines)'));
assert.ok(workflowOcrSource.includes('sha256: cleanString(item.sha256 || "") || currentFileSha256Sync(path.resolve(item.path))'));
assert.ok(workflowOcrSource.includes('[\\uE000-\\uF8FF\\uFFFD]'));
assert.ok(frontendSource.includes('progressState.reviewPageIds?.length'));
assert.ok(frontendSource.includes('const targetImages = missingImages.length ? missingImages : images'));
assert.ok(pageWorkerBatchSource.includes('forceEditpptReset: true'));
assert.ok(pageWorkerBatchSource.includes('confirmLost: true'));
assert.ok(pageWorkerBatchSource.includes('clearGeneratedArtifacts: true'));
assert.ok(pageWorkerBatchSource.includes('const preserveGeneratedAssets = shouldPreserveGeneratedAssets(reason)'));
assert.ok(pageWorkerBatchSource.includes('product visual fidelity QA|visual similarity|structure-loss'));
assert.ok(pageWorkerBatchSource.includes('visual-asset-helper'));
assert.ok(pageWorkerBatchSource.includes('const detail = stderrTail.replace'));
assert.ok(workflowWorkerQueueSource.includes('preserveGeneratedAssets: options.preserveGeneratedAssets === true'));
assert.ok(workflowWorkerQueueSource.includes('preservedGeneratedAssets: preserveGeneratedAssets'));
assert.ok(frontendSource.includes('confirmLlmProviderRecovered: true'));
assert.ok(frontendSource.includes('result.run?.id'));
assert.ok(frontendSource.includes("routeState.routeA.hasPartialFinal"));
assert.ok(frontendSource.includes("workflowContinueRemaining(workflowJob.id"));
assert.ok(frontendSource.includes("runCodexPptBatchWithProgress"));
assert.ok(frontendSource.includes("api.runCodexPptSlideBatch"));
assert.ok(frontendSource.includes("正在逐页生成图片版"));
assert.ok(workflowNextActionSource.includes("assertWorkflowImageDeckReviewReady"));
assert.ok(imageDeckReviewBackendSource.includes("Pixel heuristics compare different slide roles"));
assert.ok(frontendSource.includes("generatedVisualPages"));
assert.ok(frontendSource.includes("!generatedVisualPages.has(pageNumber)"));
assert.ok(visualAssetHelperSource.includes("runEditpptImageJobs"));
assert.ok(!visualAssetHelperSource.includes("editImageWithProvider"));
assert.ok(visualAssetHelperSource.includes("visual-asset-force-progress.json"));
assert.ok(visualAssetHelperSource.includes("options.forceIndexes?.has(index)"));
assert.ok(visualAssetHelperSource.includes("pathWithinPage(outDir, outName)"));
assert.ok(visualAssetHelperSource.includes("plannedItem?.actualBackend"));
assert.ok(!visualAssetHelperSource.includes('["image", "batch"'));
assert.ok(workflowEditableSource.includes("assertImageDeckReviewGate(job, options)"));
assert.match(workflowEditableSource, /requestedBy:\s*"editable-prepare",\s*preserveWorkflowStage:\s*true/);
assert.ok(workflowEditableSource.includes("getExpectedWorkflowPageCount(job)"));
assert.ok(workflowEditableSource.includes("Route B requires explicit user confirmation before editable prepare."));
assert.ok(workflowEditableSource.includes("isImageDeckReviewApproved"));
assert.ok(editableRecordSource.includes("Image deck review must be current and approved before recording editable page results."));
assert.ok(workflowEditableSource.includes("Image deck review must be current and approved before finalizing the editable PPTX."));
assert.ok(workflowDeliverySource.includes("Image deck review is missing, stale, or incomplete for the current generated pages."));
assert.ok(workflowFinalEvidenceSource.includes("powerPointOpenability?.available === true"));
assert.ok(workflowFinalEvidenceSource.includes("powerPointOpenability?.openable === true"));
assert.ok(workflowFinalEvidenceSource.includes("final.sha256 !== finalHash"));
assert.ok(workflowFinalEvidenceSource.includes("!cached.finalSha256 || cached.finalSha256 !== finalHash"));
assert.ok(workflowJobsSource.includes("WORKFLOW_LIST_CACHE_TTL_MS"));
assert.ok(workflowJobsSource.includes("export async function listWorkflowJobSummaries"));
assert.ok(workflowJobsSource.includes("WORKFLOW_LIST_READ_CONCURRENCY"));
assert.ok(workflowJobsSource.includes("buildWorkflowListSummary"));
assert.ok(workflowJobsSource.includes("refreshWorkflowListCacheSingleFlight"));
assert.ok(workflowJobsSource.includes("startedRevision === workflowListCacheRevision"));
assert.ok(workflowJobsSource.includes("cached?.fingerprint === fingerprint"));
assert.ok(workflowJobsSource.includes("WORKFLOW_LIST_CHANGE_PATH"));
assert.ok(workflowEditableSource.includes("safeToRunAutomatically: false"));
assert.ok(!workflowEditableSource.includes("allowMissingVisualQualityForTest || options.allowNonProductVisual || options.allowNonProductBackend"));
assert.ok(!workflowEditableSource.includes("/regression|smoke|test/i.test(marker)"));
assert.ok(pageRebuildAssemblerSource.includes("(?<=[\\u3400-\\u9fff])\\s*\\|\\s*(?=[\\u3400-\\u9fff])"));
assert.ok(!pageRebuildAssemblerSource.includes(".replace(/\\s*\\|\\s*/g, \"|\")"));
assert.ok(pageRebuildAssemblerSource.includes("inferRoundRectCornerRadius(shape.box_px)"));
assert.ok(pageRebuildAssemblerSource.includes("PPT_TOOL_ALLOW_SOURCE_FIDELITY_RASTER_RECOVERY"));
assert.ok(pageRebuildAssemblerSource.includes("calculateSourceRasterCoverage(images)"));
assert.ok(pageRebuildAssemblerSource.includes("full-slide raster fallback is forbidden"));
assert.ok(modelPageSpecWorkerSource.includes("inferRoundRectCornerRadius(shape.box_px)"));
assert.ok(workflowNextActionSource.includes("generateWorkflowVisualSample(jobId, authorizedBody)"));
assert.ok(workflowNextActionSource.includes("generateWorkflowVisualImages(jobId, authorizedBody)"));
assert.ok(!frontendSource.includes("待处理页面"));
const workflowArtifactsSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowArtifacts.js"), "utf8");
assert.ok(workflowArtifactsSource.includes("draft-final-pptx"));
assert.ok(workflowArtifactsSource.includes("Draft check PPTX"));
assert.ok(workflowArtifactsSource.includes("manual review is not complete"));
assert.ok(workflowArtifactsSource.includes("assertDraftFinalPptxDownloadable"));
assert.ok(workflowArtifactsSource.includes("Draft final PPTX is only available before final delivery approval."));
assert.ok(workflowArtifactsSource.includes("isFinalPptxProductReady(finalGate"));
assert.ok(workflowArtifactsSource.includes("isFinalPptxProductReady(gate"));
assert.ok(workflowArtifactsSource.includes("Final PPTX is blocked until productReady=true."));
assert.ok(workflowArtifactsSource.includes("productReady: gate.productReady === true"));
assert.ok(workflowArtifactsSource.includes("downloadable: productReady"));
assert.ok(workflowEditableSource.includes("Final delivery pending manual review and product gate"));
assert.ok(workflowEditableSource.includes('job.status = "review_pending"'));
assert.ok(frontendSource.includes("finalGateProductReady"));
assert.ok(frontendSource.includes("deliverableReady = Boolean(finalReady && reviewReady && finalGateProductReady)"));
const workflowV1ReadinessSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowV1Readiness.js"), "utf8");
assert.ok(workflowV1ReadinessSource.includes("const finalDownloadable = Boolean(finalGate.productReady)"));
assert.ok(!workflowV1ReadinessSource.includes("finalGate.downloadable || finalGate.productReady"));
const serverIndexSource = fs.readFileSync(path.join(process.cwd(), "server", "index.js"), "utf8");
assert.ok(serverIndexSource.includes('const preserveWorkflowStage = req.body?.preserveWorkflowStage === true'));
assert.ok(serverIndexSource.includes('if (!preserveWorkflowStage)'));
assert.ok(serverIndexSource.includes("Route B requires explicit user confirmation before fresh editable run recovery."));
assert.ok(serverIndexSource.includes("createFreshEditableRunRollbackSnapshot"));
assert.ok(serverIndexSource.includes("restoreFreshEditableRunRollbackSnapshot"));
assert.ok(serverIndexSource.includes("freshRecoveryError.freshRollbackRestored = true"));
assert.ok(serverIndexSource.includes("if (error.freshRollbackRestored)"));
assert.ok(serverIndexSource.indexOf("if (error.freshRollbackRestored)") < serverIndexSource.indexOf("const job = await updateWorkflowStage(req.params.id, {", serverIndexSource.indexOf("if (error.freshRollbackRestored)")));
assert.ok(serverIndexSource.indexOf("createFreshEditableRunRollbackSnapshot(currentJob)") < serverIndexSource.indexOf("invalidateWorkflowEditableRebuildEvidence(req.params.id"));
assert.ok(serverIndexSource.indexOf("confirmRouteB") < serverIndexSource.indexOf("createFreshEditableRunRollbackSnapshot(currentJob)"));
assert.ok(frontendSource.includes("function isFrontendImageDeckReviewApproved"));
assert.ok(frontendSource.includes("const imageDeckReviewReady = isFrontendImageDeckReviewApproved(artifacts)"));
assert.ok(frontendSource.includes("return isWorkflowImageDeckReviewReady(artifacts"));
assert.ok(frontendSource.includes("Boolean(image.sha256 && evidence.imageSha256 && image.sha256 === evidence.imageSha256)"));
assert.ok(frontendSource.includes("const confirmedBody = await confirmRouteBStartIfNeeded({"));
assert.ok(frontendSource.includes("api.refreshWorkflowEditableRun(job.id, confirmedBody)"));
assert.ok(frontendSource.includes("getFinalDownloadState"));
assert.ok(frontendSource.includes("确认方案"));
assert.ok(frontendSource.includes("确认样张"));
assert.ok(frontendSource.includes("后台生成"));
assert.ok(frontendSource.includes("下载图片版"));
assert.ok(frontendSource.includes("需要弹出确认界面"));
assert.ok(frontendSource.includes("不需要用户操作的步骤会在后台处理"));
assert.ok(frontendSource.includes("codexPptDecisionReady"));
assert.ok(frontendSource.includes("sampleApproved"));
assert.ok(!frontendSource.includes("先按 codex-ppt skill 完成 6 步"));
assert.ok(!frontendSource.includes("准备 slide jobs 和运行状态"));
assert.ok(!frontendSource.includes("派发幻灯片子任务"));
assert.ok(!frontendSource.includes("样张已确认，图片版正在后台生成和组装。"));
assert.ok(!frontendSource.includes("后续图片页生成、检查和组装在后台完成"));
assert.ok(!frontendSource.includes("图片页已检查并组装"));
assert.ok(!frontendSource.includes("正在生成、检查和组装"));
assert.ok(!frontendSource.includes("state.routeA.imageDeckReady ? `${PRODUCT_VISUAL_STYLE_LOCK_LABEL}已固化`"));
assert.ok(frontendSource.includes("小样本草稿"));
assert.ok(workflowArtifactsSource.includes("asset-contact-sheet"));
assert.ok(workflowArtifactsSource.includes("split_assets_contact.png"));
assert.ok(frontendSource.includes("WorkflowPageVisualReviewWorkbench"));
assert.ok(frontendSource.includes("workflow-review-modal"));
assert.ok(frontendSource.includes("逐页对比：原始页、图片版、可编辑页"));
assert.ok(frontendSource.includes("label=\"原始页\""));
assert.ok(frontendSource.includes("label=\"图片版\""));
assert.ok(frontendSource.includes("label=\"可编辑页\""));
assert.ok(frontendSource.includes("全部通过，记录复核"));
assert.ok(!frontendSource.includes("bulk approve from route A image deck review"));
assert.ok(frontendSource.includes("我已单独核对风格差异，确认这是合理变化"));
assert.ok(frontendSource.includes("我已放大并逐字核对原稿"));
assert.ok(frontendSource.includes("确认并通过本页"));
assert.ok(frontendSource.includes("开始人工复核"));
assert.ok(!frontendSource.includes("暂时接受"));
assert.ok(!frontendSource.includes("确认人工复核通过"));
assert.ok(!frontendSource.includes("标记复核通过"));
assert.ok(!frontendSource.includes("WorkflowArtifactReviewPanel"));
assert.ok(!frontendSource.includes("workflow-artifact-review-panel"));
assert.ok(!frontendSource.includes("workflow-review-panel"));
assert.ok(!frontendSource.includes("buildWorkflowReviewRows"));
assert.ok(frontendSource.includes("markWorkflowPageReview"));
assert.ok(frontendSource.includes("pageVisualReview"));
assert.ok(frontendSource.includes("pendingPageMarks"));
assert.ok(frontendSource.includes("pageMarkErrors"));
assert.ok(frontendSource.includes("savingPages"));
assert.ok(!frontendSource.includes("pageReviewBusy"));
assert.ok(!frontendSource.includes("pageReviewError"));
assert.ok(frontendSource.includes("不通过"));
assert.ok(guidedActionSource.includes("workflow-delivery-panel"));
assert.ok(workflowNextActionSource.includes("workflow-delivery-panel"));
assert.ok((workflowNextActionSource.match(/if \(partialFinal\) \{/g) || []).length >= 2);
assert.ok(!guidedActionSource.includes("workflow-artifact-review-panel"));
assert.ok(!workflowNextActionSource.includes("workflow-artifact-review-panel"));
assert.ok(workflowManualReviewSource.includes("recordWorkflowPageVisualReview"));
assert.ok(workflowManualReviewSource.includes("readyForFinalReview"));
assert.ok(workflowManualReviewSource.includes("Page evidence is incomplete"));
assert.ok(indexSource.includes("/api/workflow-jobs/:id/review/pages/:pageId"));
assert.ok(indexSource.includes("sourceName: workflowSourceName(job)"));
assert.ok(indexSource.includes("sourcePages,"));
assert.ok(indexSource.includes("finalPages,"));
assert.ok(indexSource.includes("isSample: Boolean(sourcePages && finalPages && finalPages < sourcePages)"));
assert.ok(indexSource.includes("function workflowSourceName"));
assert.ok(indexSource.includes("const includeInternal = isTruthyQuery(req.query?.includeInternal)"));
assert.ok(indexSource.includes('import { isInternalWorkflowJob } from "../shared/workflowVisibility.js"'));
assert.ok(frontendSource.includes('import { isInternalWorkflowJob } from "../shared/workflowVisibility.js"'));
assert.ok(workflowVisibilitySource.includes('if (visibility === "public") return false;'));
assert.ok(workflowVisibilitySource.includes("INTERNAL_WORKFLOW_PATTERN.test(text)"));
assert.ok(indexSource.includes("buildPrimaryWorkflowListItem(primaryWorkflow)"));
assert.ok(indexSource.includes('const DEFAULT_PRIMARY_WORKFLOW_JOB_ID = ""'));
assert.ok(indexSource.includes("configured: false"));
assert.ok(!indexSource.includes("workflow_20260629-021146Z_619d82"));
assert.ok(indexSource.includes("job: null"));
assert.ok(frontendSource.includes("workflowJob?.input?.sourceOriginalName"));
assert.ok(frontendSource.includes("if (!id) return null;"));
assert.ok(!frontendSource.includes("setWorkflowJob((current) => current?.id ? current : meta.primaryWorkflowJob)"));
assert.ok(!frontendSource.includes("setWorkflowJob((current) => current?.id ? current : primaryJob)"));
assert.ok(frontendSource.includes("setWorkflowJob(null);"));
assert.ok(frontendSource.includes("function isPrimaryWorkflowJob"));
assert.ok(frontendSource.includes("visibleJobs.filter((job) => !isPrimaryWorkflowJob(job, primaryWorkflow))"));
assert.ok(frontendSource.includes("const canRunRouteA = Boolean(routeAPrimaryAction)"));
assert.ok(frontendSource.includes("checks.sourcePages"));
assert.ok(frontendSource.includes("checks.finalPages"));
assert.ok(workflowWorkerBatchRunnerSource.includes('NODE_USE_ENV_PROXY: process.execArgv.includes("--use-env-proxy")'));
assert.ok(workflowWorkerBatchRunnerSource.includes("describeImageDeckReviewGate(artifacts, false)"));
assert.ok(workflowWorkerBatchRunnerSource.includes("isImageDeckReviewApproved"));
assert.ok(workflowWorkerBatchRunnerSource.includes('error.code = "IMAGE_DECK_REVIEW_REQUIRED"'));
assert.ok(workflowWorkerBatchRunnerSource.includes('Boolean(options.lowComplexityPageSpec || options.useLowComplexityPageSpec)'));
assert.ok(workflowWorkerBatchRunnerSource.includes('当前批次仍保持完整页面规格'));
assert.ok(!workflowWorkerBatchRunnerSource.includes('recentProviderFailure.kind === "provider-timeout"\n      || options.lowComplexityPageSpec'));
assert.ok(workflowWorkerBatchRunnerSource.includes("buildRunnerFailureAnalysis"));
assert.ok(workflowWorkerBatchRunnerSource.includes('"visual-fidelity-failed"'));
assert.ok(workflowWorkerBatchRunnerSource.includes("视觉相似度未达标"));
assert.ok(workflowWorkerBatchRunnerSource.includes('"asset-provenance-missing"'));
assert.ok(workflowWorkerBatchRunnerSource.includes("已有图片资产缺少来源记录"));
assert.ok(!/function isImageProviderOverloadText[\s\S]{0,500}visual-asset-helper\\\.mjs exited with code 1/.test(workflowWorkerBatchRunnerSource));
assert.ok(workflowWorkerBatchRunnerSource.includes("timeout(?: error| exceeded| after)"));
assert.ok(workflowWorkerBatchRunnerSource.includes("canRetryPages"));
assert.ok(workflowWorkerBatchRunnerSource.includes("const sanitized = sanitizeRunner(run)"));
assert.ok(workflowWorkerBatchRunnerSource.includes("cleanPublicError"));
assert.ok(workflowWorkerBatchRunnerSource.includes("页面 worker 命令未完成，页面产物没有记录。"));
assert.ok(workflowWorkerBatchRunnerSource.includes("staleSelectedPageIds"));
assert.ok(workflowWorkerBatchRunnerSource.includes("图片已更新，请先刷新可编辑运行"));
const workflowAuthorizationsSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowAuthorizations.js"), "utf8");
assert.ok(workflowAuthorizationsSource.includes("AUTHORIZATION_TTL_MS"));
assert.ok(workflowAuthorizationsSource.includes("AUTHORIZATION_JOB_LOCKS"));
assert.ok(workflowAuthorizationsSource.includes("consumeExternalImageSpendAuthorization"));
assert.ok(workflowAuthorizationsSource.includes("consumedAt"));
assert.ok(workflowAuthorizationsSource.includes("authorizationCoversPages"));
const pptAgentWorkspaceSource = fs.readFileSync(path.join(process.cwd(), "src", "ui-v2", "PptAgentWorkspace.jsx"), "utf8");
assert.ok(frontendSource.includes("editablePreviewSlots"));
assert.ok(frontendSource.includes("activePreviewSlots"));
assert.ok(frontendSource.includes("editableModeAvailable"));
assert.ok(pptAgentWorkspaceSource.includes('const progressVerb = editableMode ? "重建" : "生成"'));
assert.ok(apiClientSource.includes("EXTERNAL_IMAGE_AUTHORIZATION_REQUIRED"));
assert.ok(apiClientSource.includes("EDITABLE_PREPARE_REFRESH_REQUIRED"));
assert.ok(apiClientSource.includes("fetchWithTimeout"));
assert.ok(apiClientSource.includes("X-PPT-Agent-Request-Id"));
assert.ok(apiClientSource.includes("REQUEST_TIMEOUT"));
assert.ok(apiClientSource.includes("pendingWriteRequestIds"));
assert.ok(apiClientSource.includes("localStorage"));
assert.ok(apiClientSource.includes("shouldRetainWriteRequestId"));
assert.ok(apiClientSource.includes("X-PPT-Agent-Recover-Pending"));
assert.ok(apiClientSource.includes("markWriteRequestRecoveryRequired"));
assert.ok(apiClientSource.includes("REQUEST_MANUAL_RECONCILIATION_REQUIRED"));
assert.ok(apiClientSource.includes("externalSignal?.addEventListener"));
assert.ok(indexSource.includes("app.use(requestIdempotency)"));
const requestIdempotencySource = fs.readFileSync(path.join(process.cwd(), "server", "requestIdempotency.js"), "utf8");
assert.ok(requestIdempotencySource.includes("X-PPT-Agent-Idempotent-Replay"));
assert.ok(requestIdempotencySource.includes("REQUEST_ID_CONFLICT"));
assert.ok(requestIdempotencySource.includes("REQUEST_RECOVERY_REQUIRED"));
assert.ok(requestIdempotencySource.includes("ppt-agent-idempotency"));
assert.ok(requestIdempotencySource.includes("DISK_PRUNE_INTERVAL_MS"));
assert.ok(requestIdempotencySource.includes("claimAbandonedRecord"));
assert.ok(requestIdempotencySource.includes("REQUEST_IN_PROGRESS"));
assert.ok(requestIdempotencySource.includes("REQUEST_MANUAL_RECONCILIATION_REQUIRED"));
assert.ok(requestIdempotencySource.includes("resolveIdempotencyRecord"));
assert.ok(requestIdempotencySource.includes("IDEMPOTENCY_RESULT_ALREADY_COMPLETE"));
assert.ok(indexSource.includes("/api/system/idempotency/resolve"));
assert.ok(frontendSource.includes("重新读取"));
assert.ok(frontendSource.includes("暂时无法开始人工复核"));
assert.ok(workflowWorkerQueueSource.includes(".ppt-agent-reset-transaction.json"));
assert.ok(workflowWorkerQueueSource.includes('advanceResetTransaction(resetTransaction, "artifacts-archived"'));
assert.ok(workflowWorkerQueueSource.includes('advanceResetTransaction(resetTransaction, "complete"'));
assert.ok(workflowWorkerQueueSource.includes("EDITABLE_WORKER_CONFIRM_LOST_REQUIRED"));
assert.ok(workflowWorkerQueueSource.includes("syncWorkflowEditableWorkerTasksUnlocked"));
assert.ok(workflowWorkerQueueSource.includes("rollback incomplete"));
assert.ok(workflowWorkerQueueSource.includes("reset-transaction-interrupted"));
const workflowJobLockSource = fs.readFileSync(path.join(process.cwd(), "server", "workflowJobLock.js"), "utf8");
assert.ok(workflowJobLockSource.includes("ppt-agent-job-locks"));
assert.ok(workflowJobLockSource.includes("WORKFLOW_JOB_LOCK_TIMEOUT"));
assert.ok(workflowJobLockSource.includes("LOCK_HEARTBEAT_MS"));
assert.ok(workflowJobLockSource.includes(".stale."));
assert.ok(workflowJobLockSource.includes("cleanupAbandonedWorkflowJobLocks"));
assert.ok(workflowJobLockSource.includes("INVALID_LOCK_GRACE_MS"));
assert.ok(workflowJobLockSource.includes("processStartedAt"));
assert.ok(workflowJobLockSource.includes("removeOwnedLeaseFile"));
const workflowPageRetrySource = fs.readFileSync(path.join(process.cwd(), "server", "workflowPageRetry.js"), "utf8");
assert.ok(workflowPageRetrySource.includes("attemptId: task.attemptId"));
assert.ok(workflowPageRetrySource.includes("leaseToken: task.leaseToken"));
assert.ok(workflowEditableSource.includes("reset is idempotently satisfied"));
assert.equal(cleanPublicError("Command failed: C:\\Program Files\\nodejs\\node.exe script.mjs --api-key sk-1234567890abcdef"), "页面 worker 命令未完成，页面产物没有记录。");
assert.equal(cleanPublicError('HTTP 400 {"error":{"message":"raw provider body with Bearer abcdefghijklmnop and sk-1234567890abcdef"}}'), "页面 worker 失败，原始错误已隐藏；请查看失败分析或受控日志。");
assert.equal(cleanPublicError("Worker command exited with code 1. Page artifacts were not recorded."), "页面 worker 命令未完成，页面产物没有记录。");
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowOcr.js"), "utf8").includes("maxPages"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowOcr.js"), "utf8").includes("normalizePages"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowWorkerBatchRunner.js"), "utf8").includes("getTextHintEvidence"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowWorkerBatchRunner.js"), "utf8").includes("localOcrTextHintsAccepted"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "server", "workflowEditable.js"), "utf8").includes("getLocalOcrTextHintsCheckpoint"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "visual-asset-helper.mjs"), "utf8").includes("process.env.OPENAI_IMAGE_MODEL"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "visual-asset-helper.mjs"), "utf8").includes("IMAGE_TO_EDITABLE_PPT_IMAGE_MODEL"));
assert.ok(frontendSource.includes("textHints.source"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".dual-dashboard"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".route-lane"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".product-v1-product-visual-sample-preflight"));
assert.ok(!fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".product-v1-real-deck"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".workflow-editable-prepare-preflight"));
assert.ok(!frontendSource.includes("api.jobs().then"));
assert.ok(!apiClientSource.includes("async jobs("));
assert.ok(!apiClientSource.includes("async job("));
assert.ok(!apiClientSource.includes("async designSystem("));
assert.ok(!indexSource.includes("/api/style-groups"));
assert.ok(!indexSource.includes("listStyleGroups"));
assert.ok(!storeSource.includes("styleGroups"));
assert.ok(!storeSource.includes("style_group"));
assert.ok(indexSource.includes("legacyTemplatesRemoved: true"));
assert.ok(frontendSource.includes("不是旧模板库"));
assert.ok(frontendSource.includes("真正调用外部图片生成服务前"));
assert.ok(frontendSource.includes("PPT 智能体工作台"));
assert.ok(frontendSource.includes("PPT Agent"));
assert.ok(!frontendSource.includes("设计方向控制台"));
assert.ok(!frontendSource.includes("模板 / 版式方向"));
assert.ok(!frontendSource.includes("startupJob"));
assert.ok(frontendSource.includes("WorkflowHistoryPanel"));
assert.ok(frontendSource.includes("jobs={workflowJobs}"));
assert.ok(!/visibleRightPanelMode === "history"[\s\S]{0,240}<HistoryPanel/.test(frontendSource));
assert.ok(frontendSource.includes("WorkflowSideStatusPanel"));
assert.ok(/visibleRightPanelMode === "status"[\s\S]{0,900}workflowJob \?/.test(frontendSource));
assert.ok(frontendSource.includes("workflow-side-status"));
assert.ok(frontendSource.includes("workflowJob={workflowJob}"));
assert.ok(frontendSource.includes("PPT 重制助手"));
assert.ok(frontendSource.includes("Agent 状态"));
assert.ok(!frontendSource.includes("双技能工作流助手"));
assert.ok(!frontendSource.includes("双技能状态"));
assert.ok(frontendSource.includes("重制现有 PPT"));
assert.ok(frontendSource.includes("从需求创建任务"));
assert.ok(!frontendSource.includes("从需求创建工作流"));
assert.ok(frontendSource.includes("未选择工作流"));
assert.ok(frontendSource.includes('["not_started", "未开始"]'));
assert.ok(!frontendSource.includes("PPT 助手"));
assert.ok(!frontendSource.includes("从零生成 PPT"));
assert.ok(!frontendSource.includes("优化现有 PPT"));
assert.ok(!frontendSource.includes("未选择 workflow"));
assert.ok(!frontendSource.includes('"not started"'));
assert.ok(frontendSource.includes("workflowJobId: workflowJob?.id"));
assert.ok(!frontendSource.includes("Conversational PPT director"));
assert.ok(!frontendSource.includes("waiting for input"));
assert.ok(!frontendSource.includes("one-click-panel"));
assert.ok(indexSource.includes("workflowJobId"));
assert.ok(indexSource.includes("const allJobs = await listWorkflowJobSummaries()"));
assert.ok(indexSource.includes("req.query?.limit || 120"));
assert.ok(indexSource.includes("const pagedSummaries = jobs.slice(offset, offset + limit)"));
assert.ok(indexSource.includes("readWorkflowJobsByIds(pagedSummaries.map((job) => job.id))"));
assert.ok(indexSource.includes("hasMore: offset + pagedSummaries.length < jobs.length"));
assert.ok(indexSource.includes("buildSkillFirstDirectorReply"));
assert.ok(indexSource.includes("getWorkflowComplianceStatus(workflowJob.id)"));
assert.ok(indexSource.includes("getWorkflowDeliveryStatus(workflowJob.id)"));
assert.ok(indexSource.includes("codex-ppt 负责视觉统一的图片型 PPT"));
assert.ok(guidedActionSource.includes("推荐下一步"));
assert.ok(guidedActionSource.includes("打开图片页任务"));
assert.ok(guidedActionSource.includes("准备 editppt"));
assert.ok(!/(\u93ba\u3128\u5d18|\u93b5\u64b3\u7d11|\u9351\u55d7\ue62c|\u6d93\u5b29\u7af4\u59dd|\u9365\u5267\u5896\u6924|\u9359\ue21c\u7d2a|\u6942\u6a3c\u9a87)/.test(guidedActionSource));
assert.ok(frontendSource.includes("api.planWorkflowOutline"));
assert.ok(frontendSource.includes("confirmOutlineAndStartWorkflow"));
assert.ok(frontendSource.includes("startSkillFirstWorkflow({ deliveryMode: pendingDeliveryMode })"));
assert.ok(!frontendSource.includes('onClick={() => setActiveStep("generate")} disabled={!outlinePlan?.layoutSequence?.length}>确认大纲并生成'));
assert.ok(!frontendSource.includes('/api/jobs/outline'));
assert.ok(apiClientSource.includes('/api/workflow-outline/plan'));
assert.ok(indexSource.includes('app.post("/api/workflow-outline/plan"'));
assert.ok(!indexSource.includes('app.get("/api/workflow-samples"'));
assert.ok(!apiClientSource.includes("workflowSamples"));
assert.ok(sourceRendererSource.includes("PDFTOPPM_PATH"));
assert.ok(sourceRendererSource.includes("PDFTOPPM_ARGS_PREFIX_JSON"));
assert.ok(sourceRendererSource.includes("pdftoppm"));
assert.ok(sourceRendererSource.includes("pdf-parse"));
assert.ok(sourceRendererSource.includes("renderPdfSourceWithPdfParse"));
assert.ok(sourceRendererSource.includes("page_"));
assert.ok(doctorSource.includes("pdf-renderer"));
assert.ok(doctorSource.includes("PDFTOPPM_PATH"));
assert.ok(doctorSource.includes("PDFTOPPM_ARGS_PREFIX_JSON"));
assert.ok(doctorSource.includes("PDF_PARSE_RENDER_WIDTH"));
assert.ok(doctorSource.includes("nextAction"));
assert.ok(frontendSource.includes('"pdf-renderer"'));
assert.ok(frontendSource.includes("check.nextAction"));
assert.ok(frontendSource.includes("PDF 渲染器"));
assert.ok(doctorSource.includes("image-to-editable-contract"));
assert.ok(doctorSource.includes("codex-ppt-contract"));
assert.ok(doctorSource.includes("v0.5.5-compatible"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "smoke-workflow-e2e.mjs"), "utf8").includes("confirmRouteB: true"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "smoke-workflow-e2e.mjs"), "utf8").includes("image-deck/review/pages/page_001"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "smoke-workflow-e2e.mjs"), "utf8").includes("synthetic image deck review approved"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "smoke-workflow-e2e.mjs"), "utf8").includes("synthetic visual quality evidence reviewed"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "smoke-workflow-e2e.mjs"), "utf8").includes('editableStatus.next?.stage === "rebuild_page_locally"'));
assert.ok(doctorSource.includes("image-edit-provider"));
assert.ok(doctorSource.includes("supportsImageEdit"));
assert.ok(frontendSource.includes("参考图重绘"));
assert.ok(workflowEditableSource.includes("inspectEditableSkillContract"));
assert.ok(workflowEditableSource.includes("singlePageLocalMode"));
assert.ok(workflowEditableSource.includes("multiPageWorkerDispatch"));
assert.ok(workflowEditableSource.includes("serialImageEdit"));
assert.ok(workflowEditableSource.includes("noFullSlideFallback"));
assert.ok(frontendSource.includes("image-to-editable-contract"));
assert.ok(workflowWorkerQueueSource.includes("enrichTaskEvidence"));
assert.ok(workflowWorkerQueueSource.includes("validationStatus"));
assert.ok(workflowWorkerQueueSource.includes("statusLabel"));
assert.ok(workflowWorkerQueueSource.includes("validationError"));
assert.ok(workflowWorkerQueueSource.includes("providerSnapshot"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "scripts", "model-page-spec-worker.mjs"), "utf8").includes("provider_snapshot"));
assert.ok(workflowWorkerQueueSource.includes("outputContractOk"));
assert.ok(workflowWorkerQueueSource.includes("outputContractIssues"));
assert.ok(workflowWorkerQueueSource.includes("pagePptxExists"));
assert.ok(workflowWorkerQueueSource.includes("pageResultExists"));
assert.ok(frontendSource.includes("task.statusLabel || workerTaskStatusLabel"));
assert.ok(frontendSource.includes("formatEditableTaskIssue(task)"));
assert.ok(frontendSource.includes("validationLabel"));
assert.ok(frontendSource.includes("v0.3-compatible"));
assert.ok(fs.readFileSync(path.join(process.cwd(), "src", "styles.css"), "utf8").includes(".product-doctor-grid em"));
assert.ok(frontendSource.includes("skill-first-review-notice"));
assert.ok(!frontendSource.includes("完成视觉方向和 SceneGraph 重建后"));
assert.ok(frontendSource.includes("WorkflowDeliveryPortal"));
assert.ok(frontendSource.includes("交付文件"));
assert.ok(!frontendSource.includes("双技能交付中心"));
assert.ok(workflowDeliverySource.includes("inspectInvalidatedFinal"));
assert.ok(workflowDeliverySource.includes("visualQaStatus"));
assert.ok(workflowDeliverySource.includes("visualQaPassed"));
assert.ok(workflowFinalEvidenceSource.includes("automatedStatus"));
assert.ok(workflowFinalEvidenceSource.includes("manualReviewStatus"));
assert.ok(workflowFinalEvidenceSource.includes('manualReviewStatus === "pending" ? "review"'));
assert.ok(!workflowFinalEvidenceSource.includes('blockingIssues.push("final-visual-qa-needs-review")'));
assert.ok(workflowDeliverySource.includes("!partialSourceCoverage && !codexPptEvidence.slideRunComplete"));
assert.ok(workflowDeliverySource.includes("已被 fresh editppt 运行作废"));
assert.ok(!frontendSource.includes("旧最终 PPT 已作废"));
assert.ok(frontendSource.includes("GenerationProgress"));
assert.ok(frontendSource.includes("StyleReferenceItem"));
assert.ok(frontendSource.includes("PreviewCanvas"));
assert.ok(frontendSource.includes("editable-draft.pptx"));
assert.ok(frontendSource.includes("isJobBlockedForFinal"));

const smokeTmpRoot = path.join(process.cwd(), "tmp");
fs.mkdirSync(smokeTmpRoot, { recursive: true });
const missingForegroundPageDir = fs.mkdtempSync(path.join(smokeTmpRoot, "missing-foreground-"));
fs.mkdirSync(path.join(missingForegroundPageDir, "assets"), { recursive: true });
fs.writeFileSync(path.join(missingForegroundPageDir, "page_request.json"), JSON.stringify({
  page_id: "page_001",
  run_id: "smoke_missing_foreground",
  source_size_px: { width: 1920, height: 1080 },
  slide: { width_px: 1920, height_px: 1080 },
  content_box: { x: 0, y: 0, w: 1920, h: 1080 }
}, null, 2));
fs.writeFileSync(path.join(missingForegroundPageDir, "page-rebuild-spec.json"), JSON.stringify({
  schema_version: 1,
  page_id: "page_001",
  slide: { width_px: 1920, height_px: 1080 },
  content_box: { x: 0, y: 0, w: 1920, h: 1080 },
  text_inventory: [],
  visual_inventory: [{
    id: "brand_logo",
    type: "image",
    kind: "logo",
    decision: "image-asset",
    path: "assets/missing-logo.png",
    description: "source-faithful logo that must be reused"
  }],
  background_strategy: {
    mode: "native-background",
    source_consistency_contract: "source visual elements must remain represented",
    comparison_note: "preserve source visual elements"
  },
  quality_checks: {
    font_size_calibrated: true,
    visual_inventory_matched: true,
    background_strategy_checked: true,
    shape_corner_geometry_checked: true
  },
  required_text: [],
  text_boxes: [],
  shapes: [],
  images: [{
    id: "brand_logo",
    path: "assets/missing-logo.png",
    box_px: [100, 100, 320, 160]
  }],
  asset_provenance: [{
    id: "brand_logo",
    path: "assets/missing-logo.png",
    source_type: "asset-sheet-separated",
    source: "source.png"
  }]
}, null, 2));
let missingForegroundFailed = false;
try {
  execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "page-rebuild-assembler.mjs"), "--page-dir", missingForegroundPageDir], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env, PPT_WORKFLOW_JOB_ID: "smoke_missing_foreground" }
  });
} catch (error) {
  missingForegroundFailed = true;
  const text = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;
  assert.match(text, /image file does not exist|Foreground visual inventory requires real image assets/i);
}
assert.equal(missingForegroundFailed, true);
const missingForegroundValidation = JSON.parse(fs.readFileSync(path.join(missingForegroundPageDir, "validation.json"), "utf8"));
assert.equal(missingForegroundValidation.passed, false);

console.log("smoke tests passed");
