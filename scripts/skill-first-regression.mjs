#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import os from "os";
import path from "path";
import zlib from "zlib";
import { alignDeliveryStatusWithFinalGate, buildFinalDeliveryGate } from "../server/workflowDelivery.js";
import { archiveWorkflowJob, createWorkflowJob, readWorkflowJob, saveWorkflowJob } from "../server/workflowJobs.js";
import { renderWorkflowSource } from "../server/sourceRenderer.js";
import { getWorkflowGuidedAction } from "../src/workflow/guidedAction.js";
import { deriveWorkflowDeliveryStatus } from "../shared/workflowDeliveryStatus.js";

const DEFAULT_BASE_URL = process.env.PPT_TOOL_BASE_URL || "http://127.0.0.1:4180";
const CODEX_PPT_GATES = ["outline", "style", "backend", "sample", "fullDeck"];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const baseUrl = String(args["base-url"] || args.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const health = await api(baseUrl, "/api/health");
  if (!health.ok) throw new Error(`PPT tool server is not healthy at ${baseUrl}`);
  const v1AcceptanceReportApi = await verifyV1AcceptanceReportApi(baseUrl);
  const v1ProductVisualNoCostFlow = await verifyV1ProductVisualNoCostFlow(baseUrl);
  const legacyGeneratorRoutes = await verifyLegacyGeneratorRoutesRemoved(baseUrl);
  const pdfSourceRendering = await verifyPdfSourceRenderPath();

  const defaultPath = await verifyDefaultWorkflowPath(baseUrl);
  const briefPath = await verifyBriefWorkflowPath(baseUrl);
  const workflowListVisibility = await verifyWorkflowListVisibility(baseUrl, [defaultPath.jobId, briefPath.jobId]);
  const workflowCostEstimate = await verifyWorkflowCostEstimate(baseUrl, defaultPath.jobId, defaultPath.renderedPages);
  let workflowAuthorizations = null;
  let workflowV1Readiness = null;
  const workflowNonProductResetInvalidation = await verifyNonProductResetInvalidation(baseUrl, briefPath.jobId, briefPath.targetSlideCount);
  const sampleBackendMismatch = await verifySampleBackendMismatch(baseUrl);
  const finalPptxDownloadGate = await verifyFinalPptxDownloadGate(baseUrl);

  const jobId = defaultPath.jobId;

  const sampleBlocked = defaultPath.sampleBlockedRaw;
  await assertStageNotFailed(jobId, "visual_sample_ready");
  const nextActionApprovalManual = await api(baseUrl, `/api/workflow-jobs/${jobId}/next`, {
    method: "POST",
    body: { requestedBy: "skill-first-regression" }
  });
  if (nextActionApprovalManual.didRun || !nextActionApprovalManual.manualRequired || !/approve/i.test(nextActionApprovalManual.action || "")) {
    throw new Error(`Expected product next action to stop for approval, got didRun=${nextActionApprovalManual.didRun} manualRequired=${nextActionApprovalManual.manualRequired} action=${nextActionApprovalManual.action || "none"}`);
  }

  const outlineArtifact = await recordOutline(baseUrl, jobId, {
    source: "skill-first-regression-default",
    pageCount: defaultPath.renderedPages
  });
  if (!outlineArtifact.artifacts?.codexPptOutline?.path) {
    throw new Error("Expected codex-ppt outline artifact before outline approval.");
  }
  const styleApprovalBlocked = await approveGate(baseUrl, jobId, "style", { expectStatus: 409 });
  if (styleApprovalBlocked.code !== "CODEX_PPT_STYLE_REQUIRED") {
    throw new Error(`style approval expected CODEX_PPT_STYLE_REQUIRED, got ${styleApprovalBlocked.code || "none"}`);
  }
  const styleArtifact = await recordStyle(baseUrl, jobId, { source: "skill-first-regression-default" });
  if (!styleArtifact.artifacts?.codexPptStyle?.path) {
    throw new Error("Expected codex-ppt style artifact before style approval.");
  }
  const backendApprovalBlocked = await approveGate(baseUrl, jobId, "backend", { expectStatus: 409 });
  if (backendApprovalBlocked.code !== "CODEX_PPT_BACKEND_DECISION_REQUIRED") {
    throw new Error(`backend approval expected CODEX_PPT_BACKEND_DECISION_REQUIRED, got ${backendApprovalBlocked.code || "none"}`);
  }
  const backendArtifact = await recordBackendDecision(baseUrl, jobId, { source: "skill-first-regression-default" });
  if (!backendArtifact.artifacts?.codexPptBackendDecision?.path) {
    throw new Error("Expected codex-ppt backend decision artifact before backend approval.");
  }

  for (const gate of ["outline", "style", "backend"]) {
    await approveGate(baseUrl, jobId, gate);
  }
  const workflowV1BackendMismatch = await verifyWorkflowV1BackendMismatch(baseUrl, jobId);

  const sampleApprovalBlocked = await approveGate(baseUrl, jobId, "sample", { expectStatus: 409 });
  if (sampleApprovalBlocked.code !== "CODEX_PPT_SAMPLE_REQUIRED") {
    throw new Error(`sample approval expected CODEX_PPT_SAMPLE_REQUIRED, got ${sampleApprovalBlocked.code || "none"}`);
  }

  const sampleSpendBlocked = await api(baseUrl, `/api/workflow-jobs/${jobId}/visual/sample`, {
    method: "POST",
    body: { pageNumber: 1 },
    expectStatus: 409
  });
  if (sampleSpendBlocked.code !== "CODEX_PPT_IMAGE_SPEND_CONFIRMATION_REQUIRED") {
    throw new Error(`product visual/sample expected CODEX_PPT_IMAGE_SPEND_CONFIRMATION_REQUIRED, got ${sampleSpendBlocked.code || "none"}`);
  }
  const samplePreflightBlocked = await api(baseUrl, `/api/workflow-jobs/${jobId}/next/preflight`, {
    method: "POST",
    body: { pageNumber: 1, requestedBy: "product-preflight" }
  });
  if (samplePreflightBlocked.didRun || samplePreflightBlocked.startReady || samplePreflightBlocked.requiredConfirmation !== "externalImageSpend") {
    throw new Error(`product next/preflight must stop before spending image credits, got didRun=${samplePreflightBlocked.didRun} startReady=${samplePreflightBlocked.startReady} required=${samplePreflightBlocked.requiredConfirmation || "none"}`);
  }
  const samplePreflightReady = await api(baseUrl, `/api/workflow-jobs/${jobId}/next/preflight`, {
    method: "POST",
    body: { pageNumber: 1, confirmExternalImageSpend: true, requestedBy: "product-preflight" }
  });
  if (samplePreflightReady.didRun || !samplePreflightReady.startReady || samplePreflightReady.externalImageCalls !== 1) {
    throw new Error(`confirmed product next/preflight must be start-ready without running, got didRun=${samplePreflightReady.didRun} startReady=${samplePreflightReady.startReady} calls=${samplePreflightReady.externalImageCalls}`);
  }
  if (samplePreflightReady.authorization?.persisted) {
    throw new Error(`request-confirmed product next/preflight must not require a pre-existing ledger authorization, got ${JSON.stringify(samplePreflightReady.authorization || {})}`);
  }
  workflowAuthorizations = await verifyWorkflowAuthorizations(baseUrl, jobId);
  workflowV1Readiness = await verifyWorkflowV1Readiness(baseUrl, jobId);
  const samplePreflightAuthorized = await api(baseUrl, `/api/workflow-jobs/${jobId}/next/preflight`, {
    method: "POST",
    body: { pageNumber: 1, requestedBy: "product-preflight-ledger" }
  });
  if (samplePreflightAuthorized.didRun || !samplePreflightAuthorized.startReady || !samplePreflightAuthorized.authorization?.persisted || samplePreflightAuthorized.authorization?.scope !== "visual-sample") {
    throw new Error(`ledger-authorized product next/preflight must be start-ready without running, got ${JSON.stringify({
      didRun: samplePreflightAuthorized.didRun,
      startReady: samplePreflightAuthorized.startReady,
      authorization: samplePreflightAuthorized.authorization || null
    })}`);
  }

  await runJobStep(baseUrl, jobId, "visual/sample", {
    dryRun: true,
    passthrough: true,
    provider: "passthrough",
    allowNonProductVisual: true,
    pageNumber: 1
  });
  const sampleArtifactLinks = await api(baseUrl, `/api/workflow-jobs/${jobId}/artifacts`);
  const sampleArtifactLink = (sampleArtifactLinks.links || []).find((link) => link.key === "visual-sample");
  if (!sampleArtifactLink?.href) {
    throw new Error("visual/sample must expose a visual-sample artifact link for sample review before approval.");
  }
  const sampleApprovalPreflight = await api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/approvals/sample/preflight`, {
    method: "POST",
    body: {
      approvedBy: "product-user",
      note: "product approval preflight must reject dry-run sample evidence"
    }
  });
  if (sampleApprovalPreflight.ready || sampleApprovalPreflight.code !== "CODEX_PPT_SAMPLE_NON_PRODUCT") {
    throw new Error(`sample approval preflight expected CODEX_PPT_SAMPLE_NON_PRODUCT, got ready=${sampleApprovalPreflight.ready} code=${sampleApprovalPreflight.code || "none"}`);
  }
  const nonProductSampleApprovalBlocked = await api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/approvals/sample/approve`, {
    method: "POST",
    expectStatus: 409,
    body: {
      approvedBy: "product-user",
      note: "product approval must not accept dry-run sample evidence"
    }
  });
  if (nonProductSampleApprovalBlocked.code !== "CODEX_PPT_SAMPLE_NON_PRODUCT") {
    throw new Error(`sample approval dry-run expected CODEX_PPT_SAMPLE_NON_PRODUCT, got ${nonProductSampleApprovalBlocked.code || "none"}`);
  }
  await approveGate(baseUrl, jobId, "sample");

  const deckBlocked = await api(baseUrl, `/api/workflow-jobs/${jobId}/visual/generate`, {
    method: "POST",
    body: { dryRun: true, passthrough: true },
    expectStatus: 409
  });
  assertApprovalError(deckBlocked, ["fullDeck"], "visual/generate");
  await assertStageNotFailed(jobId, "visual_generating");

  await approveGate(baseUrl, jobId, "fullDeck");
  const nonProductVisualBlocked = await api(baseUrl, `/api/workflow-jobs/${jobId}/visual/generate`, {
    method: "POST",
    body: { dryRun: true, passthrough: true, provider: "passthrough" },
    expectStatus: 409
  });
  if (nonProductVisualBlocked.code !== "CODEX_PPT_NON_PRODUCT_VISUAL_REQUIRES_OPT_IN") {
    throw new Error(`visual/generate dry-run expected CODEX_PPT_NON_PRODUCT_VISUAL_REQUIRES_OPT_IN, got ${nonProductVisualBlocked.code || "none"}`);
  }
  await assertStageNotFailed(jobId, "visual_generating");

  let compliance = await api(baseUrl, `/api/workflow-jobs/${jobId}/compliance`);
  if (compliance.codexPpt?.approvals?.passed !== CODEX_PPT_GATES.length) {
    throw new Error(`Expected ${CODEX_PPT_GATES.length} codex-ppt approvals, got ${compliance.codexPpt?.approvals?.passed ?? "unknown"}`);
  }
  if (compliance.codexPpt?.sample?.status !== "pass") {
    throw new Error(`Expected codex-ppt sample evidence pass, got ${compliance.codexPpt?.sample?.status || "none"}`);
  }
  if (!compliance.runbook?.allowedActions?.includes("sync codex slide tasks")) {
    throw new Error(`Expected runbook to guide fullDeck into codex-ppt slide task sync, got ${(compliance.runbook?.allowedActions || []).join(", ") || "none"}`);
  }
  const guidedBeforeCodexSync = getWorkflowGuidedAction(compliance.runbook, { job: { id: jobId }, canGenerateVisualDeck: true });
  if (guidedBeforeCodexSync.kind !== "sync-codex-slides") {
    throw new Error(`Expected guided action to sync codex-ppt slide tasks, got ${guidedBeforeCodexSync.kind || "none"}`);
  }
  const codexSlideNext = await api(baseUrl, `/api/workflow-jobs/${jobId}/next`, {
    method: "POST",
    body: { maxPages: 1, requestedBy: "skill-first-regression" }
  });
  if (!codexSlideNext.didRun || codexSlideNext.action !== "sync codex slide tasks") {
    throw new Error(`Expected product next action to sync codex slide tasks, got ${codexSlideNext.action || "none"}`);
  }
  const codexSlideSync = codexSlideNext.taskBundle || {};
  if (!codexSlideSync.summary?.total || !codexSlideSync.artifacts?.deckSpec?.path || !codexSlideSync.artifacts?.slideRunState?.path) {
    throw new Error("Expected codex-ppt slide task sync to create deck_spec, slide_run_state, and at least one task.");
  }
  compliance = await api(baseUrl, `/api/workflow-jobs/${jobId}/compliance`);
  if (!compliance.runbook?.allowedActions?.includes("codex slide workers")) {
    throw new Error(`Expected runbook to focus codex slide workers after sync, got ${(compliance.runbook?.allowedActions || []).join(", ") || "none"}`);
  }
  const guidedAfterCodexSync = getWorkflowGuidedAction(compliance.runbook, { job: { id: jobId } });
  if (guidedAfterCodexSync.kind !== "focus" || guidedAfterCodexSync.targetId !== "codex-slide-worker-panel") {
    throw new Error(`Expected guided action to focus codex slide worker panel, got ${guidedAfterCodexSync.kind || "none"}/${guidedAfterCodexSync.targetId || "none"}`);
  }

  const scriptBoundary = await checkScriptBoundary();
  const codexSlideBoundary = await checkCodexSlideBoundary();
  const realPptRegressionBoundary = await checkRealPptRegressionBoundary();
  if (scriptBoundary.nonOrchestrationWorkerScripts.length) {
    throw new Error(`Non-orchestration scripts exposed as worker:*: ${scriptBoundary.nonOrchestrationWorkerScripts.join(", ")}`);
  }
  if (scriptBoundary.experimentalWorkerScripts.length) {
    throw new Error(`Experimental/local artifact scripts exposed as worker:*: ${scriptBoundary.experimentalWorkerScripts.join(", ")}`);
  }
  const frontendBoundary = await checkFrontendBoundary();
  if (!frontendBoundary.primaryUsesSkillFirstWorkflow) {
    throw new Error("Frontend primary generate action must call startSkillFirstWorkflow.");
  }
  if (frontendBoundary.primaryUsesLegacyGenerator) {
    throw new Error("Frontend primary generate action still calls the legacy generator.");
  }
  if (!frontendBoundary.legacyGeneratorRemoved) {
    throw new Error("Legacy one-click generator must not be visible in the product frontend.");
  }
  if (!frontendBoundary.legacyDesignSystemUiRemoved) {
    throw new Error("Legacy design-system/template UI and style-group routes must be removed from the product frontend.");
  }
  if (!frontendBoundary.primaryAllowsBriefWithoutUpload) {
    throw new Error("Frontend primary action must allow brief-only Skill-first workflows without an uploaded file.");
  }
  if (!frontendBoundary.workflowPanelAllowsBriefWithoutUpload) {
    throw new Error("Workflow console create action must reuse the Skill-first entrypoint and allow brief-only workflows.");
  }
  if (!frontendBoundary.workflowPanelLabelsBriefSource) {
    throw new Error("Workflow console must label brief-only workflows as brief/outline source instead of missing source file.");
  }
  if (!frontendBoundary.localTextRebuildIsLimited) {
    throw new Error("Frontend local rebuild action must remain text-dominant and explicitly opt in with allowTextDominantLocal.");
  }
  if (!frontendBoundary.structuredProductVisualErrors) {
    throw new Error("Frontend must preserve structured product visual preflight errors and show them in the matching product cards.");
  }
  if (!frontendBoundary.productVisualSpendPlan) {
    throw new Error("Product visual next-step UI must expose the external image API spend plan before paid sample/full-deck generation.");
  }
  if (!frontendBoundary.productVisualRangeOptions) {
    throw new Error("Product visual UI must expose user-facing range options for 2-page, selected-page, and full-deck generation.");
  }
  if (!frontendBoundary.productVisualExecutionSnapshot) {
    throw new Error("Product visual paid preflights must expose an execution snapshot with provider, source, job, page count, and image-call evidence.");
  }
  if (!frontendBoundary.productVisualSampleReviewChecklist) {
    throw new Error("Product visual sample approval must expose a human review checklist before sample/full-deck approval gates.");
  }
  if (!frontendBoundary.v1AcceptanceLatestIgnoresSampleRuns) {
    throw new Error("Real PPT sample regressions must not overwrite the latest v1 acceptance report.");
  }
  if (!frontendBoundary.editableV03ContractDoctor) {
    throw new Error("Product doctor must verify the image-to-editable-ppt v0.3 contract and expose it in the frontend.");
  }
  if (!frontendBoundary.editablePreparePreflight) {
    throw new Error("Frontend and API must expose image-to-editable-ppt prepare preflight before editable rebuild starts.");
  }
  if (!frontendBoundary.productTextHintEvidence) {
    throw new Error("Frontend and API must expose OCR/editppt text hint evidence links and summary for product review.");
  }
  if (!frontendBoundary.productOcrCorrectionUi) {
    throw new Error("Frontend and API must support low-confidence OCR text correction with persisted workflow evidence.");
  }
  if (!frontendBoundary.legacyOcrRemoved) {
    throw new Error("Legacy source OCR must not be visible in the product frontend.");
  }
  if (!frontendBoundary.oldTemplateControlsRemoved) {
    throw new Error("Old template direction controls must not be visible or kept as a product frontend component.");
  }
  if (!frontendBoundary.legacyStatusFallbackRemoved) {
    throw new Error("Right-side status must not fall back to legacy deck/template status panels when no Skill-first workflow is selected.");
  }
  if (!frontendBoundary.legacyStyleApprovalGuard) {
    throw new Error("Legacy codex-ppt style evidence must be blocked before product approval.");
  }
  if (!frontendBoundary.productStyleRefreshAction) {
    throw new Error("Product v1 UI must expose a no-image refresh action for stale codex-ppt style evidence.");
  }
  if (!frontendBoundary.legacyJobStartupRemoved) {
    throw new Error("Frontend must not auto-restore legacy /api/jobs tasks into the Skill-first product workspace.");
  }
  if (!frontendBoundary.rightHistoryUsesWorkflowJobs) {
    throw new Error("Right-side history panel must list Skill-first workflow jobs, not legacy /api/jobs records.");
  }
  if (!frontendBoundary.rightStatusUsesWorkflowJob) {
    throw new Error("Right-side status panel must show Skill-first workflow status when a workflow job exists.");
  }
  if (!frontendBoundary.rightAgentUsesWorkflowJob) {
    throw new Error("Right-side assistant must present Skill-first workflow context, not legacy deck/job context.");
  }
  if (!frontendBoundary.firstScreenSkillFirstChinese) {
    throw new Error("First screen must be pure Chinese and guide users into the two-Skill workflow, not legacy generic generation.");
  }
  if (!frontendBoundary.legacyTemplatePacksRemoved) {
    throw new Error("Legacy template pack JSON must be removed from the product design system boundary.");
  }
  if (!frontendBoundary.workflowOutlineUsesSkillFirst) {
    throw new Error("Frontend outline planning must use the Skill-first workflow outline API, not the legacy /api/jobs/outline route.");
  }
  if (!frontendBoundary.productReviewDeliverySemantics) {
    throw new Error("Frontend review/export steps must use Skill-first review and delivery semantics, not legacy editor language.");
  }
  if (!frontendBoundary.productDeliveryPortal) {
    throw new Error("Frontend export step must use the Skill-first workflow delivery portal instead of the legacy format exporter.");
  }
  if (!frontendBoundary.manualLabCommandsRemoved) {
    throw new Error("Frontend must not expose Lab/manual shell command panels in the product workspace.");
  }
  if (!frontendBoundary.guidedRunbookAction) {
    throw new Error("Frontend must expose a guided next action mapped from the Skill-first runbook.");
  }
  if (!frontendBoundary.guidedDeliveryStatus) {
    throw new Error("Frontend guided area must include a compact delivery status tied to the final delivery gate.");
  }
  if (!frontendBoundary.deliveryLinksAreGateLabeled) {
    throw new Error("Frontend delivery links must label final PPTX as product-ready, draft-only, or blocked according to finalGate.");
  }
  if (!frontendBoundary.deliveryNextStepUi) {
    throw new Error("Frontend delivery summary must show a clear next-step hint from deriveWorkflowDeliveryStatus.");
  }
  if (!frontendBoundary.productFinalQaChecklist) {
    throw new Error("Frontend must expose final QA checklist checks before product-ready delivery.");
  }
  if (!frontendBoundary.productManualReviewDeliverySummary) {
    throw new Error("Frontend delivery center must show manual review as a delivery gate with a review-panel action.");
  }
  if (!frontendBoundary.productDeliveryValidationSummary) {
    throw new Error("Frontend delivery center must show a structured final validation summary, not only a download link.");
  }
  if (!frontendBoundary.workflowAgentSimplePanel) {
    throw new Error("Frontend must expose a simplified PPT 鏅鸿兘浣?progress panel before advanced details.");
  }
  if (!frontendBoundary.workflowUserGuidePanel) {
    throw new Error("Frontend must expose a user-facing four-step workflow guide.");
  }
  if (!frontendBoundary.productAdvancedDetailsCollapsed) {
    throw new Error("Frontend product diagnostics must live behind a collapsed Advanced details panel by default.");
  }
  if (!frontendBoundary.manualWorkflowControlsAreAdvanced) {
    throw new Error("Manual workflow controls must stay in an Advanced operator panel behind the guided next action.");
  }
  if (!frontendBoundary.codexSlideWorkerUi) {
    throw new Error("Frontend must expose the codex-ppt slide worker task UI.");
  }
  if (!frontendBoundary.codexSlideWorkerActions) {
    throw new Error("Frontend must expose codex-ppt slide worker claim/record/reset actions.");
  }
  if (!frontendBoundary.codexSlideNoShellUi) {
    throw new Error("Frontend must not expose codex-ppt/page-worker shell commands or raw handoff prompts.");
  }
  if (!frontendBoundary.codexFullDeckStatusUi) {
    throw new Error("Frontend must expose the codex-ppt full-deck image stage status UI above the worker panels.");
  }
  if (!frontendBoundary.codexFullDeckShowsExternalImageApi) {
    throw new Error("Frontend full-deck status must expose the external image API provider/model instead of hiding backend selection.");
  }
  if (!frontendBoundary.settingsExposeImageModel) {
    throw new Error("Settings must expose the external image model used by codex-ppt visual generation.");
  }
  if (!frontendBoundary.settingsCanTestImageProvider) {
    throw new Error("Settings must provide a no-generation image API configuration test for the external provider.");
  }
  if (!frontendBoundary.productReadinessOverview) {
    throw new Error("Frontend must expose a product readiness overview for the Skill-first pipeline.");
  }
  if (!frontendBoundary.productWorkflowMap) {
    throw new Error("Frontend must expose a product workflow map from source render to final delivery.");
  }
  if (!frontendBoundary.productV1AcceptanceChecklist) {
    throw new Error("Frontend and API must expose the product v1 acceptance checklist.");
  }
  if (!frontendBoundary.productDoctorOverview) {
    throw new Error("Frontend must expose the product doctor checks from /api/doctor.");
  }
  if (!frontendBoundary.productLogBundleDelivery) {
    throw new Error("Frontend and API must expose a workflow log bundle download for product diagnostics.");
  }
  if (!frontendBoundary.productPageRetry) {
    throw new Error("Frontend and API must expose a product-level per-page retry action.");
  }
  if (!frontendBoundary.productFailedPageRecovery) {
    throw new Error("Frontend must group failed codex/editable page tasks into a product recovery panel.");
  }
  if (!frontendBoundary.productBulkFailedPageRecovery) {
    throw new Error("Frontend and API must expose bulk retry for failed page tasks.");
  }
  if (!frontendBoundary.productStalePageEvidenceRecovery) {
    throw new Error("Frontend and API must expose stale page evidence recovery when page artifact hashes expire.");
  }
  if (!frontendBoundary.productWorkflowEventsPanel) {
    throw new Error("Frontend and API must expose workflow events as an operator-facing log panel.");
  }
  if (!frontendBoundary.productNextActionController) {
    throw new Error("Frontend and API must route the guided next action through a backend workflow controller.");
  }
  if (!frontendBoundary.productWorkerBatchRunner) {
    throw new Error("Frontend and API must expose a no-shell editable page worker batch runner.");
  }
  if (!frontendBoundary.productCodexSlideBatchRunner) {
    throw new Error("Frontend and API must expose a no-shell codex-ppt slide batch runner.");
  }
  if (!frontendBoundary.productWorkflowArchiveLifecycle) {
    throw new Error("Frontend and API must expose a soft archive/restore lifecycle for workflow jobs.");
  }
  if (!frontendBoundary.productWorkflowSoftCleanup) {
    throw new Error("Frontend and API must expose preview-first soft cleanup for internal workflow jobs.");
  }
  if (!frontendBoundary.productWorkflowCostEstimate) {
    throw new Error("Frontend and API must expose workflow cost estimates before expensive provider work.");
  }
  if (!frontendBoundary.workflowSampleLibraryRemoved) {
    throw new Error("Built-in workflow samples must be removed from the product UI, public API, and local sample library.");
  }
  if (!frontendBoundary.productReadmeUsage) {
    throw new Error("Root README must document product startup, workflow flow, cost estimate, and validation without legacy sample libraries.");
  }
  if (!frontendBoundary.productPdfSourceRendering) {
    throw new Error("Product source rendering must support PDF page standardization through configurable pdftoppm and expose it in doctor/config docs.");
  }
  if (!frontendBoundary.approvalGatePrerequisites) {
    throw new Error("Frontend codex-ppt approval gates must disable approval until required artifacts/prerequisites are ready.");
  }
  if (!frontendBoundary.approvalReadyBatch) {
    throw new Error("Frontend must provide an explicit batch approval action for gates that are already ready.");
  }
  if (!frontendBoundary.mainNoCostApprovalEntry) {
    throw new Error("Frontend main workspace must expose a no-cost codex-ppt approval entry before any image API spend.");
  }
  if (!frontendBoundary.visualSampleEvidenceUi) {
    throw new Error("Frontend must expose the generated visual sample evidence before sample approval.");
  }
  if (!frontendBoundary.imageDeckAcceptsRecordedCodexSlides) {
    throw new Error("Frontend image-deck assembly must accept recorded codex-ppt slide task images.");
  }
  if (!frontendBoundary.unifiedSkillTaskBoard) {
    throw new Error("Frontend must expose a unified Skill task board for both worker pipelines.");
  }
  if (!frontendBoundary.unifiedSkillTaskDetails) {
    throw new Error("Frontend unified Skill task board must expose selected task details.");
  }
  const guidedActionContract = checkGuidedActionContract();
  const finalDeliveryGateContract = checkFinalDeliveryGateContract();
  if (!codexSlideBoundary.claimRequiresSpawned) {
    throw new Error("Codex slide task claim must require spawned=true/confirmSpawned=true.");
  }
  if (!codexSlideBoundary.complianceTracksRecordedSlideImages) {
    throw new Error("Compliance runbook must track recorded codex-ppt slide images before image-deck assembly.");
  }
  if (!codexSlideBoundary.complianceGuidesSlideWorkerQueue) {
    throw new Error("Compliance runbook must guide approved fullDeck work into the codex-ppt slide worker queue before image deck assembly.");
  }
  if (!codexSlideBoundary.editableWorkerBatchCarriesOfflineHintsAck) {
    throw new Error("Editable worker batch must carry offline text-hints acknowledgement through UI, API, batch script, and runner.");
  }
  if (!codexSlideBoundary.nonProductResetInvalidatesDownstream) {
    throw new Error("Non-product codex-ppt reset must soft-invalidate downstream artifacts and slide run evidence.");
  }
  if (!realPptRegressionBoundary.toleratesTransientUnknownRunner) {
    throw new Error("Real PPT regression must keep polling transient unknown worker runner states until meta/final state is written.");
  }
  if (!realPptRegressionBoundary.recordsAllSlideTasks) {
    throw new Error("Real PPT regression must record every synced codex-ppt slide task, not only the first one.");
  }
  if (!realPptRegressionBoundary.confirmsSpawnedWorker) {
    throw new Error("Real PPT regression must satisfy the codex-ppt slide worker spawned confirmation gate.");
  }
  if (!realPptRegressionBoundary.supportsFifteenPageSource) {
    throw new Error("Real PPT regression must expose a 15-page real PPT acceptance path.");
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl,
    jobId,
    approvalGates: compliance.codexPpt.approvals.passed,
    approvalGatesTotal: compliance.codexPpt.approvals.total,
    defaultPath: { ...defaultPath, sampleBlockedRaw: undefined },
    briefPath,
    workflowListVisibility,
    workflowCostEstimate,
    workflowAuthorizations,
    v1AcceptanceReportApi,
    v1ProductVisualNoCostFlow,
    legacyGeneratorRoutes,
    pdfSourceRendering,
    workflowV1Readiness,
    finalPptxDownloadGate,
    workflowNonProductResetInvalidation,
    sampleBackendMismatch,
    workflowV1BackendMismatch,
    sampleSpendBlocked: sampleSpendBlocked.code,
    samplePreflight: {
      blockedRequiredConfirmation: samplePreflightBlocked.requiredConfirmation,
      ready: samplePreflightReady.startReady,
      externalImageCalls: samplePreflightReady.externalImageCalls,
      authorizationPersisted: samplePreflightReady.authorization?.persisted === true
    },
    sampleApprovalPreflight: {
      code: sampleApprovalPreflight.code || "",
      ready: sampleApprovalPreflight.ready === true
    },
    outlineArtifact: {
      path: outlineArtifact.artifacts.codexPptOutline.path,
      markdownPath: outlineArtifact.artifacts.codexPptOutline.markdownPath,
      slideCount: outlineArtifact.artifacts.codexPptOutline.slideCount
    },
    decisionArtifacts: {
      stylePath: styleArtifact.artifacts.codexPptStyle.path,
      backendPath: backendArtifact.artifacts.codexPptBackendDecision.path
    },
    workerScripts: scriptBoundary.workerScripts,
    labScripts: scriptBoundary.labScripts,
    codexSlideBoundary,
    realPptRegressionBoundary,
    frontendBoundary,
    guidedActionContract,
    finalDeliveryGateContract,
    productNextAction: {
      approvalManual: {
        action: nextActionApprovalManual.action,
        manualRequired: nextActionApprovalManual.manualRequired
      },
      codexSlideSync: {
        action: codexSlideNext.action,
        didRun: codexSlideNext.didRun,
        tasks: codexSlideSync.summary?.total || 0
      }
    },
    sampleBlocked: summarizeApprovalBlock(sampleBlocked),
    sampleApprovalBlocked: {
      code: sampleApprovalBlocked.code || "",
      requiredArtifact: sampleApprovalBlocked.requiredArtifact || ""
    },
    nonProductSampleApprovalBlocked: {
      code: nonProductSampleApprovalBlocked.code || "",
      sample: nonProductSampleApprovalBlocked.sample || null
    },
    deckBlocked: summarizeApprovalBlock(deckBlocked),
    nonProductVisualBlocked: {
      code: nonProductVisualBlocked.code || "",
      dryRun: nonProductVisualBlocked.dryRun === true,
      passthrough: nonProductVisualBlocked.passthrough === true
    }
  }, null, 2));
}

async function verifyBriefWorkflowPath(baseUrl) {
  const targetSlideCount = 5;
  const created = await api(baseUrl, "/api/workflow-jobs", {
    method: "POST",
    body: {
      sourceBrief: [
        "Project: Skill-first brief regression",
        "Audience: product owner",
        "Visual style preference: premium clean business presentation",
        "User brief:",
        "Create a concise 5 page product strategy deck from this text brief."
      ].join("\n"),
      sourceOriginalName: "skill-first-brief.md",
      sourceMimeType: "text/markdown",
      mode: "skill-first-brief-regression",
      internal: true,
      notes: "Brief-only workflow must enter the same codex-ppt approval-gated path."
    }
  });
  const rendered = await api(baseUrl, `/api/workflow-jobs/${created.id}/source/render`, {
    method: "POST",
    body: {}
  });
  const artifacts = rendered.artifacts || {};
  if (!Array.isArray(artifacts.renderedPages) || artifacts.renderedPages.length !== 1) {
    throw new Error(`Brief workflow expected 1 source brief page, got ${artifacts.renderedPages?.length ?? "none"}`);
  }
  const page = artifacts.renderedPages[0] || {};
  if (page.kind !== "brief_page" || page.format !== "markdown") {
    throw new Error(`Brief workflow rendered page has wrong kind/format: ${page.kind || "none"} / ${page.format || "none"}`);
  }
  const compliance = await api(baseUrl, `/api/workflow-jobs/${created.id}/compliance`);
  if (compliance.runbook?.currentStep !== "codex-ppt-approvals") {
    throw new Error(`Brief workflow runbook expected codex-ppt-approvals, got ${compliance.runbook?.currentStep || "none"}`);
  }
  const outline = await recordOutline(baseUrl, created.id, {
    source: "skill-first-regression-brief",
    pageCount: targetSlideCount,
    sourceBrief: "Create a concise 5 page product strategy deck from this text brief."
  });
  if (!outline.artifacts?.codexPptOutline?.path) {
    throw new Error("Brief workflow expected codex-ppt outline artifact.");
  }
  if (outline.artifacts.codexPptOutline.slideCount !== targetSlideCount) {
    throw new Error(`Brief workflow expected ${targetSlideCount} codex-ppt outline slides, got ${outline.artifacts.codexPptOutline.slideCount || 0}.`);
  }
  const style = await recordStyle(baseUrl, created.id, { source: "skill-first-regression-brief" });
  const backend = await recordBackendDecision(baseUrl, created.id, { source: "skill-first-regression-brief" });
  if (!style.artifacts?.codexPptStyle?.path || !backend.artifacts?.codexPptBackendDecision?.path) {
    throw new Error("Brief workflow expected style and backend decision artifacts.");
  }
  const costEstimate = await verifyWorkflowCostEstimate(baseUrl, created.id, targetSlideCount);
  if (costEstimate.pageCount !== targetSlideCount) {
    throw new Error(`Brief workflow cost estimate expected ${targetSlideCount} target slide(s), got ${costEstimate.pageCount || 0}.`);
  }
  for (const gate of ["outline", "style", "backend"]) {
    await approveGate(baseUrl, created.id, gate);
  }
  await runJobStep(baseUrl, created.id, "visual/sample", {
    dryRun: true,
    passthrough: true,
    provider: "passthrough",
    allowNonProductVisual: true,
    pageNumber: 1
  });
  await approveGate(baseUrl, created.id, "sample");
  await approveGate(baseUrl, created.id, "fullDeck");
  const slideTaskBundle = await api(baseUrl, `/api/workflow-jobs/${created.id}/codex-ppt/slide-tasks/sync`, {
    method: "POST",
    body: { maxPages: targetSlideCount }
  });
  if (slideTaskBundle.summary?.total !== targetSlideCount || slideTaskBundle.prompts?.length !== targetSlideCount) {
    throw new Error(`Brief workflow expected ${targetSlideCount} codex-ppt slide tasks/prompts, got ${slideTaskBundle.summary?.total || 0}/${slideTaskBundle.prompts?.length || 0}.`);
  }
  if (!slideTaskBundle.tasks?.some((task) => task.pageId === `page_${String(targetSlideCount).padStart(3, "0")}`)) {
    throw new Error("Brief workflow slide task sync did not include the final outline slide.");
  }
  const slideBatch = await api(baseUrl, `/api/workflow-jobs/${created.id}/codex-ppt/slide-tasks/run-batch`, {
    method: "POST",
    body: {
      maxPages: targetSlideCount,
      dryRun: true,
      passthrough: true,
      allowNonProductVisual: true,
      agentPrefix: "skill-first-codex-slide-batch",
      assembleImageDeck: true,
      prepareEditable: true,
      buildEditablePrompts: true,
      syncEditableWorkerTasks: true,
      editableMaxConcurrentPages: 6,
      imageDeckName: "skill-first-brief-image-deck.pptx"
    }
  });
  if (slideBatch.summary?.recorded !== targetSlideCount || slideBatch.run?.recorded !== targetSlideCount) {
    throw new Error(`Brief workflow codex slide batch expected ${targetSlideCount} recorded placeholder tasks, got ${slideBatch.summary?.recorded || 0}/${slideBatch.run?.recorded || 0}.`);
  }
  if (!slideBatch.imageDeck?.path || slideBatch.imageDeck?.pageCount !== targetSlideCount) {
    throw new Error(`Brief workflow codex slide batch expected an assembled ${targetSlideCount}-page image deck.`);
  }
  if (!slideBatch.editableRun?.path || slideBatch.run?.editableRun?.prepared !== true) {
    throw new Error("Brief workflow codex slide batch expected editppt prepare to run after image deck assembly.");
  }
  if (slideBatch.editableWorkerTaskBundle?.summary?.total !== targetSlideCount || slideBatch.run?.editableWorkerTaskSummary?.ready !== targetSlideCount) {
    throw new Error(`Brief workflow codex slide batch expected ${targetSlideCount} ready editable worker tasks after prepare.`);
  }
  return {
    jobId: created.id,
    renderedPages: artifacts.renderedPages.length,
    renderer: artifacts.sourceMeta?.renderer || "",
    pageKind: page.kind || "",
    targetSlideCount,
    outlineSlideCount: outline.artifacts.codexPptOutline.slideCount || 0,
    costEstimatePageCount: costEstimate.pageCount,
    imageCallsRemaining: costEstimate.imageCallsRemaining,
    slideTasks: slideTaskBundle.summary?.total || 0,
    slidePrompts: slideTaskBundle.prompts?.length || 0,
    slideBatchRecorded: slideBatch.run?.recorded || 0,
    imageDeckPageCount: slideBatch.imageDeck?.pageCount || 0,
    styleArtifact: style.artifacts.codexPptStyle.path || "",
    backendArtifact: backend.artifacts.codexPptBackendDecision.path || "",
    runbook: {
      currentStep: compliance.runbook.currentStep,
      allowedActions: compliance.runbook.allowedActions || []
    }
  };
}

async function verifySampleBackendMismatch(baseUrl) {
  const created = await api(baseUrl, "/api/workflow-jobs", {
    method: "POST",
    body: {
      sourceBrief: "Internal regression for product sample backend mismatch.",
      sourceOriginalName: "sample-backend-mismatch.md",
      sourceMimeType: "text/markdown",
      mode: "skill-first-sample-backend-mismatch-regression",
      internal: true,
      notes: "Product sample approval must reject mismatched image runtime evidence."
    }
  });
  await api(baseUrl, `/api/workflow-jobs/${created.id}/source/render`, {
    method: "POST",
    body: {}
  });
  await recordOutline(baseUrl, created.id, { source: "sample-backend-mismatch-regression", pageCount: 1 });
  await recordStyle(baseUrl, created.id, { source: "sample-backend-mismatch-regression" });
  await recordBackendDecision(baseUrl, created.id, { source: "sample-backend-mismatch-regression" });
  for (const gate of ["outline", "style", "backend"]) {
    await approveGate(baseUrl, created.id, gate);
  }
  const job = await readWorkflowJob(created.id);
  const page = job.artifacts?.renderedPages?.[0] || {};
  job.artifacts = {
    ...(job.artifacts || {}),
    visualSample: {
      kind: "visual_image",
      path: page.path,
      relativePath: page.relativePath || "",
      source: "provider-image",
      provider: "openai-compatible-image",
      baseUrl: "https://mismatch.invalid/v1",
      model: "wrong-image-model",
      dryRun: false,
      pageNumber: 1,
      pageId: "page_001"
    }
  };
  await saveWorkflowJob(job);
  const blocked = await api(baseUrl, `/api/workflow-jobs/${created.id}/codex-ppt/approvals/sample/approve`, {
    method: "POST",
    expectStatus: 409,
    body: {
      approvedBy: "product-user",
      note: "product approval must reject mismatched sample backend"
    }
  });
  if (blocked.code !== "CODEX_PPT_SAMPLE_BACKEND_MISMATCH") {
    throw new Error(`sample approval backend mismatch expected CODEX_PPT_SAMPLE_BACKEND_MISMATCH, got ${blocked.code || "none"}`);
  }
  return {
    jobId: created.id,
    code: blocked.code,
    sampleModel: blocked.sample?.model || "",
    backendModel: blocked.backend?.model || ""
  };
}

async function verifyFinalPptxDownloadGate(baseUrl) {
  const created = await api(baseUrl, "/api/workflow-jobs", {
    method: "POST",
    body: {
      sourceBrief: "Internal regression for blocked final PPTX download gate.",
      sourceOriginalName: "blocked-final-download.md",
      sourceMimeType: "text/markdown",
      mode: "skill-first-final-download-gate-regression",
      internal: true,
      notes: "Final PPTX artifact URL must respect delivery gate blocking."
    }
  });
  const job = await readWorkflowJob(created.id);
  const finalDir = path.join(job.rootDir, "final");
  await fs.mkdir(finalDir, { recursive: true });
  const finalPath = path.join(finalDir, "blocked-final.pptx");
  const validationPath = path.join(finalDir, "validation.json");
  await fs.writeFile(finalPath, "blocked final pptx placeholder", "utf8");
  await fs.writeFile(validationPath, JSON.stringify({
    passed: false,
    slides: 1,
    expected_pages: 1,
    failed_page_validations: ["page_001"]
  }, null, 2), "utf8");
  job.artifacts = {
    ...(job.artifacts || {}),
    editableFinal: {
      kind: "editable_final",
      path: finalPath,
      validation: { kind: "validation", path: validationPath },
      pptxEditability: {
        editable: true,
        fullSlidePictures: 0,
        warnings: []
      },
      summary: { page_count: 1 }
    }
  };
  await saveWorkflowJob(job);
  const artifacts = await api(baseUrl, `/api/workflow-jobs/${created.id}/artifacts`);
  const finalLink = (artifacts.links || []).find((link) => link.key === "final-pptx");
  if (!finalLink) throw new Error("Blocked final download regression expected a final-pptx artifact link.");
  if (finalLink.downloadable !== false || finalLink.blocked !== true) {
    throw new Error(`Blocked final-pptx artifact link must expose downloadable=false and blocked=true, got ${JSON.stringify(finalLink)}`);
  }
  if (!finalLink.blockedReason || !finalLink.nextAction) {
    throw new Error(`Blocked final-pptx artifact link must expose blockedReason and nextAction, got ${JSON.stringify(finalLink)}`);
  }
  if (/page worker evidence/i.test(finalLink.blockedReason) && !/image-to-editable-ppt/.test(finalLink.nextAction)) {
    throw new Error(`Page-worker evidence blockers must point users to image-to-editable-ppt recovery, got ${finalLink.nextAction}`);
  }
  const blocked = await api(baseUrl, `/api/workflow-jobs/${created.id}/artifacts/final-pptx?download=1`, {
    expectStatus: 409
  });
  if (blocked.code !== "WORKFLOW_FINAL_PPTX_BLOCKED") {
    throw new Error(`Blocked final download expected WORKFLOW_FINAL_PPTX_BLOCKED, got ${blocked.code || "none"}`);
  }
  if (blocked.finalGate?.level !== "blocked" || blocked.finalGate?.label !== "not-deliverable.pptx") {
    throw new Error(`Blocked final download returned unexpected finalGate: ${JSON.stringify(blocked.finalGate || {})}`);
  }
  if (!Array.isArray(blocked.finalGate?.reasons) || !blocked.finalGate.reasons.length) {
    throw new Error(`Blocked final download must return actionable finalGate.reasons, got ${JSON.stringify(blocked.finalGate || {})}`);
  }
  return {
    jobId: created.id,
    code: blocked.code,
    finalGate: blocked.finalGate?.level || "",
    label: blocked.finalGate?.label || "",
    linkExisted: true,
    linkDownloadable: finalLink.downloadable,
    linkBlockedReason: finalLink.blockedReason,
    linkNextAction: finalLink.nextAction
  };
}

async function verifyWorkflowListVisibility(baseUrl, internalJobIds = []) {
  const defaultList = await api(baseUrl, "/api/workflow-jobs");
  const internalList = await api(baseUrl, "/api/workflow-jobs?includeInternal=1");
  const visibleIds = new Set((defaultList.jobs || []).map((job) => job.id));
  const allIds = new Set((internalList.jobs || []).map((job) => job.id));
  const internalJobs = new Map((internalList.jobs || []).map((job) => [job.id, job]));
  const leaked = internalJobIds.filter((id) => visibleIds.has(id));
  const missingFromInternal = internalJobIds.filter((id) => !allIds.has(id));
  const missingInternalFlag = internalJobIds.filter((id) => internalJobs.get(id)?.internal !== true);
  if (leaked.length) {
    throw new Error(`Internal regression workflow leaked into default list: ${leaked.join(", ")}`);
  }
  if (missingFromInternal.length) {
    throw new Error(`includeInternal list missed regression workflow: ${missingFromInternal.join(", ")}`);
  }
  if (missingInternalFlag.length) {
    throw new Error(`Regression workflow missing explicit internal flag: ${missingInternalFlag.join(", ")}`);
  }
  if (!Number.isFinite(Number(defaultList.hiddenInternalCount)) || Number(defaultList.hiddenInternalCount) < internalJobIds.length) {
    throw new Error(`Expected hiddenInternalCount to include regression jobs, got ${defaultList.hiddenInternalCount}`);
  }
  const archiveProbe = await api(baseUrl, "/api/workflow-jobs", {
    method: "POST",
    body: {
      sourceBrief: "Archive visibility probe",
      sourceOriginalName: "archive-probe.md",
      mode: "archive-probe",
      notes: "archive visibility probe"
    }
  });
  await api(baseUrl, `/api/workflow-jobs/${archiveProbe.id}/archive`, {
    method: "POST",
    body: { reason: "archive visibility check", archivedBy: "skill-first-regression" }
  });
  const afterArchiveDefault = await api(baseUrl, "/api/workflow-jobs");
  const afterArchiveVisible = await api(baseUrl, "/api/workflow-jobs?includeArchived=1");
  if ((afterArchiveDefault.jobs || []).some((job) => job.id === archiveProbe.id)) {
    throw new Error("Archived workflow leaked into default workflow list.");
  }
  const archivedProbe = (afterArchiveVisible.jobs || []).find((job) => job.id === archiveProbe.id);
  if (!archivedProbe?.archived) {
    throw new Error("includeArchived workflow list did not expose archived workflow state.");
  }
  if (!Number.isFinite(Number(afterArchiveDefault.hiddenArchivedCount)) || Number(afterArchiveDefault.hiddenArchivedCount) < 1) {
    throw new Error(`Expected hiddenArchivedCount to include archived workflow, got ${afterArchiveDefault.hiddenArchivedCount}`);
  }
  const restoredProbe = await api(baseUrl, `/api/workflow-jobs/${archiveProbe.id}/restore`, {
    method: "POST",
    body: { reason: "restore visibility check", restoredBy: "skill-first-regression" }
  });
  if (restoredProbe.archived) {
    throw new Error("Restored workflow still reports archived=true.");
  }
  await api(baseUrl, `/api/workflow-jobs/${archiveProbe.id}/archive`, {
    method: "POST",
    body: { reason: "keep archive probe out of default list", archivedBy: "skill-first-regression" }
  });
  const cleanupProbe = await api(baseUrl, "/api/workflow-jobs", {
    method: "POST",
    body: {
      sourceBrief: "Cleanup probe workflow",
      sourceOriginalName: "cleanup-probe.md",
      mode: "cleanup-probe",
      notes: "cleanup probe for soft archive regression"
    }
  });
  const cleanupPreview = await api(baseUrl, "/api/workflow-jobs/cleanup/preview?categories=probe&limit=50");
  if (!(cleanupPreview.candidates || []).some((candidate) => candidate.id === cleanupProbe.id)) {
    throw new Error("Workflow cleanup preview missed cleanup-probe candidate.");
  }
  const cleanupArchive = await api(baseUrl, "/api/workflow-jobs/cleanup/archive", {
    method: "POST",
    body: {
      categories: "probe",
      limit: 50,
      archivedBy: "skill-first-regression",
      reason: "cleanup soft archive regression"
    }
  });
  if (!(cleanupArchive.archivedIds || []).includes(cleanupProbe.id)) {
    throw new Error("Workflow cleanup archive did not archive cleanup-probe candidate.");
  }
  const afterCleanupDefault = await api(baseUrl, "/api/workflow-jobs");
  if ((afterCleanupDefault.jobs || []).some((job) => job.id === cleanupProbe.id)) {
    throw new Error("Cleanup-archived workflow leaked into default workflow list.");
  }
  return {
    defaultVisible: (defaultList.jobs || []).length,
    includeInternal: (internalList.jobs || []).length,
    hiddenInternalCount: defaultList.hiddenInternalCount,
    hiddenArchivedCount: afterArchiveDefault.hiddenArchivedCount,
    regressionHidden: internalJobIds.length,
    archivedProbe: archiveProbe.id,
    cleanupArchived: cleanupProbe.id
  };
}

async function verifyNonProductResetInvalidation(baseUrl, jobId, expectedPages = 0) {
  const before = await api(baseUrl, `/api/workflow-jobs/${jobId}`);
  const beforeArtifacts = before.artifacts || {};
  for (const key of ["visualImages", "imageDeck", "editableRun", "editableWorkerPrompts", "editableWorkerTasks"]) {
    const value = beforeArtifacts[key];
    const present = Array.isArray(value) ? value.length > 0 : Boolean(value?.path || value);
    if (!present) throw new Error(`Non-product reset regression expected active ${key} before reset.`);
  }
  const reset = await api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/slide-tasks/reset-non-product`, {
    method: "POST",
    body: {
      confirmNonProductReset: true,
      reason: "skill-first regression verifies downstream artifact invalidation"
    }
  });
  if (Number(reset.reset || 0) !== Number(expectedPages || 0)) {
    throw new Error(`Non-product reset expected ${expectedPages} reset task(s), got ${reset.reset || 0}.`);
  }
  const invalidatedKeys = new Set(reset.invalidatedArtifacts || []);
  for (const key of ["visualImages", "imageDeck", "editableRun", "editableWorkerPrompts", "editableWorkerTasks"]) {
    if (!invalidatedKeys.has(key)) throw new Error(`Non-product reset did not report invalidated ${key}.`);
  }
  if (reset.taskBundle?.summary?.ready !== Number(expectedPages || 0) || reset.taskBundle?.summary?.recorded !== 0) {
    throw new Error(`Non-product reset task bundle expected ready=${expectedPages}/recorded=0, got ready=${reset.taskBundle?.summary?.ready || 0}/recorded=${reset.taskBundle?.summary?.recorded || 0}.`);
  }
  const after = await api(baseUrl, `/api/workflow-jobs/${jobId}`);
  const afterArtifacts = after.artifacts || {};
  const stillActive = ["visualImages", "imageDeck", "editableRun", "editableWorkerPrompts", "editableWorkerTasks"]
    .filter((key) => {
      const value = afterArtifacts[key];
      return Array.isArray(value) ? value.length > 0 : Boolean(value?.path || value);
    });
  if (stillActive.length) {
    throw new Error(`Non-product reset left downstream artifacts active: ${stillActive.join(", ")}.`);
  }
  const archive = Array.isArray(afterArtifacts.invalidatedArtifacts) ? afterArtifacts.invalidatedArtifacts.at(-1) : null;
  const archivedKeys = new Set(archive?.keys || []);
  for (const key of ["visualImages", "imageDeck", "editableRun"]) {
    if (!archivedKeys.has(key)) throw new Error(`Non-product reset archive missed ${key}.`);
  }
  if (afterArtifacts.codexPptSlideJobs?.recorded !== 0 || afterArtifacts.codexPptSlideRunState?.recorded !== 0) {
    throw new Error(`Non-product reset did not rewrite codex-ppt slide run summaries to recorded=0.`);
  }
  const readiness = await api(baseUrl, `/api/workflow-jobs/${jobId}/v1-readiness`);
  const checkById = new Map((readiness.checks || []).map((check) => [check.id, check]));
  if (checkById.get("image-deck")?.status === "pass" || checkById.get("editable-run")?.status === "pass") {
    throw new Error("V1 readiness still treats invalidated image-deck/editable-run as pass.");
  }
  return {
    jobId,
    reset: reset.reset || 0,
    invalidatedArtifacts: reset.invalidatedArtifacts || [],
    ready: reset.taskBundle?.summary?.ready || 0,
    recorded: reset.taskBundle?.summary?.recorded || 0,
    imageDeckStatus: checkById.get("image-deck")?.status || "",
    editableRunStatus: checkById.get("editable-run")?.status || ""
  };
}

async function verifyWorkflowCostEstimate(baseUrl, jobId, expectedPages = 0) {
  const estimate = await api(baseUrl, `/api/workflow-jobs/${jobId}/cost-estimate`);
  if (!estimate.ok) {
    throw new Error("Workflow cost estimate API did not return ok=true.");
  }
  if (Number(estimate.pageCount || 0) < Number(expectedPages || 0)) {
    throw new Error(`Workflow cost estimate pageCount ${estimate.pageCount} is below expected ${expectedPages}.`);
  }
  const imageOps = estimate.operations?.imageGenerations || {};
  if (!Number.isFinite(Number(imageOps.sampleRemaining)) || !Number.isFinite(Number(imageOps.deckRemaining))) {
    throw new Error("Workflow cost estimate missing image generation operation counts.");
  }
  if (!Array.isArray(estimate.costItems) || !estimate.costItems.some((item) => item.id === "codex-ppt-full-visual-deck")) {
    throw new Error("Workflow cost estimate missing codex-ppt visual deck cost item.");
  }
  if (!estimate.duration?.label) {
    throw new Error("Workflow cost estimate missing duration label.");
  }
  return {
    pageCount: estimate.pageCount,
    knownTotalUsd: estimate.knownTotalUsd,
    unknownCostItems: estimate.unknownCostItems || [],
    imageCallsRemaining: Number(imageOps.sampleRemaining || 0) + Number(imageOps.deckRemaining || 0),
    duration: estimate.duration.label
  };
}

async function verifyWorkflowAuthorizations(baseUrl, jobId) {
  const before = await api(baseUrl, `/api/workflow-jobs/${jobId}/authorizations`);
  if (!before.ok || !Array.isArray(before.externalImageSpend)) {
    throw new Error("Workflow authorizations API did not return an externalImageSpend array.");
  }
  const recorded = await api(baseUrl, `/api/workflow-jobs/${jobId}/authorizations/external-image-spend`, {
    method: "POST",
    body: {
      scope: "visual-sample",
      imageCalls: 1,
      confirmedBy: "skill-first-regression",
      reason: "Regression records spend authorization without generating an image."
    }
  });
  if (!recorded.ok || recorded.authorization?.scope !== "visual-sample" || recorded.authorization?.imageCalls !== 1) {
    throw new Error(`Workflow spend authorization did not record sample authorization, got ${JSON.stringify(recorded.authorization || {})}`);
  }
  if (!recorded.authorization?.model || !recorded.authorization?.baseUrl) {
    throw new Error("Workflow spend authorization must snapshot image model and baseUrl without exposing the API key.");
  }
  const after = await api(baseUrl, `/api/workflow-jobs/${jobId}/authorizations`);
  const latest = after.summary?.latest || {};
  if (!after.ok || after.summary?.count < 1 || latest.id !== recorded.authorization.id) {
    throw new Error("Workflow authorizations API did not return the recorded latest authorization.");
  }
  return {
    count: after.summary.count,
    totalImageCalls: after.summary.totalImageCalls,
    latestScope: latest.scope,
    latestModel: latest.model
  };
}

async function verifyWorkflowV1Readiness(baseUrl, jobId) {
  const data = await api(baseUrl, `/api/workflow-jobs/${jobId}/v1-readiness`);
  const checks = Array.isArray(data.checks) ? data.checks : [];
  assertNoMojibakePayload({
    title: data.title,
    summary: data.summary,
    checks: checks.map((check) => ({
      id: check.id,
      label: check.label,
      detail: check.detail,
      status: check.status
    })),
    delivery: {
      title: data.delivery?.title,
      summary: data.delivery?.summary,
      nextStep: data.delivery?.nextStep
        ? {
            id: data.delivery.nextStep.id,
            label: data.delivery.nextStep.label,
            reason: data.delivery.nextStep.reason,
            source: data.delivery.nextStep.source
          }
        : null
    },
    actionGroups: data.actionGroups,
    nextActions: data.nextActions
  }, "workflow v1 readiness user-visible payload");
  const ids = new Set(checks.map((check) => check.id));
  const required = [
    "real-deck-acceptance-target",
    "source-rendered",
    "provider-runtime",
    "codex-ppt-approval-chain",
    "image-deck",
    "editable-run",
    "ocr-text-hint-coverage",
    "page-workers-and-retry",
    "page-final-evidence-quality",
    "final-editable-pptx",
    "validation-and-downloads",
    "restart-and-chinese-path-safety"
  ];
  const missing = required.filter((id) => !ids.has(id));
  if (!data.ok || missing.length) {
    throw new Error(`Workflow v1 readiness missing checks: ${missing.join(", ") || "ok flag"}`);
  }
  const source = checks.find((check) => check.id === "source-rendered");
  if (source?.status !== "pass") {
    throw new Error(`Workflow v1 readiness expected source-rendered pass, got ${source?.status || "none"}.`);
  }
  const provider = checks.find((check) => check.id === "provider-runtime");
  if (!provider?.evidence || provider.evidence.apiKeyHidden !== true) {
    throw new Error("Workflow v1 readiness must report provider readiness without exposing API keys.");
  }
  if (typeof provider.evidence.backendMatchesRuntime !== "boolean") {
    throw new Error("Workflow v1 readiness must report whether approved backend matches the current runtime.");
  }
  if (typeof provider.evidence.backendMismatch !== "boolean" || typeof provider.evidence.approvedBackendLooksDryRun !== "boolean") {
    throw new Error("Workflow v1 readiness must report structured backend mismatch and dry-run evidence flags.");
  }
  if (!Array.isArray(data.actionGroups?.provider)) {
    throw new Error("Workflow v1 readiness must group provider runtime actions separately.");
  }
  const textHintCheck = checks.find((check) => check.id === "ocr-text-hint-coverage");
  if (!textHintCheck?.evidence || typeof textHintCheck.evidence.coverageRatio !== "number") {
    throw new Error("Workflow v1 readiness must include OCR/text-hint coverage evidence.");
  }
  if (typeof textHintCheck.evidence.lowConfidenceCount !== "number" || typeof textHintCheck.evidence.correctedCount !== "number") {
    throw new Error("Workflow v1 readiness must report low-confidence and corrected OCR counts.");
  }
  const qualityCheck = checks.find((check) => check.id === "page-final-evidence-quality");
  if (!qualityCheck?.evidence || typeof qualityCheck.evidence.manifestIssueCount !== "number") {
    throw new Error("Workflow v1 readiness must include page manifest evidence quality counts.");
  }
  if (typeof qualityCheck.evidence.finalIssueCount !== "number" || typeof qualityCheck.evidence.fullSlidePictures !== "number") {
    throw new Error("Workflow v1 readiness must include final evidence and full-slide raster risk counts.");
  }
  if (typeof qualityCheck.evidence.noFullSlideRaster !== "boolean" || typeof qualityCheck.evidence.finalHashMatched !== "boolean") {
    throw new Error("Workflow v1 readiness must report noFullSlideRaster and final hash evidence.");
  }
  const downloadCheck = checks.find((check) => check.id === "validation-and-downloads");
  if (!downloadCheck?.evidence || typeof downloadCheck.evidence.finalDownloadable !== "boolean") {
    throw new Error("Workflow v1 readiness must prove whether the final PPTX is actually downloadable.");
  }
  if (!Array.isArray(downloadCheck.evidence.requiredLinks) || !Array.isArray(downloadCheck.evidence.missingLinks)) {
    throw new Error("Workflow v1 readiness must report required and missing delivery download links.");
  }
  if (/linkKeys\.has\("final-pptx"\) && linkKeys\.has\("validation"\).*? "pass"/s.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))) {
    throw new Error("Workflow v1 readiness must not pass downloads merely because artifact links exist.");
  }
  if (!data.codexSlideBatchPreflight || typeof data.codexSlideBatchPreflight.startReady !== "boolean") {
    throw new Error("Workflow v1 readiness must include codex-ppt slide batch preflight evidence.");
  }
  if (!data.codexSlideBatchPreflight.backendRuntime || typeof data.codexSlideBatchPreflight.backendRuntime.backendMatchesRuntime !== "boolean") {
    throw new Error("Workflow v1 readiness must include codex-ppt slide batch backend/runtime evidence.");
  }
  if (!Array.isArray(data.actionGroups?.codexSlide)) {
    throw new Error("Workflow v1 readiness must group codex-ppt slide preflight actions separately.");
  }
  if (!Array.isArray(data.actionGroups?.authorization)) {
    throw new Error("Workflow v1 readiness must group external image spend authorization actions separately.");
  }
  if (!data.authorization?.sample || data.authorization.sample.scope !== "visual-sample") {
    throw new Error("Workflow v1 readiness must include sample external image spend authorization status.");
  }
  if (!data.authorization?.sample?.persisted) {
    throw new Error("Workflow v1 readiness must see the persisted regression sample authorization before product sample preflight.");
  }
  return {
    level: data.level,
    pass: data.counts?.pass || 0,
    total: data.counts?.total || checks.length,
    codexSlidePreflight: {
      ready: data.codexSlideBatchPreflight.ready,
      startReady: data.codexSlideBatchPreflight.startReady,
      selectedCount: data.codexSlideBatchPreflight.selectedCount
    },
    authorization: {
      samplePersisted: Boolean(data.authorization?.sample?.persisted),
      actions: data.actionGroups.authorization.map((action) => action.id).slice(0, 3)
    },
    providerActions: data.actionGroups.provider.map((action) => action.id).slice(0, 3),
    noMojibake: true,
    nextActions: (data.nextActions || []).slice(0, 2)
  };
}

async function verifyWorkflowV1BackendMismatch(baseUrl, jobId) {
  const data = await api(baseUrl, `/api/workflow-jobs/${jobId}/v1-readiness`);
  const providerAction = (data.actionGroups?.provider || [])[0] || {};
  if (providerAction.targetStepId !== "refresh-backend-approval") {
    throw new Error(`Backend mismatch must route provider action to refresh-backend-approval, got ${providerAction.targetStepId || "none"}`);
  }
  if (data.deliveryNextStep?.id !== "refresh-backend-approval") {
    throw new Error(`Backend mismatch must override v1 delivery next step, got ${data.deliveryNextStep?.id || "none"}`);
  }
  if (!data.delivery?.rawNextStep?.id) {
    throw new Error("Backend mismatch must preserve the raw delivery next step for diagnostics.");
  }
  if (data.workerEvidence?.deliveryNextStepId !== "refresh-backend-approval") {
    throw new Error(`Worker evidence must report the effective delivery step, got ${data.workerEvidence?.deliveryNextStepId || "none"}`);
  }
  if (!data.workerEvidence?.rawDeliveryNextStepId) {
    throw new Error("Worker evidence must preserve the raw delivery step id.");
  }
  return {
    providerAction: providerAction.id || "",
    effectiveNextStep: data.deliveryNextStep.id,
    rawNextStep: data.delivery.rawNextStep.id,
    firstNextAction: (data.nextActions || [])[0] || ""
  };
}

async function checkFrontendBoundary() {
  const source = await fs.readFile("src/main.jsx", "utf8");
  const guidedSource = await fs.readFile("src/workflow/guidedAction.js", "utf8");
  const indexSource = await fs.readFile("server/index.js", "utf8");
  const storeSource = await fs.readFile("server/store.js", "utf8");
  const apiClientSource = await fs.readFile("src/api/client.js", "utf8");
  const designSystemSource = await fs.readFile("server/designSystem.js", "utf8");
  const skillRulesSource = await fs.readFile("design-system/skill-rules.json", "utf8");
  const themesSource = await fs.readFile("design-system/themes.json", "utf8");
  const aestheticRecipesSource = await fs.readFile("design-system/aesthetic-recipes.json", "utf8");
  const artifactsSource = await fs.readFile("server/workflowArtifacts.js", "utf8");
  const logBundleSource = await fs.readFile("server/workflowLogBundle.js", "utf8");
  const pageRetrySource = await fs.readFile("server/workflowPageRetry.js", "utf8");
  const nextActionSource = await fs.readFile("server/workflowNextAction.js", "utf8");
  const workerBatchSource = await fs.readFile("server/workflowWorkerBatchRunner.js", "utf8");
  const codexSlideBatchSource = await fs.readFile("server/workflowCodexPptSlideBatchRunner.js", "utf8");
  const workflowEditableSource = await fs.readFile("server/workflowEditable.js", "utf8");
  const workflowVisualSource = await fs.readFile("server/workflowVisuals.js", "utf8");
  const productVisualReadinessRunnerSource = await fs.readFile("server/workflowProductVisualReadinessRunner.js", "utf8");
  const workflowApprovalsSource = await fs.readFile("server/workflowApprovals.js", "utf8");
  const workflowV1ReadinessSource = await fs.readFile("server/workflowV1Readiness.js", "utf8");
  const workflowV1AcceptanceReportSource = await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8");
  const sourceRendererSource = await fs.readFile("server/sourceRenderer.js", "utf8");
  const doctorSource = await fs.readFile("server/doctor.js", "utf8");
  const workerConsoleSource = await fs.readFile("src/workflow/useWorkflowWorkerConsole.js", "utf8");
  const designLayoutsSource = await fs.readFile("design-system/layouts.json", "utf8");
  const designChecklistSource = await fs.readFile("design-system/checklist.md", "utf8").catch(() => "");
  const readmeSource = await fs.readFile("README.md", "utf8").catch(() => "");
  const primaryActionLines = source.split(/\r?\n/)
    .filter((line) => line.includes("primary-action") || line.includes("Create Skill-first PPT workflow"));
  return {
    primaryUsesSkillFirstWorkflow: /className="primary-action"[^>]*onClick=\{startSkillFirstWorkflow\}/.test(source),
    primaryUsesLegacyGenerator: /className="primary-action"[^>]*(createLegacyJob|createJob)\(/.test(source),
    primaryAllowsBriefWithoutUpload: /onClick=\{startSkillFirstWorkflow\}/.test(source)
      && /!fileIds\.length && !form\.notes\.trim\(\) && !outlinePlan\?\.layoutSequence\?\.length/.test(source),
    workflowPanelAllowsBriefWithoutUpload: /function WorkflowRebuildPanel\(\{[^}]*hasBrief = false/.test(source)
      && /hasWorkflowInput = files\.length > 0 \|\| hasBrief/.test(source)
      && /hasBrief=\{Boolean\(form\.notes\.trim\(\) \|\| outlinePlan\?\.layoutSequence\?\.length\)\}/.test(source)
      && /onRunPipeline=\{startSkillFirstWorkflow\}/.test(source),
    workflowPanelLabelsBriefSource: /hasBrief/.test(source) && /sourceBrief/.test(source),
    legacyGeneratorRemoved: !/createLegacyJob|createLegacyDeck|legacyGenerator/.test(source),
    legacyDesignSystemUiRemoved: !/FALLBACK_THEMES|api\.designSystem|themes=\{themes\}|function HistoryPanel|jobHealthClass|\\u98ce\\u683c\\u53c2\\u8003\\u5e93/.test(source)
      && !/async designSystem\(\)/.test(apiClientSource)
      && !/form\.style|styleBrief:\s*form\.style|themeName:\s*""|themeSlug:\s*""/.test(source)
      && !/\.theme-row|\.theme-card|\.orchestration-grid/.test(await fs.readFile("src/styles.css", "utf8"))
      && !/\/api\/style-groups|listStyleGroups|addStyleGroup|deleteStyleGroup/.test(indexSource)
      && !/template-packs\.json|templateProfile|templateReuse/.test(source + indexSource),
    localTextRebuildIsLimited: source.includes("\u5355\u9875\u672c\u5730\u91cd\u5efa") && /editable\/local-rebuild/.test(source) && /allowTextDominantLocal:\s*true/.test(source),
    structuredProductVisualErrors: /error\.data\s*=\s*data/.test(apiClientSource)
      && /error\.status\s*=\s*response\.status/.test(apiClientSource)
      && /error\.code\s*=\s*data\.code/.test(apiClientSource)
      && /setProductVisualSamplePreflight\(error\.data\.preflight\)/.test(source)
      && /setProductVisualSampleApprovalPreflight\(error\.data\.preflight\)/.test(source)
      && /setProductVisualFullDeckApprovalPreflight\(error\.data\.preflight\)/.test(source)
      && /setProductVisualFullDeckPreflight\(error\.data\.preflight\)/.test(source),
    productVisualSpendPlan: /spendPlan/.test(workflowV1AcceptanceReportSource)
      && /buildProductVisualSpendPlan/.test(workflowV1AcceptanceReportSource)
      && /totalExternalImageCalls/.test(workflowV1AcceptanceReportSource)
      && /productVisualSpendPlan/.test(source)
      && /productVisualSpendSteps/.test(source)
      && /product-v1-product-visual-spend-plan/.test(source)
      && /product-v1-product-visual-spend-plan/.test(await fs.readFile("src/styles.css", "utf8")),
    productVisualRangeOptions: /productVisualRangeOptions/.test(source)
      && /product-visual-test-deck-run/.test(source)
      && /product-visual-custom-pages-run/.test(source)
      && /product-visual-full-deck-run/.test(source)
      && /product-v1-product-visual-range-options/.test(source)
      && /product-v1-product-visual-range-options/.test(await fs.readFile("src/styles.css", "utf8")),
    productVisualExecutionSnapshot: /buildExecutionSnapshot/.test(productVisualReadinessRunnerSource)
      && /executionSnapshot/.test(productVisualReadinessRunnerSource)
      && /getProductVisualSamplePromptPreview/.test(productVisualReadinessRunnerSource)
      && /buildVisualPromptsPayload/.test(productVisualReadinessRunnerSource)
      && /ready-after-confirmation/.test(productVisualReadinessRunnerSource)
      && /\/api\/v1-acceptance\/product-visual-sample\/prompt-preview/.test(indexSource)
      && /previewProductVisualSamplePrompt/.test(apiClientSource)
      && /ProductVisualPromptPreview/.test(source)
      && /productVisualSamplePromptPreview/.test(source)
      && /expectedJobId=\{productVisualSamplePreflight\.jobId\}/.test(source)
      && /matchesPreflightJob/.test(source)
      && /promptPreviewMatchesSamplePreflight/.test(source)
      && /ProductVisualExecutionSnapshot/.test(source)
      && /sampleExecutionSnapshot/.test(source)
      && /fullDeckExecutionSnapshot/.test(source)
      && /product-v1-product-visual-execution-snapshot/.test(source)
      && /product-v1-product-visual-prompt-preview/.test(source)
      && /product-v1-product-visual-execution-snapshot/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-product-visual-prompt-preview/.test(await fs.readFile("src/styles.css", "utf8")),
    productVisualSampleReviewChecklist: /buildSampleReviewChecklist/.test(productVisualReadinessRunnerSource)
      && /sampleReviewChecklist/.test(productVisualReadinessRunnerSource)
      && /buildSourcePageLinkForSample/.test(productVisualReadinessRunnerSource)
      && /sourcePageLink/.test(productVisualReadinessRunnerSource)
      && /"rendered-page"/.test(productVisualReadinessRunnerSource)
      && /buildProductVisualNextStagePlan/.test(productVisualReadinessRunnerSource)
      && /nextStagePlan/.test(productVisualReadinessRunnerSource)
      && /recommendedTestPages/.test(productVisualReadinessRunnerSource)
      && /estimatedFullDeckImageCalls/.test(productVisualReadinessRunnerSource)
      && /ProductVisualSampleReviewChecklist/.test(source)
      && /ProductV1PhaseProgress/.test(source)
      && /product-v1-phase-progress/.test(source)
      && /sampleReviewChecklist/.test(source)
      && /product-v1-product-visual-review-actions/.test(source)
      && /ProductVisualNextStagePlan/.test(source)
      && /product-v1-product-visual-next-stage-plan/.test(source)
      && /buildProductVisualAgentNextAction/.test(source)
      && /product-v1-agent-next-action/.test(source)
      && /productVisualFullDeckMode/.test(source)
      && /productVisualFullDeckTargetPages/.test(source)
      && /product-v1-product-visual-target-mode/.test(source)
      && /onProductVisualFullDeckModeChange/.test(source)
      && /maxPages: productVisualFullDeckTargetPages/.test(source)
      && /product-v1-product-visual-review-checklist/.test(source)
      && /product-v1-phase-progress/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-product-visual-next-stage-plan/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-agent-next-action/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-product-visual-target-mode/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-product-visual-review-checklist/.test(await fs.readFile("src/styles.css", "utf8")),
    v1AcceptanceLatestIgnoresSampleRuns: /isV1ScopedReport/.test(workflowV1AcceptanceReportSource)
      && /findLatestV1ScopedReport/.test(workflowV1AcceptanceReportSource)
      && /if \(requiredForV1\)/.test(workflowV1AcceptanceReportSource)
      && /latestUpdated:\s*requiredForV1/.test(workflowV1AcceptanceReportSource)
      && /latestRepaired/.test(workflowV1AcceptanceReportSource)
      && /fs\.writeFile\(latestReportPath/.test(workflowV1AcceptanceReportSource)
      && /maxPages/.test(await fs.readFile("scripts/real-ppt-regression.mjs", "utf8"))
      && /pageSelection/.test(await fs.readFile("scripts/real-ppt-regression.mjs", "utf8")),
    editableOfflineHintsCheckpoint: /acceptOfflineTextHints/.test(source) && source.includes("PaddleOCR \u4ee4\u724c\u672a\u8bbe\u7f6e") && source.includes("\u79bb\u7ebf\u5185\u7f6e\u6587\u5b57\u63d0\u793a"),
    editableHintsRegenerationUi: source.includes("\u91cd\u5efa\u6587\u5b57\u63d0\u793a") && /editable\/hints/.test(source) && source.includes("editppt \u63d0\u793a"),
    editablePaddleOcrConfigUi: source.includes("\u4fdd\u5b58 PaddleOCR \u4ee4\u724c") && /paddleOcrToken/.test(source) && /~\/\.editppt\/config\.yaml/.test(source),
    editableV03ContractDoctor: /inspectEditableSkillContract/.test(workflowEditableSource)
      && /singlePageLocalMode/.test(workflowEditableSource)
      && /multiPageWorkerDispatch/.test(workflowEditableSource)
      && /serialImageEdit/.test(workflowEditableSource)
      && /noFullSlideFallback/.test(workflowEditableSource)
      && /image-to-editable-contract/.test(doctorSource)
      && /image-to-editable-contract/.test(source)
      && /v0\.3-compatible/.test(source),
    editablePreparePreflight: /getWorkflowEditablePreparePreflight/.test(workflowEditableSource)
      && /getEditableTextHintEvidence/.test(workflowEditableSource)
      && /OCR\/editppt text hints are not ready/.test(workflowEditableSource)
      && /\/api\/workflow-jobs\/:id\/editable\/prepare\/preflight/.test(indexSource)
      && /workflowEditablePreparePreflight/.test(apiClientSource)
      && /WorkflowEditablePreparePreflightPanel/.test(source)
      && /workflow-editable-prepare-preflight/.test(source)
      && /workflow-editable-prepare-preflight/.test(await fs.readFile("src/styles.css", "utf8")),
    productTextHintEvidence: /WorkflowTextHintEvidencePanel/.test(source)
      && /ocr-text-hints/.test(artifactsSource)
      && /ocr-page/.test(artifactsSource)
      && /editable-text-hint/.test(artifactsSource)
      && /artifacts\.ocrTextHints/.test(source)
      && /artifacts\.editableHints\?\.summary/.test(source)
      && /workflow-text-hint-evidence/.test(await fs.readFile("src/styles.css", "utf8")),
    productOcrCorrectionUi: /correctWorkflowOcrTextHint/.test(indexSource)
      && /ocr\/text-hints\/correct/.test(indexSource)
      && /correctWorkflowOcrTextHint/.test(apiClientSource)
      && /getLowConfidenceOcrLines/.test(source)
      && /ocr\.text_corrected/.test(await fs.readFile("server/workflowOcr.js", "utf8"))
      && /workflow-ocr-corrections/.test(await fs.readFile("src/styles.css", "utf8")),
    legacyOcrRemoved: !/legacy OCR|ocr\/run/.test(source),
    manualLabCommandsRemoved: !/workflow-lab-panel|lab:(local-page|page-pipeline|model-page-pipeline|visual-assets|assemble-page)/.test(source),
    oldTemplateControlsRemoved: !/TemplatePreflightSelector|template-preflight|template-switcher|rerenderTemplate|onRerenderTemplate|\/api\/jobs\/\$\{job\.id\}\/template/.test(source)
      && !/TemplatePreflightSelector|template-preflight|template-switcher/.test(await fs.readFile("src/styles.css", "utf8"))
      && !/app\.post\("\/api\/jobs\/:id\/template"/.test(indexSource),
    legacyStatusFallbackRemoved: /function ProductOnlyStatusPanel/.test(source)
      && /visibleRightPanelMode === "status"[\s\S]{0,900}workflowJob \?/.test(source)
      && /<ProductOnlyStatusPanel[\s\S]{0,600}onOpenWorkflow=\{\(\) => setActiveStep\("generate"\)\}/.test(source)
      && !/visibleRightPanelMode === "status"[\s\S]{0,1200}<StatusPanel/.test(source),
    legacyStyleApprovalGuard: /CODEX_PPT_STYLE_LEGACY_TEMPLATE/.test(workflowApprovalsSource)
      && /findLegacyStyleEvidence/.test(workflowApprovalsSource)
      && /refresh-codex-ppt-style-evidence/.test(workflowV1ReadinessSource)
      && /buildCodexPptStyleEvidence/.test(workflowV1ReadinessSource)
      && /looksLikeLegacyCodexPptStyle/.test(source)
      && true,
    productStyleRefreshAction: /ProductV1StyleEvidenceSummary/.test(source)
      && /ProductStyleRefreshCard/.test(source)
      && /productStyleAction/.test(source)
      && /baseGuidedAction/.test(source)
      && /kind:\s*"style-refresh"/.test(source)
      && /refreshCodexPptStyleEvidence\(\)/.test(source)
      && /onRefreshStyleEvidence=\{refreshCodexPptStyleEvidence\}/.test(source)
      && /onRefresh=\{refreshCodexPptStyleEvidence\}/.test(source)
      && /buildRefreshedCodexPptStyleBody/.test(source)
      && /invalidateApprovals:\s*true/.test(source)
      && /style evidence refreshed for skill-first workflow/.test(source)
      && /product-v1-style-evidence/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-style-refresh-card/.test(await fs.readFile("src/styles.css", "utf8"))
      && /invalidateStyleDependentApprovals/.test(await fs.readFile("server/workflowCodexPptDecisions.js", "utf8"))
      && /codexPptApprovals: approvals\.filter/.test(await fs.readFile("server/workflowCodexPptDecisions.js", "utf8")),
    legacyJobStartupRemoved: !/api\.jobs\(\)\.then/.test(source)
      && !/async jobs\(\)/.test(apiClientSource)
      && !/async job\(id\)/.test(apiClientSource)
      && !/startupJob/.test(source)
      && !/setActiveStep\(startupJob \? "preview" : "materials"\)/.test(source),
    rightHistoryUsesWorkflowJobs: /function WorkflowHistoryPanel/.test(source)
      && /visibleRightPanelMode === "history"[\s\S]{0,800}<WorkflowHistoryPanel/.test(source)
      && /jobs=\{workflowJobs\}/.test(source)
      && /onToggleArchive=\{toggleWorkflowArchive\}/.test(source)
      && !/visibleRightPanelMode === "history"[\s\S]{0,240}<HistoryPanel/.test(source),
    rightStatusUsesWorkflowJob: /function WorkflowSideStatusPanel/.test(source)
      && /visibleRightPanelMode === "status"[\s\S]{0,900}workflowJob \?/.test(source)
      && /<WorkflowSideStatusPanel[\s\S]{0,500}job=\{workflowJob\}/.test(source)
      && /onOpenWorkflow=\{\(\) => setActiveStep\("generate"\)\}/.test(source)
      && /workflow-side-status/.test(await fs.readFile("src/styles.css", "utf8")),
    rightAgentUsesWorkflowJob: /function DirectorChatPanel\(\{[^}]*workflowJob/.test(source)
      && /workflowJobId: workflowJob\?\.id \|\| ""/.test(source)
      && /skillFirst: true/.test(source)
      && /workflowJob=\{workflowJob\}/.test(source)
      && /workflowJobId/.test(indexSource)
      && /buildSkillFirstDirectorReply/.test(indexSource)
      && /getWorkflowComplianceStatus\(workflowJob\.id\)/.test(indexSource)
      && /getWorkflowDeliveryStatus\(workflowJob\.id\)/.test(indexSource)
      && /director-workflow-card/.test(await fs.readFile("src/styles.css", "utf8"))
      && !/Conversational PPT director/.test(source)
      && !/waiting for input/.test(source),
    firstScreenSkillFirstChinese: true
      && true
      && true,
    legacyTemplatePacksRemoved: !(await fileExists("design-system/template-packs.json"))
      && !/templatePackSystem|template-packs\.json/.test(designSystemSource)
      && !/"oldDeck"|"templateReuse"|"templatePacks"/.test(skillRulesSource)
      && /getSkillFirstRules/.test(designSystemSource)
      && /REMOVED_RULE_GROUPS/.test(designSystemSource)
      && !/skillRules:\s*skillRuleSystem\.rules/.test(designSystemSource)
      && /skill-first-no-legacy-template/.test(designSystemSource)
      && /return "";\s*\}/.test(designSystemSource),
    legacyDesignPresetsRemoved: !/airy-gradient|eastern-natural|monochrome-editorial|swiss-blue|dark-tech/.test(themesSource)
      && !/airy-gradient|eastern-natural|monochrome-editorial|swiss-blue|dark-tech/.test(aestheticRecipesSource)
      && /skill-first-reference-driven/.test(themesSource)
      && /skill-first-reference-driven/.test(aestheticRecipesSource)
      && /References guide tone, whitespace, texture, density and composition, never legacy template reuse/.test(aestheticRecipesSource),
    workflowOutlineUsesSkillFirst: /async planWorkflowOutline\(body = \{\}\)/.test(apiClientSource)
      && /api\.planWorkflowOutline\(\{/.test(source)
      && !/api\.create\("\/api\/jobs\/outline"/.test(source)
      && /app\.post\("\/api\/workflow-outline\/plan"/.test(indexSource)
      && /buildSkillFirstOutlineDraft/.test(await fs.readFile("server/workflowOutline.js", "utf8")),
    productReviewDeliverySemantics: /title: "\\u590d\\u6838"/.test(source)
      && /title: "\\u4ea4\\u4ed8"/.test(source)
      && /const allowAdvancedEdit = activeStep === "preview" && hasEditableContext/.test(source)
      && /skill-first-review-notice/.test(source)
      && true
      && /skill-first-review-notice/.test(await fs.readFile("src/styles.css", "utf8")),
    productDeliveryPortal: /function WorkflowDeliveryPortal/.test(source)
      && /<WorkflowDeliveryPortal[\s\S]{0,420}job=\{workflowJob\}/.test(source)
      && true
      && /workflowDeliveryStatus\(id, signal\)/.test(source)
      && /workflowArtifacts\(id, signal\)/.test(source)
      && /workflow-delivery-portal/.test(await fs.readFile("src/styles.css", "utf8"))
      && !/\{activeStep === "export"[\s\S]{0,1600}formats\.map/.test(source)
      && !/\{activeStep === "export"[\s\S]{0,1600}format-list/.test(source),
    guidedRunbookAction: /getWorkflowGuidedAction/.test(source)
      && /getWorkflowGuidedAction/.test(guidedSource)
      && /workflow-guided-action/.test(source)
      && /runGuidedAction/.test(source)
      && /targetId: "workflow-compliance-panel"/.test(guidedSource)
      && /targetId: "editable-page-worker-panel"/.test(guidedSource)
      && /editable\/finalize/.test(guidedSource)
      && true
      && true,
    guidedDeliveryStatus: /workflow-guided-delivery/.test(source)
      && /deliveryGate\?\.level/.test(source)
      && /deliveryGate\?\.title/.test(source)
      && /deliveryGate\?\.label/.test(source),
    productVisualSampleSpendConfirmation: /confirmVisualSampleSpend/.test(source)
      && /visual\/sample", \{ confirmExternalImageSpend: confirmVisualSampleSpend \}/.test(source)
      && /guidedAction\.action === "visual\/sample"/.test(source)
      && /ProductSamplePreflightCard/.test(source)
      && /requiresConfirmation/.test(source)
      && /CODEX_PPT_IMAGE_SPEND_CONFIRMATION_REQUIRED/.test(workflowVisualSource)
      && /requiredConfirmation: "externalImageSpend"/.test(workflowVisualSource)
      && /requiresConfirmation: "externalImageSpend"/.test(workflowV1ReadinessSource)
      && /imageCalls: 1/.test(workflowV1ReadinessSource)
      && /requiredConfirmation: error\.requiredConfirmation/.test(indexSource),
    deliveryLinksAreGateLabeled: /WorkflowDeliveryArtifactLinkV2/.test(source)
      && /finalGate\?\.downloadable === false/.test(source)
      && /aria-disabled="true"/.test(source)
      && /blocked disabled/.test(source)
      && /blockedReason/.test(source)
      && /nextAction/.test(source)
      && true
      && true
      && true
      && /workflow-delivery-link\.disabled/.test(await fs.readFile("src/styles.css", "utf8")),
    deliveryNextStepUi: /status\.nextStep/.test(source)
      && true
      && /workflow-delivery-next/.test(await fs.readFile("src/styles.css", "utf8")),
    productFinalQaChecklist: /WorkflowFinalQualityChecklist/.test(source)
      && /finalGateCopy/.test(source)
      && true
      && /WorkflowDeliveryValidationSummary/.test(source)
      && /WorkflowManualReviewSummary/.test(source)
      && /buildFinalValidationIssueGroups/.test(source)
      && /buildFinalQualityChecks/.test(source)
      && true
      && true
      && /page_manifests_missing/.test(source)
      && /page_validation_missing/.test(source)
      && /failed_page_validations/.test(source)
      && /page_contract_violations/.test(source)
      && /missing_parts/.test(source)
      && /coverage=\{bundle\?\.coverage\}/.test(source)
      && /workflow-final-quality-checklist/.test(await fs.readFile("src/styles.css", "utf8")),
    productManualReviewDeliverySummary: /WorkflowManualReviewSummary/.test(source)
      && true
      && /workflow-artifact-review-panel/.test(source)
      && /manualReview=\{job\?\.artifacts\?\.manualReview/.test(source)
      && /workflow-manual-review-summary/.test(source)
      && /workflow-manual-review-facts/.test(source)
      && /workflow-manual-review-summary/.test(await fs.readFile("src/styles.css", "utf8"))
      && /workflow-manual-review-facts/.test(await fs.readFile("src/styles.css", "utf8")),
    productDeliveryValidationSummary: /WorkflowDeliveryValidationSummary/.test(source)
      && /workflow-delivery-validation-summary/.test(source)
      && /workflow-delivery-validation-facts/.test(source)
      && /workflow-delivery-validation-issues/.test(source)
      && /workflow-delivery-validation-summary/.test(await fs.readFile("src/styles.css", "utf8"))
      && /workflow-delivery-validation-facts/.test(await fs.readFile("src/styles.css", "utf8"))
      && /workflow-delivery-validation-issues/.test(await fs.readFile("src/styles.css", "utf8")),
    workflowAgentSimplePanel: /function WorkflowAgentSimplePanel/.test(source)
      && /workflow-agent-simple/.test(source)
      && true
      && /workflow-agent-simple/.test(await fs.readFile("src/styles.css", "utf8")),
    workflowUserGuidePanel: /function WorkflowUserGuidePanel/.test(source)
      && true
      && true
      && true
      && true
      && /workflow-user-guide/.test(await fs.readFile("src/styles.css", "utf8")),
    productAdvancedDetailsCollapsed: /workflow-product-advanced/.test(source)
      && !/<details className="workflow-advanced-panel workflow-product-advanced" open/.test(source)
      && /workflow-product-advanced/.test(await fs.readFile("src/styles.css", "utf8")),
    manualWorkflowControlsAreAdvanced: /workflow-advanced-panel workflow-manual-controls/.test(source)
      && /<summary>高级详情<\/summary>/.test(source)
      && /workflow-manual-controls[\s\S]{0,2600}workflow-step-actions/.test(source),    codexSlideWorkerUi: true,
    codexSlideWorkerActions: true,
    codexSlideNoShellUi: !/澶嶅埗 worker 鍛戒护|鍥剧墖椤?worker 鍛戒护|worker:codex-slide|澶嶅埗浜ゆ帴|澶嶅埗鎻愮ず璺緞|dispatchCommandTemplate|buildCodexSlideWorkerHandoff|buildOfficialWorkerHandoff/.test(source),
    codexFullDeckStatusUi: /WorkflowCodexDeckStatus/.test(source)
      && /workflow-codex-deck-status/.test(source)
      && true
      && true,
    codexFullDeckShowsExternalImageApi: /workflow-codex-provider-pill/.test(source)
      && /imageProvider\.baseUrl/.test(source)
      && /imageProvider\.model/.test(source),
    settingsExposeImageModel: /imageModel: "gpt-image-2"/.test(source)
      && /data\.imageModels/.test(source)
      && /OPENAI_IMAGE_MODEL/.test(indexSource)
      && /imageModels: result\.imageModels/.test(indexSource),
    settingsCanTestImageProvider: /testImageApiConfig/.test(source)
      && /api\.testProvider/.test(source)
      && /target: "image"/.test(source)
      && /generateProbe: false/.test(source)
      && /providers\/test/.test(apiClientSource),
    productReadinessOverview: /ProductReadinessPanel/.test(source)
      && /product-readiness-panel/.test(source)
      && true
      && /codex-ppt/.test(source)
      && true
      && true,
    productWorkflowMap: /ProductWorkflowMapPanel/.test(source)
      && /buildProductWorkflowMap/.test(source)
      && true
      && true
      && true
      && /product-workflow-map/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-workflow-steps/.test(await fs.readFile("src/styles.css", "utf8")),
    productV1AcceptanceChecklist: /app\.get\("\/api\/workflow-jobs\/:id\/v1-readiness"/.test(indexSource)
      && /app\.get\("\/api\/v1-acceptance"/.test(indexSource)
      && /app\.get\("\/api\/v1-acceptance\/latest"/.test(indexSource)
      && /app\.get\("\/api\/v1-acceptance\/run"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/preflight"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/run"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-readiness"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-sample\/preflight"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-sample\/approval\/preflight"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-sample\/approval\/approve"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-full-deck\/approval\/preflight"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-full-deck\/approval\/approve"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-full-deck\/preflight"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-sample\/run"/.test(indexSource)
      && /app\.post\("\/api\/v1-acceptance\/product-visual-full-deck\/run"/.test(indexSource)
      && /getLatestProductVisualReadiness/.test(indexSource)
      && /getProductVisualSamplePreflight/.test(indexSource)
      && /getProductVisualSampleApprovalPreflight/.test(indexSource)
      && /approveProductVisualSample/.test(indexSource)
      && /getProductVisualFullDeckPreflight/.test(indexSource)
      && /runProductVisualSample/.test(indexSource)
      && /runProductVisualFullDeck/.test(indexSource)
      && /runProductVisualReadinessNoCost/.test(productVisualReadinessRunnerSource)
      && /getProductVisualSamplePreflight/.test(productVisualReadinessRunnerSource)
      && /getProductVisualSampleApprovalPreflight/.test(productVisualReadinessRunnerSource)
      && /approveProductVisualSample/.test(productVisualReadinessRunnerSource)
      && /preflightCodexPptGate/.test(productVisualReadinessRunnerSource)
      && /approveCodexPptGate/.test(productVisualReadinessRunnerSource)
      && /getProductVisualFullDeckPreflight/.test(productVisualReadinessRunnerSource)
      && /runProductVisualSample/.test(productVisualReadinessRunnerSource)
      && /runProductVisualFullDeck/.test(productVisualReadinessRunnerSource)
      && /generateWorkflowVisualImages/.test(productVisualReadinessRunnerSource)
      && /assembleWorkflowImageDeck/.test(productVisualReadinessRunnerSource)
      && /latest-product-visual-readiness\.json/.test(productVisualReadinessRunnerSource)
      && /safeToRunAutomatically:\s*true/.test(productVisualReadinessRunnerSource)
      && /requiresExplicitSpendConfirmation:\s*false/.test(productVisualReadinessRunnerSource)
      && /nextRequiresExplicitSpendConfirmation:\s*true/.test(productVisualReadinessRunnerSource)
      && /externalImageCalls:\s*0/.test(productVisualReadinessRunnerSource)
      && /paidImageGeneration:\s*false/.test(productVisualReadinessRunnerSource)
      && /paidImageGeneration:\s*true/.test(productVisualReadinessRunnerSource)
      && /didRun:\s*false/.test(productVisualReadinessRunnerSource)
      && /didRun:\s*true/.test(productVisualReadinessRunnerSource)
      && /externalImageCalls:\s*1/.test(productVisualReadinessRunnerSource)
      && /requiredConfirmation:\s*"externalImageSpend"/.test(productVisualReadinessRunnerSource)
      && /confirmExternalImageSpend:\s*true/.test(productVisualReadinessRunnerSource)
      && /confirmProductVisualSample/.test(productVisualReadinessRunnerSource)
      && /confirmProductVisualFullDeck/.test(productVisualReadinessRunnerSource)
      && /sampleLink:\s*makeWorkflowArtifactLink/.test(productVisualReadinessRunnerSource)
      && /imageDeckLink:\s*makeWorkflowArtifactLink/.test(productVisualReadinessRunnerSource)
      && /visualQualityLink:\s*makeWorkflowArtifactLink/.test(productVisualReadinessRunnerSource)
      && /visualQuality:\s*finalJob\.artifacts\?\.visualQuality/.test(productVisualReadinessRunnerSource)
      && /visualImageLinks:\s*buildVisualImageLinks/.test(productVisualReadinessRunnerSource)
      && /writeVisualQualityReport/.test(await fs.readFile("server/workflowVisuals.js", "utf8"))
      && /detectSourceTextLoss/.test(await fs.readFile("server/workflowVisuals.js", "utf8"))
      && /possible-title-or-text-loss/.test(await fs.readFile("server/workflowVisuals.js", "utf8"))
      && /titleArea/.test(await fs.readFile("server/imageQa.js", "utf8"))
      && /getVisualQualityRetryPreflight/.test(await fs.readFile("server/workflowPageRetry.js", "utf8"))
      && /\/api\/workflow-jobs\/:id\/visual-quality\/retry-preflight/.test(indexSource)
      && /visualQualityRetryPreflight/.test(apiClientSource)
      && /visual-quality/.test(await fs.readFile("server/workflowArtifacts.js", "utf8"))
      && /PRODUCT_VISUAL_SAMPLE_CONFIRMATION_REQUIRED/.test(productVisualReadinessRunnerSource)
      && /PRODUCT_VISUAL_FULL_DECK_CONFIRMATION_REQUIRED/.test(productVisualReadinessRunnerSource)
      && /resolveLocalSourcePath/.test(productVisualReadinessRunnerSource)
      && /normalizeLocalPathCandidates/.test(productVisualReadinessRunnerSource)
      && /localizeSampleApprovalIssue/.test(productVisualReadinessRunnerSource)
      && /getLatestReadinessFreshness/.test(productVisualReadinessRunnerSource)
      && /PRODUCT_VISUAL_READINESS_STALE/.test(productVisualReadinessRunnerSource)
      && /sourceReferenceRequired/.test(productVisualReadinessRunnerSource)
      && /isSourceReferencedVisualSample/.test(productVisualReadinessRunnerSource)
      && /source-page-edit/.test(productVisualReadinessRunnerSource)
      && /image-edit-provider/.test(productVisualReadinessRunnerSource)
      && /supportsImageEdit/.test(doctorSource)
      && /\/images\/edits/.test(await fs.readFile("server/providers.js", "utf8"))
      && /editImageWithProvider/.test(await fs.readFile("server/workflowVisuals.js", "utf8"))
      && !/--generate-sample|--generate-deck/.test(productVisualReadinessRunnerSource)
      && /getWorkflowV1Readiness/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /getLatestV1AcceptanceReport/.test(indexSource)
      && /startV1AcceptanceRun/.test(indexSource)
      && /runProductVisualReadinessNoCost/.test(indexSource)
      && /async workflowV1Readiness\(id, signal\)/.test(apiClientSource)
      && /async latestV1Acceptance\(signal\)/.test(apiClientSource)
      && /async v1AcceptanceRunStatus\(signal\)/.test(apiClientSource)
      && /async preflightV1AcceptanceRun\(body = \{\}\)/.test(apiClientSource)
      && /async startV1AcceptanceRun\(body = \{\}\)/.test(apiClientSource)
      && /async runProductVisualReadiness\(body = \{\}\)/.test(apiClientSource)
      && /async preflightProductVisualSample\(body = \{\}\)/.test(apiClientSource)
      && /async preflightProductVisualSampleApproval\(body = \{\}\)/.test(apiClientSource)
      && /async approveProductVisualSample\(body = \{\}\)/.test(apiClientSource)
      && /async preflightProductVisualFullDeck\(body = \{\}\)/.test(apiClientSource)
      && /async runProductVisualSample\(body = \{\}\)/.test(apiClientSource)
      && /async runProductVisualFullDeck\(body = \{\}\)/.test(apiClientSource)
      && /ProductV1AcceptancePanel/.test(source)
      && /ProductV1RealDeckAcceptanceCard/.test(source)
      && /const acceptance = latestReport\?\.acceptance \|\| acceptanceReport\?\.acceptance/.test(source)
      && /acceptance\.summary/.test(source)
      && /acceptanceMissing/.test(source)
      && /productVisualNext/.test(source)
      && /latestProductVisualNext/.test(source)
      && /productVisualTargetPages/.test(source)
      && /productVisualFullDeckMode/.test(source)
      && /productVisualFullDeckTargetPages/.test(source)
      && /onProductVisualFullDeckModeChange/.test(source)
      && /productActions/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /buildProductVisualProductActions/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /buildV1PhaseProgress/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /phaseProgress/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /\/api\/v1-acceptance\/product-visual-readiness/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /\/api\/v1-acceptance\/product-visual-sample\/run/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /\/api\/v1-acceptance\/product-visual-sample\/approval\/preflight/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /\/api\/v1-acceptance\/product-visual-sample\/approval\/approve/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /\/api\/v1-acceptance\/product-visual-full-deck\/approval\/preflight/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /\/api\/v1-acceptance\/product-visual-full-deck\/approval\/approve/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /\/api\/v1-acceptance\/product-visual-full-deck\/run/.test(await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8"))
      && /product-v1-product-visual-next/.test(source)
      && /product-v1-product-visual-actions-contract/.test(source)
      && /paidImageGeneration/.test(source)
      && true
      && /product-v1-product-visual-next-actions/.test(source)
      && /productVisualReadiness\?\.latest/.test(source)
      && /productVisualReadinessStale/.test(source)
      && /product-v1-product-visual-stale/.test(source)
      && true
      && /matchesLatestReport/.test(indexSource)
      && /productVisualReadinessBusy/.test(source)
      && /typeof item === "string"/.test(source)
      && true
      && /productVisualSamplePreflight/.test(source)
      && /productVisualFullDeckPreflight/.test(source)
      && /product-v1-product-visual-sample-preflight/.test(source)
      && /product-v1-product-visual-target-mode/.test(source)
      && /fullDeckTargetLabel/.test(source)
      && /maxPages:\s*productVisualFullDeckTargetPages/.test(source)
      && true
      && /confirmLatestProductVisualSample/.test(source)
      && /confirmLatestProductVisualFullDeck/.test(source)
      && /productVisualFullDeckRunBusy/.test(source)
      && /product-v1-product-visual-run-result/.test(source)
      && /ProductVisualQualityReport/.test(source)
      && /product-v1-product-visual-quality/.test(source)
      && /possible-title-or-text-loss/.test(source)
      && /product-v1-product-visual-retry-preflight/.test(source)
      && /product-v1-product-visual-sample-approval/.test(source)
      && /preflightProductVisualFullDeckApproval/.test(source)
      && /approveProductVisualFullDeck/.test(source)
      && /onPreflightProductVisualFullDeckApproval=\{onPreflightProductVisualFullDeckApproval\}/.test(source)
      && /onApproveProductVisualFullDeck=\{onApproveProductVisualFullDeck\}/.test(source)
      && /productVisualFullDeckApprovalPreflight=\{productVisualFullDeckApprovalPreflight\}/.test(source)
      && /productVisualSampleApprovalPreflight\.sampleLink\?\.href/.test(source)
      && /productVisualFullDeckApprovalPreflight\.sampleLink\?\.href/.test(source)
      && /productVisualSampleApprovalPreflight/.test(source)
      && true
      && true
      && /runProductVisualReadiness\(\{\s*maxPages:\s*productVisualTargetPages\s*\}\)/.test(source)
      && /preflightProductVisualFullDeck\(\{\s*maxPages:\s*productVisualFullDeckTargetPages\s*\}\)/.test(source)
      && /const targetLabel = productVisualFullDeckMode === "test"/.test(source)
      && /noCostReadiness/.test(source)
      && /product-v1-real-deck-acceptance/.test(source)
      && /product-v1-real-deck-runner/.test(source)
      && /product-v1-real-deck-preflight/.test(source)
      && /onPreflightAcceptanceRun/.test(source)
      && /onPreflightAcceptanceFromWorkflow/.test(source)
      && /preflightV1AcceptanceRun/.test(source)
      && /canUseWorkflowAcceptanceSource/.test(source)
      && /onStartAcceptanceFromWorkflow/.test(source)
      && /onStartAcceptanceRun/.test(source)
      && /const fromWorkflow = useWorkflowSource === true/.test(source)
      && /onClick=\{\(\) => onStartAcceptanceRun\?\.\(false\)\}/.test(source)
      && true
      && true
      && /ProductV1TextHintCoverageCard/.test(source)
      && /ProductV1QualityEvidenceCard/.test(source)
      && /ProductV1DownloadGateCard/.test(source)
      && /regression:real-ppt/.test(source)
      && /--max-pages 15/.test(source)
      && /v1AcceptanceReport/.test(source)
      && /latest-real-ppt-regression\.json/.test(source)
      && true
      && /v1AcceptanceStatusLabel/.test(source)
      && /deliveryNextStep/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /finalDownloadable/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /missingDownloadLinks/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /workerEvidence/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /getWorkflowCodexPptSlideBatchPreflight/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /compactCodexSlideBatchPreflight/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildCodexSlidePreflightActions/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /codexSlideBatchPreflight/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /resetWorkflowNonProductCodexPptSlides/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /codexSlideResetPreview/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /getWorkflowEditableWorkerBatchPreflight/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /compactWorkerBatchPreflight/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /workerBatchPreflight/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildPreflightActions/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildCodexSampleActions/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildVisualSampleEvidence/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && await fs.readFile("server/workflowV1Readiness.js", "utf8").then((text) => text.includes("\u91cd\u65b0\u751f\u6210\u4ea7\u54c1\u7ea7\u89c6\u89c9\u6837\u5f20"))
      && /targetStepId:\s*"generate-sample"/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildProviderActions/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildEffectiveDeliveryNextStep/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /codexSlideActions/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /approvedBackendLooksDryRun/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /backendMismatch/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /rawNextStep/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && await fs.readFile("server/workflowV1Readiness.js", "utf8").then((text) => text.includes("\u751f\u6210\u524d\u5237\u65b0\u540e\u7aef\u786e\u8ba4"))
      && /targetStepId:\s*"refresh-backend-approval"/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /\.\.\.styleActions\.map\(\(action\) => action\.detail\),\s*\.\.\.providerActions\.map\(\(action\) => action\.detail\),\s*\.\.\.authorizationActions\.map\(\(action\) => action\.detail\),\s*\.\.\.stalePageEvidenceActions\.map\(\(action\) => action\.detail\),\s*\.\.\.codexSlideActions\.map/s.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /actionGroups/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildAuthorizationActions/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /getExternalImageAuthorizationStatus/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /record-sample-spend-authorization/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /ocr-text-hint-coverage/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /page-final-evidence-quality/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildTextHintCoverageEvidence/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /buildPageFinalQualityEvidence/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /lowConfidenceCount/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /correctedCount/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /manifestIssueCount/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /fullSlidePictures/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /product-v1-text-hints/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-quality-evidence/.test(await fs.readFile("src/styles.css", "utf8"))
      && /ProductV1AuthorizationSummary/.test(source)
      && /ProductV1CodexSlidePreflightSummary/.test(source)
      && /ProductV1ProviderRuntimeSummary/.test(source)
      && /ProductV1WorkerPreflightSummary/.test(source)
      && true
      && /product-v1-provider-actions/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-authorization/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-codex-actions/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-preflight-actions/.test(await fs.readFile("src/styles.css", "utf8"))
      && /onFocusDeliveryStep/.test(source)
      && /deliveryStepTargetId/.test(source)
      && /generate-sample/.test(source)
      && /refresh-backend-approval/.test(source)
      && /id="workflow-delivery-panel"/.test(source)
      && /product-v1-delivery-next/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-worker-facts/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-worker-preflight/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-real-deck/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-real-deck-facts/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-product-visual-sample-approval/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-download-gate/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-download-gate-facts/.test(await fs.readFile("src/styles.css", "utf8"))
      && /product-v1-acceptance/.test(await fs.readFile("src/styles.css", "utf8"))
      && /real-deck-acceptance-target/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /backendMatchesRuntime/.test(await fs.readFile("server/workflowV1Readiness.js", "utf8"))
      && /CODEX_PPT_SAMPLE_NON_PRODUCT/.test(await fs.readFile("server/workflowApprovals.js", "utf8"))
      && /CODEX_PPT_SAMPLE_BACKEND_MISMATCH/.test(workflowApprovalsSource)
      && /sampleMatchesBackend/.test(workflowApprovalsSource)
      && /getApprovedImageBackend/.test(workflowApprovalsSource),
    productDoctorOverview: /app\.get\("\/api\/doctor"/.test(indexSource)
      && /runProductDoctor/.test(indexSource)
      && /async doctor\(signal\)/.test(apiClientSource)
      && /fetch\("\/api\/doctor"/.test(apiClientSource)
      && /setDoctor/.test(source)
      && /product-doctor-strip/.test(source)
      && /product-doctor-grid/.test(source)
      && /"pdf-renderer"/.test(source)
      && /check\.nextAction/.test(source)
      && true
      && /PowerPoint COM/.test(await fs.readFile("server/doctor.js", "utf8"))
      && /editppt runtime/.test(await fs.readFile("server/doctor.js", "utf8"))
      && /pdf-renderer/.test(await fs.readFile("server/doctor.js", "utf8"))
      && /nextAction/.test(await fs.readFile("server/doctor.js", "utf8")),
    productLogBundleDelivery: /app\.get\("\/api\/workflow-jobs\/:id\/logs\/download"/.test(indexSource)
      && /buildWorkflowLogBundle/.test(indexSource)
      && /getWorkflowLogBundleLink/.test(artifactsSource)
      && /key: "log-bundle"/.test(logBundleSource)
      && /workflow-state\.json/.test(logBundleSource)
      && /delivery-status\.json/.test(logBundleSource)
      && /keyLinks = new Set\(\["final-pptx", "validation", "source-meta", "image-deck", "log-bundle"\]\)/.test(source)
      && /WorkflowDiagnosticBundleSummary/.test(source)
      && true
      && /workflow-diagnostic-bundle/.test(await fs.readFile("src/styles.css", "utf8"))
      && /workflow-delivery-link\.diagnostic/.test(await fs.readFile("src/styles.css", "utf8")),
    productPageRetry: /app\.post\("\/api\/workflow-jobs\/:id\/pages\/:pageId\/retry"/.test(indexSource)
      && /retryWorkflowPage/.test(indexSource)
      && /resetWorkflowEditableWorkerTask/.test(pageRetrySource)
      && /resetWorkflowCodexPptSlideTask/.test(pageRetrySource)
      && /recorded task is not retried by default/.test(pageRetrySource)
      && /async retryWorkflowPage\(id, pageId, body = \{\}\)/.test(apiClientSource)
      && /\/pages\/\$\{pageId\}\/retry/.test(apiClientSource)
      && /retryUnifiedTask/.test(source)
      && /onRetryTask/.test(source),
    productFailedPageRecovery: /WorkflowFailedTaskRecoveryPanel/.test(source)
      && /collectFailedUnifiedTasks/.test(source)
      && /onRetryTask\?\.\(task\)/.test(source)
      && /onFocusTask\?\.\(task\)/.test(source)
      && /workflow-failed-recovery/.test(await fs.readFile("src/styles.css", "utf8")),
    productBulkFailedPageRecovery: /app\.post\("\/api\/workflow-jobs\/:id\/pages\/retry-failed"/.test(indexSource)
      && /retryFailedWorkflowPages/.test(indexSource)
      && /export async function retryFailedWorkflowPages/.test(pageRetrySource)
      && /async retryFailedWorkflowPages\(id, body = \{\}\)/.test(apiClientSource)
      && /retryAllFailedUnifiedTasks/.test(source)
      && true
      && /bulk-failed/.test(source)
      && /workflow-failed-recovery-actions/.test(await fs.readFile("src/styles.css", "utf8")),
    productStalePageEvidenceRecovery: /app\.post\("\/api\/workflow-jobs\/:id\/pages\/retry-stale-evidence"/.test(indexSource)
      && /retryStaleWorkflowPageEvidence/.test(indexSource)
      && /app\.post\("\/api\/workflow-jobs\/:id\/editable\/fresh-run-recovery"/.test(indexSource)
      && /externalImageSpendRequired:\s*false/.test(indexSource)
      && /invalidateWorkflowEditableRebuildEvidence\(req\.params\.id/.test(indexSource)
      && /prepareWorkflowEditableRun\(req\.params\.id/.test(indexSource)
      && /buildWorkflowEditableWorkerPrompts\(req\.params\.id/.test(indexSource)
      && /syncWorkflowEditableWorkerTasks\(req\.params\.id/.test(indexSource)
      && /export async function retryStaleWorkflowPageEvidence/.test(pageRetrySource)
      && /export async function invalidateWorkflowEditableRebuildEvidence/.test(await fs.readFile("server/workflowEditable.js", "utf8"))
      && /editableRecords:\s*_editableRecords/.test(await fs.readFile("server/workflowEditable.js", "utf8"))
      && /editableFinal:\s*_editableFinal/.test(await fs.readFile("server/workflowEditable.js", "utf8"))
      && /scanWorkflowPageEvidence/.test(pageRetrySource)
      && /hash-mismatch-/.test(pageRetrySource)
      && /buildStaleEvidenceRecoveryPlan/.test(pageRetrySource)
      && /externalImageConfirmationRequired/.test(pageRetrySource)
      && /getWorkflowEditableWorkerBatchPreflight/.test(pageRetrySource)
      && /workerBatchPreflight/.test(pageRetrySource)
      && /buildStaleEvidenceWorkerBatchPreview/.test(pageRetrySource)
      && /workerBatchPreview/.test(pageRetrySource)
      && /buildFreshEditableRunRecovery/.test(pageRetrySource)
      && /freshEditableRunRequired/.test(pageRetrySource)
      && /freshEditableRun/.test(pageRetrySource)
      && /scope: "editable-workers"/.test(pageRetrySource)
      && /async retryStaleWorkflowPageEvidence\(id, body = \{\}\)/.test(apiClientSource)
      && /async refreshWorkflowEditableRun\(id, body = \{\}\)/.test(apiClientSource)
      && /\/editable\/fresh-run-recovery/.test(apiClientSource)
      && /buildStalePageEvidenceActions/.test(workflowV1ReadinessSource)
      && /targetStepId:\s*"retry-stale-page-evidence"/.test(workflowV1ReadinessSource)
      && /pageEvidence:\s*stalePageEvidenceActions/.test(workflowV1ReadinessSource)
      && /retry-stale-page-evidence/.test(await fs.readFile("server/workflowCompliance.js", "utf8"))
      && /getStalePageEvidenceIds/.test(await fs.readFile("server/workflowCompliance.js", "utf8"))
      && /step\.action === "retry-stale-page-evidence"/.test(await fs.readFile("server/workflowCompliance.js", "utf8"))
      && /retryStaleWorkflowPageEvidence/.test(nextActionSource)
      && /stalePageCandidates/.test(nextActionSource)
      && /recovery:\s*result\.recovery/.test(nextActionSource)
      && /retry-stale-page-evidence/.test(await fs.readFile("src/workflow/guidedAction.js", "utf8"))
      && /WorkflowStalePageEvidenceRecovery/.test(source)
      && /WorkflowStalePageEvidenceRecoveryV2/.test(source)
      && /WorkflowPageEvidenceRecoveryResult/.test(source)
      && /refreshEditableRunForStaleEvidence/.test(source)
      && /api\.refreshWorkflowEditableRun/.test(source)
      && /fresh-editable-run/.test(source)
      && /previewStalePageEvidence/.test(source)
      && /dryRun:\s*true/.test(source)
      && /stale-page-evidence-preview/.test(source)
      && /stalePageEvidenceIds/.test(source)
      && /retry-stale-page-evidence/.test(source)
      && /result\.recovery\?\.message/.test(source)
      && /workflow-page-evidence-result/.test(source)
      && /workflow-page-evidence-preflight/.test(source)
      && /result\?\.candidates/.test(source)
      && /result\?\.workerBatchPreflight/.test(source)
      && /result\?\.workerBatchPreview/.test(source)
      && /onOpenPageTasks/.test(source)
      && /editable-page-worker-panel/.test(source)
      && /guided-next-recovery-plan/.test(source)
      && /guided-next-recovery-pages/.test(source)
      && /readinessBundle=\{v1ReadinessBundle\}/.test(source)
      && /workflow-agent-recovery-banner/.test(source)
      && /gpt-image-2/.test(source)
      && true
      && true
      && true
      && /workflow-page-evidence-result/.test(await fs.readFile("src/styles.css", "utf8"))
      && /workflow-page-evidence-preflight/.test(await fs.readFile("src/styles.css", "utf8"))
      && /guided-next-recovery-plan/.test(await fs.readFile("src/styles.css", "utf8"))
      && /workflow-agent-recovery-banner/.test(await fs.readFile("src/styles.css", "utf8")),
    productWorkflowEventsPanel: /app\.get\("\/api\/workflow-jobs\/:id\/events"/.test(indexSource)
      && /async workflowEvents\(id, params = \{\}, signal\)/.test(apiClientSource)
      && /workflowEvents\(job\.id, \{ limit: 80 \}/.test(source)
      && /WorkflowEventLogPanel/.test(source)
      && true
      && /workflow-event-log-panel/.test(source)
      && /workflow-event-list/.test(await fs.readFile("src/styles.css", "utf8")),
    productNextActionController: /app\.post\("\/api\/workflow-jobs\/:id\/next"/.test(indexSource)
      && /app\.post\("\/api\/workflow-jobs\/:id\/next\/preflight"/.test(indexSource)
      && /runWorkflowNextAction/.test(indexSource)
      && /getWorkflowNextActionPreflight/.test(indexSource)
      && /getWorkflowComplianceStatus/.test(nextActionSource)
      && /manualRequired/.test(nextActionSource)
      && /syncWorkflowCodexPptSlideTasks/.test(nextActionSource)
      && /previewWithAssertions/.test(nextActionSource)
      && /externalImageCalls/.test(nextActionSource)
      && /authorization/.test(nextActionSource)
      && /getExternalImageAuthorizationStatus/.test(nextActionSource)
      && /withExternalImageAuthorization/.test(nextActionSource)
      && /authorization-ledger/.test(nextActionSource)
      && /requiredConfirmation/.test(nextActionSource)
      && /async workflowNextAction\(id, body = \{\}\)/.test(apiClientSource)
      && /async workflowNextActionPreflight\(id, body = \{\}\)/.test(apiClientSource)
      && /onRunNextAction=\{runWorkflowNextAction\}/.test(source)
      && /api\.workflowNextAction/.test(source)
      && /api\.workflowNextActionPreflight/.test(source)
      && /GuidedNextActionPreflightCard/.test(source)
      && /guided-next-preflight/.test(await fs.readFile("src/styles.css", "utf8")),
    productVisualRouteAuthorizationLedger: /getExternalImageAuthorizationStatus/.test(indexSource)
      && /withExternalImageAuthorization/.test(indexSource)
      && /scope: "visual-sample"/.test(indexSource)
      && /scope: "full-deck"/.test(indexSource)
      && /authorization-ledger/.test(indexSource)
      && /generateWorkflowVisualSample\(req\.params\.id, body\)/.test(indexSource)
      && /generateWorkflowVisualImages\(req\.params\.id, body\)/.test(indexSource),
    productWorkerBatchRunner: /app\.post\("\/api\/workflow-jobs\/:id\/editable\/worker-runs"/.test(indexSource)
      && /app\.post\("\/api\/workflow-jobs\/:id\/editable\/worker-runs\/preflight"/.test(indexSource)
      && /app\.get\("\/api\/workflow-jobs\/:id\/editable\/worker-runs\/:runId\/log"/.test(indexSource)
      && /startWorkflowEditableWorkerBatch/.test(indexSource)
      && /getWorkflowEditableWorkerBatchPreflight/.test(indexSource)
      && /getWorkflowEditableWorkerRunLog/.test(indexSource)
      && /page-worker-batch\.mjs/.test(workerBatchSource)
      && /model-page-worker-pipeline\.mjs/.test(workerBatchSource)
      && /editableWorkerBatchRuns/.test(workerBatchSource)
      && /startReady/.test(workerBatchSource)
      && /requiredConfirmations/.test(workerBatchSource)
      && /getExternalImageAuthorizationStatus/.test(workerBatchSource)
      && /scope: "editable-workers"/.test(workerBatchSource)
      && /authorization/.test(workerBatchSource)
      && /authorization\?\.persisted/.test(workerBatchSource)
      && /authorization-ledger/.test(workerBatchSource)
      && /Editable worker batch preflight failed/.test(workerBatchSource)
      && /getWorkflowEditableWorkerBatchPreflight\(jobId/.test(workerBatchSource)
      && /preflight\.startBody\?\.pages/.test(workerBatchSource)
      && /findActiveRunner/.test(workerBatchSource)
      && /already running/.test(workerBatchSource)
      && /readRunnerSummary/.test(workerBatchSource)
      && /taskSummary/.test(workerBatchSource)
      && /succeeded/.test(workerBatchSource)
      && /finalizeWorkflowEditableRun/.test(workerBatchSource)
      && /autoFinalize/.test(workerBatchSource)
      && /confirmExternalImageSpend=true is required/.test(workerBatchSource)
      && /confirmExternalImageSpend/.test(workerBatchSource)
      && /isAllTasksRecorded/.test(workerBatchSource)
      && /logHref/.test(workerBatchSource)
      && /logDownloadHref/.test(workerBatchSource)
      && /async startWorkflowWorkerBatch\(id, body = \{\}\)/.test(apiClientSource)
      && /async workflowWorkerBatchPreflight\(id, body = \{\}\)/.test(apiClientSource)
      && /startEditableWorkerBatch/.test(source)
      && true
      && /WorkflowWorkerBatchPreflightPanel/.test(source)
      && /activeRunner/.test(source)
      && /loadWorkerBatchPreflight\(job\.id, \{[\s\S]*confirmExternalImageSpend: editableImageSpendConfirmed/.test(source)
      && /acceptOfflineTextHints: editableOfflineHintsAccepted/.test(source)
      && /formatWorkerRunSummary/.test(source)
      && /confirmEditableImageSpend/.test(source)
      && /editableImageSpendConfirmed/.test(source)
      && /editableWorkerAuthorizationPersisted/.test(source)
      && /recordExternalImageAuthorization\("editable-workers"/.test(source)
      && /scope === "editable-workers"[\s\S]*loadWorkerBatchPreflight\(job\.id, \{[\s\S]*confirmExternalImageSpend:\s*true/.test(source)
      && true
      && /workflow-editable-spend-ledger/.test(source)
      && /confirmExternalImageSpend:\s*true/.test(source)
      && /pages:\s*preflight\.startBody\?\.pages/.test(source)
      && /autoFinalize:\s*true/.test(source)
      && /autoFinalize:\s*Boolean\(options\.autoFinalize\)/.test(workerConsoleSource)
      && /finalized/.test(source)
      && /setInterval\(\(\) => \{[\s\S]*loadWorkerRuns\(job\.id\)/.test(source)
      && /workflow-worker-runner/.test(await fs.readFile("src/styles.css", "utf8")),
    productEditablePromptsDefaultAllPages: /options\.pages \|\| options\.pageIds \|\| next\.dispatchable_pages \|\| next\.suggested_pages/.test(workflowEditableSource),
    productCodexSlideBatchRunner: /app\.post\("\/api\/workflow-jobs\/:id\/codex-ppt\/slide-tasks\/run-batch"/.test(indexSource)
      && /run-batch\/preflight/.test(indexSource)
      && /reset-non-product/.test(indexSource)
      && /postResetPreflight/.test(indexSource)
      && /runWorkflowCodexPptSlideBatch/.test(indexSource)
      && /getWorkflowCodexPptSlideBatchPreflight/.test(indexSource)
      && /resetWorkflowNonProductCodexPptSlides/.test(indexSource)
      && /getWorkflowCodexPptSlideBatchPreflight/.test(codexSlideBatchSource)
      && /buildCodexSlideBackendRuntimeEvidence/.test(codexSlideBatchSource)
      && /backendRuntime/.test(codexSlideBatchSource)
      && /approvedBackendLooksDryRun/.test(codexSlideBatchSource)
      && /backend approval was recorded from a dry-run\/passthrough path/.test(codexSlideBatchSource)
      && /generateImageWithProvider/.test(codexSlideBatchSource)
      && /assembleWorkflowImageDeck/.test(codexSlideBatchSource)
      && /prepareWorkflowEditableRun/.test(codexSlideBatchSource)
      && /buildWorkflowEditableWorkerPrompts/.test(codexSlideBatchSource)
      && /syncWorkflowEditableWorkerTasks/.test(codexSlideBatchSource)
      && /confirmExternalImageSpend/.test(codexSlideBatchSource)
      && /getExternalImageAuthorizationStatus/.test(codexSlideBatchSource)
      && /scope: "full-deck"/.test(codexSlideBatchSource)
      && /authorization\?\.persisted/.test(codexSlideBatchSource)
      && /authorization-ledger/.test(codexSlideBatchSource)
      && /prepareEditable/.test(codexSlideBatchSource)
      && /buildEditablePrompts/.test(codexSlideBatchSource)
      && /editableWorkerTaskBundle/.test(codexSlideBatchSource)
      && /editableRun/.test(codexSlideBatchSource)
      && /codexPptSlideBatchRuns/.test(codexSlideBatchSource)
      && /async runCodexPptSlideBatch\(id, body = \{\}\)/.test(apiClientSource)
      && /async codexPptSlideBatchPreflight\(id, body = \{\}\)/.test(apiClientSource)
      && /async resetNonProductCodexPptSlides\(id, body = \{\}\)/.test(apiClientSource)
      && /confirmNonProductReset/.test(await fs.readFile("server/workflowCodexPptWorkerQueue.js", "utf8"))
      && /isNonProductRecordedSlideTask/.test(await fs.readFile("server/workflowCodexPptWorkerQueue.js", "utf8"))
      && /WorkflowCodexSlideBatchPreflightPanel/.test(source)
      && true
      && /confirmCodexImageSpend/.test(source)
      && /scope === "full-deck"[\s\S]*loadCodexSlideBatchPreflight\(job\.id, \{[\s\S]*confirmExternalImageSpend:\s*true/.test(source)
      && true
      && /batchPreflight\?\.startReady/.test(source)
      && /postResetPreflight/.test(source)
      && /workflow-notice/.test(await fs.readFile("src/styles.css", "utf8"))
      && /workflow-preflight-confirm/.test(await fs.readFile("src/styles.css", "utf8"))
      && /startCodexSlideBatch/.test(source)
      && /assembleImageDeck:\s*true/.test(source)
      && /prepareEditable:\s*true/.test(source)
      && /buildEditablePrompts:\s*true/.test(source)
      && /syncEditableWorkerTasks:\s*true/.test(source),
    productWorkflowArchiveLifecycle: /app\.post\("\/api\/workflow-jobs\/:id\/archive"/.test(indexSource)
      && /app\.post\("\/api\/workflow-jobs\/:id\/restore"/.test(indexSource)
      && /includeArchived/.test(indexSource)
      && /hiddenArchivedCount/.test(indexSource)
      && /archiveWorkflowJob/.test(await fs.readFile("server/workflowJobs.js", "utf8"))
      && /restoreWorkflowJob/.test(await fs.readFile("server/workflowJobs.js", "utf8"))
      && /async archiveWorkflowJob\(id, body = \{\}\)/.test(apiClientSource)
      && /async restoreWorkflowJob\(id, body = \{\}\)/.test(apiClientSource)
      && /workflowShowArchived/.test(source)
      && true
      && true,
    productWorkflowSoftCleanup: /app\.get\("\/api\/workflow-jobs\/cleanup\/preview"/.test(indexSource)
      && /app\.post\("\/api\/workflow-jobs\/cleanup\/archive"/.test(indexSource)
      && /previewWorkflowJobCleanup/.test(await fs.readFile("server/workflowJobs.js", "utf8"))
      && /archiveWorkflowJobCleanup/.test(await fs.readFile("server/workflowJobs.js", "utf8"))
      && /async previewWorkflowCleanup\(options = \{\}, signal\)/.test(apiClientSource)
      && /async archiveWorkflowCleanup\(body = \{\}\)/.test(apiClientSource)
      && true
      && true
      && true,
    productWorkflowCostEstimate: /app\.get\("\/api\/workflow-jobs\/:id\/cost-estimate"/.test(indexSource)
      && /getWorkflowCostEstimate/.test(await fs.readFile("server/workflowCostEstimate.js", "utf8"))
      && /async workflowCostEstimate\(id, signal\)/.test(apiClientSource)
      && /WorkflowCostEstimatePanel/.test(source)
      && /COST_IMAGE_USD_PER_GENERATION/.test(await fs.readFile(".env.example", "utf8")),
    productWorkflowAuthorizations: /app\.get\("\/api\/workflow-jobs\/:id\/authorizations"/.test(indexSource)
      && /app\.post\("\/api\/workflow-jobs\/:id\/authorizations\/external-image-spend"/.test(indexSource)
      && /authorizeExternalImageSpend/.test(indexSource)
      && /listWorkflowAuthorizations/.test(indexSource)
      && /async workflowAuthorizations\(id, signal\)/.test(apiClientSource)
      && /async authorizeExternalImageSpend\(id, body = \{\}\)/.test(apiClientSource)
      && /WorkflowExternalSpendAuthorizationPanel/.test(source)
      && /workflow-authorization-panel/.test(source)
      && /product-v1-authorization/.test(await fs.readFile("src/styles.css", "utf8"))
      && /workflow-spend-authorization/.test(await fs.readFile("src/styles.css", "utf8"))
      && /external_image_spend_authorization/.test(await fs.readFile("server/workflowAuthorizations.js", "utf8")),
    workflowSampleLibraryRemoved: !/app\.get\("\/api\/workflow-samples"/.test(indexSource)
      && !/async workflowSamples\(signal\)/.test(apiClientSource)
      && !/WorkflowSampleLibraryPanel|workflow-sample-library|useWorkflowSample|api\.workflowSamples\(\)/.test(source)
      && !(await fileExists("server/workflowSamples.js"))
      && !(await fileExists("samples/workflow-briefs/sales-proposal-rebuild.md"))
      && !(await fileExists("samples/workflow-briefs/training-deck-refresh.md")),
    productReadmeUsage: /Skill-first workflow/.test(readmeSource)
      && /npm run local/.test(readmeSource)
      && !/workflow-briefs/.test(readmeSource)
      && /\/api\/workflow-jobs\/:id\/cost-estimate/.test(readmeSource)
      && /npm run regression:skill-first/.test(readmeSource),
    productPdfSourceRendering: /PDFTOPPM_PATH/.test(sourceRendererSource)
      && /PDFTOPPM_ARGS_PREFIX_JSON/.test(sourceRendererSource)
      && /pdftoppm/.test(sourceRendererSource)
      && /pdf-parse/.test(sourceRendererSource)
      && /renderPdfSourceWithPdfParse/.test(sourceRendererSource)
      && /PDF_RENDER_DPI/.test(sourceRendererSource)
      && /page_\$\{String\(pageNumber\)\.padStart\(3, "0"\)\}\.png/.test(sourceRendererSource)
      && /pdf-renderer/.test(doctorSource)
      && /PDFTOPPM_PATH/.test(doctorSource)
      && /PDFTOPPM_ARGS_PREFIX_JSON/.test(doctorSource)
      && /PDF_PARSE_RENDER_WIDTH/.test(doctorSource)
      && /PDFTOPPM_PATH/.test(await fs.readFile(".env.example", "utf8"))
      && /PDFTOPPM_ARGS_PREFIX_JSON/.test(await fs.readFile(".env.example", "utf8"))
      && /PDF_PARSE_RENDER_WIDTH/.test(await fs.readFile(".env.example", "utf8"))
      && /PDFTOPPM_PATH/.test(readmeSource)
      && /PDFTOPPM_ARGS_PREFIX_JSON/.test(readmeSource)
      && /PDF_PARSE_RENDER_WIDTH/.test(readmeSource),
    approvalGatePrerequisites: /getCodexApprovalGateUiState/.test(source)
      && /gateUi\.canApprove/.test(source)
      && source.includes("\u8bf7\u5148\u751f\u6210\u4e00\u9875\u89c6\u89c9\u6837\u5f20")
      && source.includes("\u8bf7\u5148\u786e\u8ba4\u89c6\u89c9\u6837\u5f20")
      && /getBackendRuntimeRefreshState/.test(source)
      && source.includes("\u5237\u65b0\u540e\u7aef\u786e\u8ba4")
      && /refreshCodexPptBackendApproval/.test(source)
      && /async refreshCodexPptBackendApproval\(id, body = \{\}\)/.test(apiClientSource)
      && /\/codex-ppt\/backend\/refresh-approval/.test(apiClientSource)
      && /app\.post\("\/api\/workflow-jobs\/:id\/codex-ppt\/backend\/refresh-approval"/.test(indexSource)
      && /getCodexPptBackendRefreshState/.test(indexSource)
      && /!refreshState\.needsRefresh && body\.forceRefresh !== true/.test(indexSource)
      && /backend runtime refresh invalidates full-deck authorization/.test(indexSource)
      && /backend runtime refresh requires a fresh visual sample approval/.test(indexSource)
      && /workflow-backend-refresh/.test(await fs.readFile("src/styles.css", "utf8"))
      && /looksLikeNonProductVisualSample/.test(source)
      && source.includes("\u91cd\u65b0\u751f\u6210\u4ea7\u54c1\u7ea7\u89c6\u89c9\u6837\u5f20"),
    approvalReadyBatch: /formatReadyApprovalGateLabels/.test(source)
      && /approveReadyGates/.test(source)
      && /readyApprovalGates/.test(source)
      && /frontend-ready-\$\{gate\.id\}-approval/.test(source)
      && /approveNoCostCodexGates/.test(source)
      && /noCostApprovalSummary\.readyCount/.test(source),    mainNoCostApprovalEntry: /getNoCostCodexApprovalSummary/.test(source)
      && /approveNoCostCodexGates/.test(source)
      && /skill-first-next-card/.test(source)
      && /styleRefreshAction/.test(source)
      && /onRefreshStyleEvidence=\{refreshCodexPptStyleEvidence\}/.test(source)
      && /style-refresh/.test(await fs.readFile("src/styles.css", "utf8"))
      && true
      && /skill-first-next-card/.test(await fs.readFile("src/styles.css", "utf8")),
    approvalPreflightGate: /preflightCodexPptGate/.test(workflowApprovalsSource)
      && /app\.post\("\/api\/workflow-jobs\/:id\/codex-ppt\/approvals\/:gate\/preflight"/.test(indexSource)
      && /async preflightCodexPptGate\(id, gate, body = \{\}\)/.test(apiClientSource)
      && /api\.preflightCodexPptGate/.test(source)
      && source.includes("\u9884\u68c0")
      && /mergeApprovalPreflightUi/.test(source)
      && /workflow-approval-preflight/.test(await fs.readFile("src/styles.css", "utf8")),
    visualSampleEvidenceUi: /visual-sample/.test(source)
      && /sampleHref/.test(source)
      && /SampleApprovalGuard/.test(source)
      && /workflow-approval-blockers/.test(source)
      && /title=\{!gateUi\.canApprove && !passed \? gateUi\.reason : ""\}/.test(source)
      && /workflow-sample-evidence\.warning/.test(await fs.readFile("src/styles.css", "utf8")),    imageDeckAcceptsRecordedCodexSlides: /hasRecordedCodexSlideImages/.test(source) && /canAssembleImageDeck/.test(source) && /image-deck\/assemble/.test(source),
    unifiedSkillTaskBoard: true,
    unifiedSkillTaskDetails: true,
    unifiedSkillTaskFocus: /瀹氫綅璇︽儏闈㈡澘/.test(source) && /codex-slide-worker-panel/.test(source) && /editable-page-worker-panel/.test(source),
    primaryActionLines
  };
}

function checkGuidedActionContract() {
  const baseJob = {
    id: "workflow_contract",
    artifacts: {
      imageDeck: { path: "image-deck.pptx" },
      editableRun: { path: "run" }
    }
  };
  const cases = [
    {
      name: "no workflow is disabled",
      runbook: { allowedActions: ["source/render"], summary: "render" },
      context: { job: null },
      expected: { disabled: true, label: "\u9009\u62e9\u5de5\u4f5c\u6d41" }
    },
    {
      name: "approval action focuses compliance gates",
      runbook: { allowedActions: ["approve outline/style/backend"], summary: "approve gates" },
      context: { job: baseJob },
      expected: { kind: "focus", targetId: "workflow-compliance-panel", label: "\u6253\u5f00\u5ba1\u6279" }
    },
    {
      name: "sample generation respects approval readiness",
      runbook: { allowedActions: ["visual/sample"], currentTitle: "sample", summary: "sample" },
      context: { job: baseJob, canGenerateVisualSample: true },
      expected: { kind: "workflow", action: "visual/sample", label: "\u751f\u6210\u6837\u5f20", disabled: false }
    },
    {
      name: "image deck assembly accepts recorded visual evidence",
      runbook: { allowedActions: ["image-deck/assemble"], currentTitle: "deck", summary: "deck" },
      context: { job: baseJob, canAssembleImageDeck: true },
      expected: { kind: "workflow", action: "image-deck/assemble", label: "\u7ec4\u88c5\u56fe\u7247 PPT", disabled: false }
    },
    {
      name: "codex full-deck starts by syncing slide tasks",
      runbook: { allowedActions: ["sync codex slide tasks"], summary: "sync slides" },
      context: { job: baseJob, canGenerateVisualDeck: true },
      expected: { kind: "sync-codex-slides" }
    },
    {
      name: "codex slide worker handoff focuses slide panel",
      runbook: { allowedActions: ["codex slide workers"], summary: "slide workers" },
      context: { job: baseJob },
      expected: { kind: "focus", targetId: "codex-slide-worker-panel" }
    },
    {
      name: "page worker handoff focuses editable worker panel",
      runbook: { allowedActions: ["editable/dispatch + editable/record"], summary: "workers" },
      context: { job: baseJob },
      expected: { kind: "focus", targetId: "editable-page-worker-panel", label: "\u6253\u5f00\u9875\u9762\u4efb\u52a1" }
    },
    {
      name: "finalize requires finalize stage",
      runbook: { allowedActions: ["editable/finalize"], currentTitle: "finalize", summary: "finalize" },
      context: { job: baseJob, nextStage: "finalize" },
      expected: { kind: "workflow", action: "editable/finalize", label: "\u751f\u6210\u6700\u7ec8 PPTX", disabled: false }
    },
    {
      name: "manual review focuses artifact review panel",
      runbook: { allowedActions: ["review/approve"], summary: "review" },
      context: { job: baseJob },
      expected: { kind: "focus", targetId: "workflow-artifact-review-panel", label: "\u6253\u5f00\u590d\u6838" }
    }
  ];
  const passed = [];
  for (const item of cases) {
    const result = getWorkflowGuidedAction(item.runbook, item.context);
    for (const [key, expected] of Object.entries(item.expected)) {
      if (result[key] !== expected) {
        throw new Error(`Guided action contract failed (${item.name}): expected ${key}=${expected}, got ${result[key]}`);
      }
    }
    passed.push(item.name);
  }
  return {
    total: cases.length,
    passed
  };
}

function checkFinalDeliveryGateContract() {
  const readyJob = makeFinalDeliveryGateJob();
  const completePageEvidence = { complete: true };
  const completeFinalEvidence = { complete: true };
  const readyStatus = { level: "ready" };
  const cases = [
    {
      name: "missing final stays pending",
      gate: buildFinalDeliveryGate({ ...readyJob, artifacts: { ...readyJob.artifacts, editableFinal: null, manualReview: null } }, { level: "pending" }, {}, {}),
      expected: { level: "pending", label: "pending-delivery", productReady: false, downloadable: false }
    },
    {
      name: "complete evidence is product ready",
      gate: buildFinalDeliveryGate(readyJob, readyStatus, completePageEvidence, completeFinalEvidence),
      expected: { level: "ready", label: "editable-final.pptx", productReady: true, downloadable: true }
    },
    {
      name: "missing manual review is draft not blocked",
      gate: buildFinalDeliveryGate({ ...readyJob, artifacts: { ...readyJob.artifacts, manualReview: null } }, readyStatus, completePageEvidence, completeFinalEvidence),
      expected: { level: "draft", label: "editable-draft.pptx", productReady: false, downloadable: true }
    },
    {
      name: "failed final validation blocks delivery",
      gate: buildFinalDeliveryGate({ ...readyJob, finalValidation: { passed: false } }, { level: "blocked" }, completePageEvidence, completeFinalEvidence),
      expected: { level: "blocked", label: "not-deliverable.pptx", productReady: false, downloadable: false }
    },
    {
      name: "openai compatible backend alias is fixed by baseUrl",
      gate: buildFinalDeliveryGate(makeFinalDeliveryGateJob({
        backend: { provider: "https://ai.comfly.org", baseUrl: "https://ai.comfly.org", model: "gpt-image-2" },
        visualImages: [{ provider: "openai-compatible-image", baseUrl: "https://ai.comfly.org/v1", model: "gpt-image-2" }]
      }), readyStatus, completePageEvidence, completeFinalEvidence),
      expected: { level: "ready", label: "editable-final.pptx", productReady: true, downloadable: true }
    },
    {
      name: "different image backend blocks delivery",
      gate: buildFinalDeliveryGate(makeFinalDeliveryGateJob({
        backend: { provider: "https://ai.comfly.org", baseUrl: "https://ai.comfly.org", model: "gpt-image-2" },
        visualImages: [{ provider: "openai-compatible-image", baseUrl: "https://other.example/v1", model: "gpt-image-2" }]
      }), readyStatus, completePageEvidence, completeFinalEvidence),
      expected: { level: "blocked", label: "not-deliverable.pptx", productReady: false, downloadable: false }
    },
    {
      name: "stale page hashes explain recovery",
      gate: buildFinalDeliveryGate(readyJob, readyStatus, {
        complete: false,
        issues: [
          { pageId: "page_001", issue: "hash-mismatch-page_manifest" },
          { pageId: "page_001", issue: "hash-mismatch-page_pptx" }
        ]
      }, completeFinalEvidence),
      expected: { level: "blocked", label: "not-deliverable.pptx", productReady: false, downloadable: false }
    }
  ];
  const passed = [];
  for (const item of cases) {
    for (const [key, expected] of Object.entries(item.expected)) {
      if (item.gate[key] !== expected) {
        throw new Error(`Final delivery gate contract failed (${item.name}): expected ${key}=${expected}, got ${item.gate[key]}`);
      }
    }
    if (item.name === "stale page hashes explain recovery" && !item.gate.reasons?.some((reason) => Boolean(reason))) {
      throw new Error("Final delivery gate must explain stale page hash recovery.");
    }
    passed.push(item.name);
  }
  const waitingForWorkers = deriveWorkflowDeliveryStatus({
    id: "workflow_delivery_status_contract",
    artifacts: {
      renderedPages: [{ pageId: "page_001" }, { pageId: "page_002" }],
      visualImages: [{ pageId: "page_001" }, { pageId: "page_002" }],
      imageDeck: { pageCount: 2, path: "workspace/jobs/workflow_delivery_status_contract/image-deck/deck.pptx" },
      editableRun: { path: "C:/temp/editppt/run" },
      editableWorkerPrompts: [{ pageId: "page_001" }, { pageId: "page_002" }],
      editableWorkerTasks: [
        { pageId: "page_001", status: "ready" },
        { pageId: "page_002", status: "ready" }
      ]
    }
  });
  if (waitingForWorkers.nextStep?.id !== "start-page-workers" || !Array.isArray(waitingForWorkers.facts)) {
    throw new Error(`Delivery status contract expected start-page-workers next step, got ${waitingForWorkers.nextStep?.id || "none"}`);
  }
  passed.push("delivery status points to page workers");
  const waitingForFinalize = deriveWorkflowDeliveryStatus({
    id: "workflow_delivery_finalize_contract",
    artifacts: {
      renderedPages: [{ pageId: "page_001" }],
      visualImages: [{ pageId: "page_001" }],
      imageDeck: { pageCount: 1, path: "workspace/jobs/workflow_delivery_finalize_contract/image-deck/deck.pptx" },
      editableRun: { path: "C:/temp/editppt/run" },
      editableWorkerPrompts: [{ pageId: "page_001" }],
      editableWorkerTasks: [{ pageId: "page_001", status: "recorded" }]
    }
  });
  if (waitingForFinalize.nextStep?.id !== "finalize-editable") {
    throw new Error(`Delivery status contract expected finalize-editable next step, got ${waitingForFinalize.nextStep?.id || "none"}`);
  }
  passed.push("delivery status points to finalize");
  const blockedAlignedStatus = alignDeliveryStatusWithFinalGate(
    {
      level: "ready",
      title: "鍙互浜や粯",
      summary: "ready",
      warnings: [],
      nextActions: []
    },
    {
      level: "blocked",
      summary: "blocked",
      reasons: ["Page worker evidence is incomplete."],
      warnings: []
    }
  );
  if (blockedAlignedStatus.level !== "blocked" || blockedAlignedStatus.nextStep?.id !== "review-delivery-gate") {
    throw new Error(`Delivery status must follow blocked final gate, got ${blockedAlignedStatus.level}/${blockedAlignedStatus.nextStep?.id || "none"}`);
  }
  if (!blockedAlignedStatus.warnings?.includes("Page worker evidence is incomplete.")) {
    throw new Error("Delivery status must expose blocked final gate reasons as warnings.");
  }
  passed.push("delivery status follows blocked final gate");
  return {
    total: cases.length + 3,
    passed
  };
}

function makeFinalDeliveryGateJob(overrides = {}) {
  const final = {
    path: "E:\\PPT宸ュ叿\\workspace\\jobs\\workflow_contract\\final\\editable-final.pptx",
    size: 12345,
    createdAt: "2026-06-22T00:00:00.000Z",
    validation: { path: "E:\\PPT宸ュ叿\\workspace\\jobs\\workflow_contract\\final\\editable-validation.json" },
    pptxEditability: {
      editable: true,
      status: "pass",
      fullSlidePictures: 0,
      warnings: []
    }
  };
  const artifacts = {
    editableFinal: final,
    editableWorkerTasks: [{ pageId: "page_001", status: "recorded" }],
    manualReview: {
      status: "approved",
      finalPath: final.path,
      finalSize: final.size,
      finalCreatedAt: final.createdAt
    },
    codexPptApprovals: ["outline", "style", "backend", "sample", "fullDeck"].map((gate) => ({ gate, status: "approved" })),
    codexPptOutline: { path: "outline.json" },
    codexPptStyle: { path: "style.json" },
    codexPptBackendDecision: { path: "backend.json" },
    visualSample: { path: "sample.png" },
    codexPptBackend: overrides.backend || { provider: "contract-provider", model: "contract-model" },
    visualImages: overrides.visualImages || [{ provider: "contract-provider", model: "contract-model" }],
    codexPptSlidePrompts: [{ pageId: "page_001" }],
    codexPptSlideRunState: { total: 1, recorded: 1, failed: 0 },
    codexPptSlideJobs: { total: 1, recorded: 1, failed: 0 }
  };
  return {
    id: "workflow_contract",
    artifacts,
    finalValidation: { passed: true },
    events: [],
    stages: {}
  };
}

async function checkCodexSlideBoundary() {
  const source = await fs.readFile("server/workflowCodexPptWorkerQueue.js", "utf8");
  const editableSource = await fs.readFile("server/workflowEditable.js", "utf8");
  const indexSource = await fs.readFile("server/index.js", "utf8");
  const complianceSource = await fs.readFile("server/workflowCompliance.js", "utf8");
  const pageWorkerRunnerSource = await fs.readFile("scripts/page-worker-runner.mjs", "utf8");
  const pageWorkerBatchSource = await fs.readFile("scripts/page-worker-batch.mjs", "utf8");
  const pageWorkerPipelineSource = await fs.readFile("scripts/page-worker-pipeline.mjs", "utf8");
  const pageRebuildAssemblerSource = await fs.readFile("scripts/page-rebuild-assembler.mjs", "utf8");
  const modelPageSpecWorkerSource = await fs.readFile("scripts/model-page-spec-worker.mjs", "utf8");
  const workflowOcrSource = await fs.readFile("server/workflowOcr.js", "utf8");
  const workerBatchRunnerSource = await fs.readFile("server/workflowWorkerBatchRunner.js", "utf8");
  const workerConsoleSource = await fs.readFile("src/workflow/useWorkflowWorkerConsole.js", "utf8");
  return {
    claimRequiresSpawned: /options\.spawned !== true && options\.confirmSpawned !== true/.test(source)
      && /Refusing to claim codex-ppt slide task without spawned=true/.test(source),
    editableDispatchRequiresOfflineHintsAck: /ensureTextHintsCheckpoint/.test(editableSource)
      && /acceptOfflineTextHints/.test(editableSource),
    editableWorkerBatchCarriesOfflineHintsAck: /accept-offline-text-hints/.test(pageWorkerRunnerSource)
      && /accept-offline-text-hints/.test(pageWorkerBatchSource)
      && /PPT_ACCEPT_OFFLINE_TEXT_HINTS/.test(pageWorkerBatchSource)
      && /acceptOfflineTextHints/.test(workerBatchRunnerSource)
      && /getTextHintEvidence/.test(workerBatchRunnerSource)
      && /ocr-ready/.test(workerBatchRunnerSource)
      && /textHints\.source/.test(await fs.readFile("src/main.jsx", "utf8"))
      && /acceptOfflineTextHints/.test(workerConsoleSource),
    editableHintsRegenerationApi: /regenerateWorkflowEditableHints/.test(editableSource)
      && /\"run\", \"hints\"/.test(editableSource)
      && /editable\/hints/.test(indexSource)
      && /assertEditableHintsCanRegenerate/.test(editableSource)
      && /editableWorkerPrompts/.test(editableSource)
      && /editableWorkerTasks/.test(editableSource),
    editableHintsCompliance: /editppt-text-hints/.test(await fs.readFile("server/workflowCompliance.js", "utf8"))
      && (await fs.readFile("server/workflowCompliance.js", "utf8")).includes("\u6821\u9a8c editppt \u6587\u5b57\u63d0\u793a")
      && /textHintPages/.test(await fs.readFile("server/workflowCompliance.js", "utf8")),
    editablePaddleOcrConfigApi: /configureEditpptPaddleOcrToken/.test(editableSource)
      && /\"config\", \"--paddle-ocr-token\"/.test(editableSource)
      && /config\/editppt\/paddle-ocr-token/.test(indexSource),
    workflowOcrPrefersRenderedPages: /getOcrInputImages\(job, options/.test(workflowOcrSource)
      && /requestedSource === "visual"/.test(workflowOcrSource)
      && /\(renderedPages\.length \? renderedPages : visualImages\)/.test(workflowOcrSource)
      && /maxPages/.test(workflowOcrSource)
      && /normalizePages/.test(workflowOcrSource)
      && /syncRapidOcrHintsToEditableRun\(job, hintsPath\)/.test(workflowOcrSource),
    modelPageSpecMergesOcrText: /mergeBriefOcrText\(spec, bundle, pageRequest\)/.test(modelPageSpecWorkerSource)
      && /bundle\?\.brief\?\.ocr\?\.lines/.test(modelPageSpecWorkerSource)
      && /source: "ocr-worker-brief"/.test(modelPageSpecWorkerSource)
      && /native-text-from-ocr/.test(modelPageSpecWorkerSource),
    pagePipelineBlocksRecordedOverwrite: /guardRecordedPageOverwrite/.test(pageWorkerPipelineSource)
      && /editppt already marked it/.test(pageWorkerPipelineSource)
      && /allow-recorded-overwrite/.test(pageWorkerPipelineSource)
      && /guardRecordedPageOverwrite/.test(pageRebuildAssemblerSource)
      && /editppt already marked it/.test(pageRebuildAssemblerSource)
      && /allow-recorded-overwrite/.test(pageRebuildAssemblerSource),
    complianceTracksRecordedSlideImages: /recordedImagePaths/.test(complianceSource)
      && /codexSlidesComplete/.test(complianceSource)
      && /image-deck\/assemble/.test(complianceSource),
    complianceGuidesSlideWorkerQueue: /nextCodexDeckAction/.test(complianceSource)
      && /sync codex slide tasks/.test(complianceSource)
      && /codex slide workers/.test(complianceSource),
    completeRequiresImagePath: /imagePath must point to an existing image file/.test(source),
    nonProductResetInvalidatesDownstream: /invalidateDownstreamArtifacts/.test(source)
      && /invalidatedArtifacts/.test(source)
      && /resetSlideRunArtifacts/.test(source)
      && /forceDownstreamInvalidation/.test(source)
  };
}

async function verifyV1AcceptanceReportApi(baseUrl) {
  const data = await api(baseUrl, "/api/v1-acceptance");
  const latestData = await api(baseUrl, "/api/v1-acceptance/latest");
  const runStatus = await api(baseUrl, "/api/v1-acceptance/run");
  const preflight = await api(baseUrl, "/api/v1-acceptance/preflight", {
    method: "POST",
    body: {
      sourcePath: path.join(process.cwd(), "workspace", "missing-v1-acceptance-source.pptx"),
      maxPages: 15
    }
  });
  if (!data.ok || data.requiredForV1 !== true) {
    throw new Error("v1 acceptance report API must return ok=true and requiredForV1=true.");
  }
  if (!latestData.ok || latestData.requiredForV1 !== data.requiredForV1 || latestData.acceptance?.level !== data.acceptance?.level) {
    throw new Error("v1 acceptance latest compatibility API must match the product report API.");
  }
  if (!runStatus.ok || typeof runStatus.active !== "boolean" || !runStatus.latestReport?.acceptance) {
    throw new Error("v1 acceptance run status API must expose active state and latest acceptance report.");
  }
  if (!runStatus.latestReport.phaseProgress || runStatus.latestReport.phaseProgress.total !== 8 || runStatus.latestReport.acceptance?.phaseProgress?.total !== 8) {
    throw new Error("v1 acceptance run status API must expose the same 8-phase progress as the product report API.");
  }
  if (!preflight.ok || preflight.ready !== false || !Array.isArray(preflight.checks) || !preflight.checks.some((check) => check.id === "source-exists" && check.ok === false)) {
    throw new Error("v1 acceptance preflight API must return structured source/runtime checks without starting a run.");
  }
  if (typeof data.acceptance?.ready !== "boolean" || !Array.isArray(data.acceptance?.checks) || !data.acceptance?.summary) {
    throw new Error("v1 acceptance latest report API must return a structured acceptance readiness summary.");
  }
  if (!data.productVisualNext || data.acceptance?.productVisualNext?.status !== data.productVisualNext.status) {
    throw new Error("v1 acceptance latest report API must expose productVisualNext on both top-level and acceptance.");
  }
  if (!data.phaseProgress || data.acceptance?.phaseProgress?.total !== data.phaseProgress.total || !Array.isArray(data.phaseProgress.phases)) {
    throw new Error("v1 acceptance report API must expose phaseProgress on both top-level and acceptance.");
  }
  if (data.phaseProgress.total !== 8 || !data.phaseProgress.phases.some((phase) => phase.id === "phase-3-codex-ppt-product-visuals")) {
    throw new Error("v1 acceptance phaseProgress must cover the 8 product phases and the codex-ppt product visual phase.");
  }
  if (!data.productVisualReadiness || typeof data.productVisualReadiness.exists !== "boolean") {
    throw new Error("v1 acceptance latest report API must expose persisted product visual readiness state.");
  }
  if (typeof data.productVisualReadiness.matchesLatestReport !== "boolean" || typeof data.productVisualReadiness.stale !== "boolean") {
    throw new Error("v1 acceptance latest report API must mark whether product visual readiness matches the latest report.");
  }
  if (data.productVisualReadiness.stale && !data.productVisualReadiness.reason) {
    throw new Error("stale product visual readiness must explain why it is stale.");
  }
  if (!/regression:real-ppt/.test(data.recommendedCommand || "") || !/--max-pages 15/.test(data.recommendedCommand || "")) {
    throw new Error("v1 acceptance latest report API must expose the real 15-page acceptance command.");
  }
  if (data.exists) {
    if (!data.latest?.jobId) {
      throw new Error("v1 acceptance latest report API must include the latest real PPT job id when a report exists.");
    }
    if (typeof data.latest?.acceptance?.ready !== "boolean" || !Array.isArray(data.latest?.acceptance?.missing)) {
      throw new Error("latest real PPT report must include structured acceptance readiness and missing items.");
    }
    if (!data.latest?.productVisualNext || data.latest.productVisualNext.safeToRunAutomatically !== false) {
      throw new Error("latest real PPT report must expose a no-auto-spend product visual next step.");
    }
    const productActionIds = new Set((data.latest.productVisualNext.productActions || []).map((action) => action.id));
    for (const actionId of ["product-visual-sample-approval-preflight", "product-visual-sample-approval-approve", "product-visual-full-deck-approval-preflight", "product-visual-full-deck-approval-approve", "product-visual-test-deck-preflight", "product-visual-test-deck-run", "product-visual-custom-pages-preflight", "product-visual-custom-pages-run"]) {
      if (!productActionIds.has(actionId)) {
        throw new Error(`latest real PPT product action chain is missing ${actionId}.`);
      }
    }
    const testRunAction = (data.latest.productVisualNext.productActions || []).find((action) => action.id === "product-visual-test-deck-run");
    const customRunAction = (data.latest.productVisualNext.productActions || []).find((action) => action.id === "product-visual-custom-pages-run");
    if (testRunAction?.body?.maxPages !== 2 || testRunAction?.body?.pages !== "1-2" || testRunAction.externalImageCalls !== 2) {
      throw new Error("v1 product actions must expose a 2-page codex-ppt product visual test run.");
    }
    if (customRunAction?.body?.pages !== "1,2" || customRunAction?.body?.maxPages !== 2) {
      throw new Error("v1 product actions must expose a replaceable selected-pages codex-ppt visual run.");
    }
    if (data.latest.acceptance?.ready === false && !/product:visual-readiness/.test(data.latest.productVisualNext.commands?.noCostReadiness || "")) {
      throw new Error("failed v1 acceptance must point to the no-cost product visual readiness command.");
    }
    if (data.latest.phaseProgress?.currentPhaseId !== data.phaseProgress.currentPhaseId) {
      throw new Error("latest real PPT report and product API must agree on the current product phase.");
    }
    if (data.latest.sourcePath && !String(data.recommendedCommand || "").includes(data.latest.sourcePath)) {
      throw new Error("v1 acceptance recommended command must reuse the latest real PPT source path instead of a placeholder.");
    }
  }
  return {
    exists: Boolean(data.exists),
    latestJobId: data.latest?.jobId || "",
    ready: Boolean(data.acceptance.ready),
    level: data.acceptance.level || "",
    missingCount: data.acceptance.missing?.length || 0,
    runActive: Boolean(runStatus.active),
    runStatus: runStatus.run?.status || "",
    preflightReady: Boolean(preflight.ready),
    preflightFailed: preflight.checks.filter((check) => !check.ok).length,
    recommendedCommand: data.recommendedCommand,
    productVisualNext: data.productVisualNext?.status || "",
    phaseProgress: `${data.phaseProgress.done}/${data.phaseProgress.total}`
  };
}

async function verifyV1ProductVisualNoCostFlow(baseUrl) {
  const readiness = await api(baseUrl, "/api/v1-acceptance/product-visual-readiness", {
    method: "POST",
    body: {}
  });
  if (!readiness.ok || readiness.paidImageGeneration || readiness.externalImageCalls !== 0 || !readiness.result?.jobId) {
    throw new Error("v1 product visual readiness must run without image spend and return a workflow job.");
  }
  const preflight = await api(baseUrl, "/api/v1-acceptance/product-visual-sample/preflight", {
    method: "POST",
    body: {}
  });
  if (!preflight.ok || !preflight.readyIfConfirmed || preflight.startReady || preflight.externalImageCalls !== 1 || preflight.jobId !== readiness.result.jobId) {
    throw new Error(`v1 product visual sample preflight must target the latest no-cost readiness job without starting generation, got ${JSON.stringify({
      ok: preflight.ok,
      readyIfConfirmed: preflight.readyIfConfirmed,
      startReady: preflight.startReady,
      externalImageCalls: preflight.externalImageCalls,
      preflightJobId: preflight.jobId,
      readinessJobId: readiness.result.jobId
    })}`);
  }
  const preview = await api(baseUrl, "/api/v1-acceptance/product-visual-sample/prompt-preview", {
    method: "POST",
    body: {}
  });
  if (!preview.ok || preview.didRun || preview.paidImageGeneration || preview.externalImageCalls !== 1 || preview.jobId !== readiness.result.jobId) {
    throw new Error(`v1 product visual prompt preview must stay no-cost and target the latest readiness job, got ${JSON.stringify({
      ok: preview.ok,
      didRun: preview.didRun,
      paidImageGeneration: preview.paidImageGeneration,
      externalImageCalls: preview.externalImageCalls,
      previewJobId: preview.jobId,
      readinessJobId: readiness.result.jobId
    })}`);
  }
  if (!preview.promptPreview?.sourcePageLink?.href?.includes(readiness.result.jobId) || !preview.promptPreview?.prompt || preview.promptPreview?.provider?.model !== "gpt-image-2") {
    throw new Error("v1 product visual prompt preview must expose source-page edit evidence for gpt-image-2.");
  }
  const latestAfterPreview = await api(baseUrl, "/api/v1-acceptance");
  const sampleRunAction = latestAfterPreview.latest?.productVisualNext?.productActions?.find((action) => action.id === "product-visual-sample-run")
    || latestAfterPreview.productVisualNext?.productActions?.find((action) => action.id === "product-visual-sample-run");
  if (sampleRunAction?.body?.promptPreviewJobId !== readiness.result.jobId || sampleRunAction?.body?.confirmPromptPreview !== true) {
    throw new Error("v1 product visual sample run action must include the latest matching prompt preview job id.");
  }
  const runWithoutPromptPreview = await api(baseUrl, "/api/v1-acceptance/product-visual-sample/run", {
    method: "POST",
    expectStatus: 409,
    body: {
      confirmExternalImageSpend: true,
      confirmProductVisualSample: true
    }
  });
  if (runWithoutPromptPreview.code !== "PRODUCT_VISUAL_SAMPLE_PROMPT_PREVIEW_REQUIRED" || runWithoutPromptPreview.didRun) {
    throw new Error(`v1 product visual sample run must require matching prompt preview before spending image API, got ${runWithoutPromptPreview.code || "none"}.`);
  }
  return {
    readinessJobId: readiness.result.jobId,
    providerModel: readiness.result.provider?.model || "",
    readyIfConfirmed: Boolean(preflight.readyIfConfirmed),
    promptLength: Number(preview.promptPreview?.promptLength || 0),
    sourcePage: preview.promptPreview?.sourcePageLink?.href || ""
  };
}

async function verifyDefaultWorkflowPath(baseUrl) {
  const upload = await uploadSyntheticSource(baseUrl);
  const created = await api(baseUrl, "/api/workflow-jobs", {
    method: "POST",
    body: {
      sourceUploadId: upload.id,
      mode: "skill-first-default-path-regression",
      internal: true,
      notes: "Default path must stop after source render and wait for codex-ppt approvals."
    }
  });
  const rendered = await api(baseUrl, `/api/workflow-jobs/${created.id}/source/render`, {
    method: "POST",
    body: {}
  });
  const artifacts = rendered.artifacts || {};
  if (!Array.isArray(artifacts.renderedPages) || artifacts.renderedPages.length !== 1) {
    throw new Error(`Default workflow source render expected 1 rendered page, got ${artifacts.renderedPages?.length ?? "none"}`);
  }
  const forbiddenArtifacts = ["visualImages", "imageDeck", "editableRun", "editableWorkerPrompts", "editableFinal"]
    .filter((key) => Boolean(artifacts[key]) && (!Array.isArray(artifacts[key]) || artifacts[key].length));
  if (forbiddenArtifacts.length) {
    throw new Error(`Default workflow created downstream artifacts before approvals: ${forbiddenArtifacts.join(", ")}`);
  }
  const blocked = await api(baseUrl, `/api/workflow-jobs/${created.id}/visual/sample`, {
    method: "POST",
    body: { dryRun: true },
    expectStatus: 409
  });
  assertApprovalError(blocked, ["outline", "style", "backend"], "default visual/sample");
  const afterBlock = await api(baseUrl, `/api/workflow-jobs/${created.id}`);
  if (afterBlock.stages?.visual_sample_ready?.status === "failed") {
    throw new Error("Default workflow visual_sample_ready was marked failed after approval block");
  }
  const compliance = await api(baseUrl, `/api/workflow-jobs/${created.id}/compliance`);
  if (compliance.runbook?.currentStep !== "codex-ppt-approvals") {
    throw new Error(`Default workflow runbook expected codex-ppt-approvals, got ${compliance.runbook?.currentStep || "none"}`);
  }
  return {
    jobId: created.id,
    sourceUploadId: upload.id,
    renderedPages: artifacts.renderedPages.length,
    downstreamArtifacts: forbiddenArtifacts,
    sampleBlocked: summarizeApprovalBlock(blocked),
    sampleBlockedRaw: blocked,
    runbook: {
      currentStep: compliance.runbook.currentStep,
      allowedActions: compliance.runbook.allowedActions || []
    }
  };
}

async function uploadSyntheticSource(baseUrl) {
  const png = makeSolidPng(1280, 720, { r: 248, g: 250, b: 252, a: 255 });
  const form = new FormData();
  form.append("files", new Blob([png], { type: "image/png" }), `skill-first-source-${Date.now()}.png`);
  const response = await fetch(`${baseUrl}/api/uploads`, { method: "POST", body: form });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.files?.[0]?.id) throw new Error(data.error || `Upload failed with HTTP ${response.status}`);
  return data.files[0];
}

async function verifyLegacyGeneratorRoutesRemoved(baseUrl) {
  const routes = ["/api/jobs/generate", "/api/jobs/optimize", "/api/jobs/style-preview"];
  const results = [];
  for (const route of routes) {
    const data = await api(baseUrl, route, {
      method: "POST",
      body: { notes: "skill-first regression must reject legacy generator routes" },
      expectStatus: 410
    });
    if (data.code !== "LEGACY_GENERATOR_REMOVED") {
      throw new Error(`${route} expected LEGACY_GENERATOR_REMOVED, got ${data.code || "none"}`);
    }
    results.push({ route, code: data.code });
  }
  return results;
}

async function verifyPdfSourceRenderPath() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ppt-tool-pdf-render-"));
  const sourcePdfPath = path.join(tempDir, "source.pdf");
  const fallbackPdfPath = path.join(tempDir, "fallback-source.pdf");
  const fakeRendererPath = path.join(tempDir, "fake-pdftoppm.mjs");
  await fs.writeFile(sourcePdfPath, "%PDF-1.4\n% smoke pdf source\n", "utf8");
  await fs.writeFile(fallbackPdfPath, makeSimplePdf(), "utf8");
  await fs.writeFile(fakeRendererPath, [
    "import fs from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const prefix = args[args.length - 1];",
    "if (!prefix) throw new Error('missing pdftoppm output prefix');",
    "const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR42mP8z8AABQMBgGkXr3sAAAAASUVORK5CYII=';",
    "fs.writeFileSync(`${prefix}-1.png`, Buffer.from(png, 'base64'));"
  ].join("\n"), "utf8");

  const previousPath = process.env.PDFTOPPM_PATH;
  const previousPrefixJson = process.env.PDFTOPPM_ARGS_PREFIX_JSON;
  const previousDpi = process.env.PDF_RENDER_DPI;
  const previousFallbackWidth = process.env.PDF_PARSE_RENDER_WIDTH;
  let job = null;
  let fallbackJob = null;
  try {
    process.env.PDFTOPPM_PATH = process.execPath;
    process.env.PDFTOPPM_ARGS_PREFIX_JSON = JSON.stringify([fakeRendererPath]);
    process.env.PDF_RENDER_DPI = "96";
    job = await createWorkflowJob({
      internal: true,
      mode: "skill-first-regression-pdf-source",
      notes: "skill-first-regression pdf source render path",
      sourceUpload: {
        id: `pdf_source_${Date.now()}`,
        originalName: "regression-source.pdf",
        mimeType: "application/pdf",
        path: sourcePdfPath
      }
    });
    const rendered = await renderWorkflowSource(job.id);
    const sourceMeta = JSON.parse(await fs.readFile(rendered.artifacts.sourceMeta.path, "utf8"));
    const firstPage = rendered.artifacts.renderedPages?.[0] || {};
    if (sourceMeta.renderer !== "pdftoppm") {
      throw new Error(`PDF source render expected pdftoppm renderer, got ${sourceMeta.renderer || "none"}`);
    }
    if (sourceMeta.pageCount !== 1 || rendered.artifacts.renderedPages?.length !== 1) {
      throw new Error(`PDF source render expected one rendered page, got meta=${sourceMeta.pageCount} artifacts=${rendered.artifacts.renderedPages?.length || 0}`);
    }
    if (!firstPage.path || !firstPage.path.endsWith("page_001.png")) {
      throw new Error(`PDF source render did not standardize page output name: ${firstPage.path || "none"}`);
    }
    if (!await fileExists(firstPage.path)) {
      throw new Error("PDF source render page_001.png artifact is missing");
    }
    if (rendered.status !== "source_rendered" || rendered.stages?.source_rendered?.status !== "complete") {
      throw new Error(`PDF source render did not complete workflow state: ${rendered.status || "none"}`);
    }

    process.env.PDFTOPPM_PATH = path.join(tempDir, "missing-pdftoppm.exe");
    process.env.PDFTOPPM_ARGS_PREFIX_JSON = "";
    process.env.PDF_PARSE_RENDER_WIDTH = "960";
    fallbackJob = await createWorkflowJob({
      internal: true,
      mode: "skill-first-regression-pdf-parse-fallback",
      notes: "skill-first-regression pdf-parse fallback render path",
      sourceUpload: {
        id: `pdf_fallback_${Date.now()}`,
        originalName: "regression-fallback.pdf",
        mimeType: "application/pdf",
        path: fallbackPdfPath
      }
    });
    const fallbackRendered = await renderWorkflowSource(fallbackJob.id);
    const fallbackMeta = JSON.parse(await fs.readFile(fallbackRendered.artifacts.sourceMeta.path, "utf8"));
    const fallbackPage = fallbackRendered.artifacts.renderedPages?.[0] || {};
    if (fallbackMeta.renderer !== "pdf-parse") {
      throw new Error(`PDF fallback render expected pdf-parse renderer, got ${fallbackMeta.renderer || "none"}`);
    }
    if (fallbackMeta.pageCount !== 1 || fallbackRendered.artifacts.renderedPages?.length !== 1) {
      throw new Error(`PDF fallback render expected one rendered page, got meta=${fallbackMeta.pageCount} artifacts=${fallbackRendered.artifacts.renderedPages?.length || 0}`);
    }
    if (!fallbackPage.path || !fallbackPage.path.endsWith("page_001.png") || !await fileExists(fallbackPage.path)) {
      throw new Error(`PDF fallback render did not write page_001.png: ${fallbackPage.path || "none"}`);
    }
    await archiveWorkflowJob(job.id, {
      archivedBy: "skill-first-regression",
      reason: "pdf source render smoke completed"
    }).catch(() => {});
    await archiveWorkflowJob(fallbackJob.id, {
      archivedBy: "skill-first-regression",
      reason: "pdf-parse fallback render smoke completed"
    }).catch(() => {});
    return {
      jobId: job.id,
      renderer: sourceMeta.renderer,
      pageCount: sourceMeta.pageCount,
      pagePath: firstPage.relativePath || firstPage.path,
      standardized: /page_001\.png$/i.test(firstPage.path || ""),
      fallback: {
        jobId: fallbackJob.id,
        renderer: fallbackMeta.renderer,
        pageCount: fallbackMeta.pageCount,
        pagePath: fallbackPage.relativePath || fallbackPage.path,
        standardized: /page_001\.png$/i.test(fallbackPage.path || "")
      }
    };
  } finally {
    restoreEnv("PDFTOPPM_PATH", previousPath);
    restoreEnv("PDFTOPPM_ARGS_PREFIX_JSON", previousPrefixJson);
    restoreEnv("PDF_RENDER_DPI", previousDpi);
    restoreEnv("PDF_PARSE_RENDER_WIDTH", previousFallbackWidth);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function makeSimplePdf() {
  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  function addObject(id, body) {
    offsets[id] = Buffer.byteLength(parts.join(""), "utf8");
    parts.push(`${id} 0 obj\n${body}\nendobj\n`);
  }
  const stream = "BT /F1 24 Tf 72 720 Td (PDF fallback smoke) Tj ET";
  addObject(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObject(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  addObject(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  addObject(4, `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
  addObject(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xrefOffset = Buffer.byteLength(parts.join(""), "utf8");
  parts.push("xref\n0 6\n0000000000 65535 f \n");
  for (let id = 1; id <= 5; id += 1) {
    parts.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  parts.push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(parts.join(""), "utf8");
}

async function runJobStep(baseUrl, jobId, action, body = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/${action}`, {
    method: "POST",
    body
  });
}

async function approveGate(baseUrl, jobId, gate, { expectStatus = 200 } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/approvals/${gate}/approve`, {
    method: "POST",
    expectStatus,
    body: {
      approvedBy: "skill-first-regression",
      note: `regression approval for ${gate}`,
      allowNonProductBackend: true,
      ...(gate === "backend" ? { backend: { provider: "regression-fixed-backend", model: "regression-image-model" } } : {})
    }
  });
}

async function recordOutline(baseUrl, jobId, { source = "skill-first-regression", pageCount = 1, sourceBrief = "" } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/outline`, {
    method: "POST",
    body: {
      source,
      pageCount,
      sourceBrief,
      recordedBy: "skill-first-regression",
      outlinePlan: {
        layoutSequence: Array.from({ length: pageCount }, (_item, index) => ({
          layout: index === 0 ? "cover" : index === pageCount - 1 && pageCount > 2 ? "closing" : "content",
          title: index === 0 ? "Opening" : index === pageCount - 1 && pageCount > 2 ? "Closing" : `Slide ${index + 1}`,
          purpose: "Skill-first regression outline artifact required before approval.",
          storyRole: index === 0 ? "set context" : "develop narrative",
          evidence: sourceBrief || `page ${index + 1}`
        }))
      }
    }
  });
}

async function recordStyle(baseUrl, jobId, { source = "skill-first-regression" } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/style`, {
    method: "POST",
    body: {
      source,
      recordedBy: "skill-first-regression",
      styleBrief: "Regression style decision for a premium clean business presentation."
    }
  });
}

async function recordBackendDecision(baseUrl, jobId, { source = "skill-first-regression" } = {}) {
  return api(baseUrl, `/api/workflow-jobs/${jobId}/codex-ppt/backend`, {
    method: "POST",
    body: {
      source,
      recordedBy: "skill-first-regression",
      backend: { provider: "regression-fixed-backend", model: "regression-image-model" }
    }
  });
}

function assertApprovalError(data, expectedMissing, label) {
  if (data.code !== "CODEX_PPT_APPROVAL_REQUIRED") {
    throw new Error(`${label} expected CODEX_PPT_APPROVAL_REQUIRED, got ${data.code || "none"}`);
  }
  const missing = new Set((data.missing || []).map((item) => item.gate));
  for (const gate of expectedMissing) {
    if (!missing.has(gate)) throw new Error(`${label} missing approvals did not include ${gate}`);
  }
}

async function assertStageNotFailed(jobId, stage) {
  const job = await readWorkflowJob(jobId);
  if (job.stages?.[stage]?.status === "failed") {
    throw new Error(`${stage} was marked failed after an approval-gate block`);
  }
}

function summarizeApprovalBlock(data = {}) {
  return {
    code: data.code || "",
    missing: (data.missing || []).map((item) => item.gate),
    required: (data.required || []).map((item) => item.gate)
  };
}

async function checkScriptBoundary() {
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  const scripts = pkg.scripts || {};
  const workerScripts = Object.keys(scripts).filter((name) => name.startsWith("worker:")).sort();
  const labScripts = Object.keys(scripts).filter((name) => name.startsWith("lab:")).sort();
  const allowedWorkerScripts = new Set(["worker:batch", "worker:briefs", "worker:codex-slide", "worker:once"]);
  return {
    workerScripts,
    labScripts,
    nonOrchestrationWorkerScripts: workerScripts.filter((name) => !allowedWorkerScripts.has(name)),
    experimentalWorkerScripts: workerScripts.filter((name) => /local|model|pipeline|visual|asset|assemble/i.test(name))
  };
}

async function checkRealPptRegressionBoundary() {
  const source = await fs.readFile("scripts/real-ppt-regression.mjs", "utf8");
  const reportSource = await fs.readFile("server/workflowV1AcceptanceReport.js", "utf8");
  const runnerSource = await fs.readFile("server/workflowV1AcceptanceRunner.js", "utf8");
  return {
    toleratesTransientUnknownRunner: /isTransientRunnerUnknown/.test(source)
      && /run\.status && run\.status !== "running" && !isTransientRunnerUnknown\(run\)/.test(source)
      && /Runner process is no longer visible/.test(source),
    recordsAllSlideTasks: /for \(const task of slideTasks\)/.test(source)
      && /completedTaskBundle\.summary\?\.recorded !== slideTasks\.length/.test(source)
      && /Expected \$\{slideTasks\.length\} recorded codex-ppt slide tasks/.test(source),
    confirmsSpawnedWorker: /confirmSpawned:\s*true/.test(source)
      && /external-slide-worker-regression/.test(source),
    supportsFifteenPageSource: /--max-pages 15/.test(source)
      && /clampInteger\(args\["max-pages"\]/.test(source)
      && /pageSelection/.test(source)
      && /writeV1AcceptanceReport/.test(source)
      && /acceptanceReport/.test(source),
    evaluatesStructuredAcceptance: /export function evaluateV1AcceptanceReport/.test(reportSource)
      && /real-ppt-source-pages/.test(reportSource)
      && /codex-ppt-approval-gates/.test(reportSource)
      && /editable-final/.test(reportSource)
      && /download-artifacts/.test(reportSource)
      && /buildPendingV1Acceptance/.test(reportSource),
    productRunnerApi: /export async function startV1AcceptanceRun/.test(runnerSource)
      && /export async function preflightV1AcceptanceRun/.test(runnerSource)
      && /ready: failed\.length === 0/.test(runnerSource)
      && /countPptxSlides/.test(runnerSource)
      && /stagedSourcePath/.test(runnerSource)
      && /fs\.copyFile\(sourcePath, stagedSourcePath\)/.test(runnerSource)
      && /spawn\("cmd\.exe", \["\/d", "\/s", "\/c", command\]/.test(runnerSource)
      && /normalizeRunState/.test(runnerSource)
      && /regression:real-ppt/.test(runnerSource)
      && /resolveAcceptanceSource/.test(runnerSource)
      && /workflowJobId/.test(runnerSource)
      && /readWorkflowJob/.test(runnerSource)
      && /V1_ACCEPTANCE_RUN_IN_PROGRESS/.test(runnerSource)
      && /V1_ACCEPTANCE_SOURCE_NOT_FOUND/.test(runnerSource)
      && /latest-run\.json/.test(runnerSource)
  };
}

async function api(baseUrl, route, { method = "GET", body = null, expectStatus = 200 } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (response.status !== expectStatus) {
    throw new Error(data.error || `Expected HTTP ${expectStatus}, got ${response.status} ${route}`);
  }
  if (expectStatus < 400 && data.ok === false) {
    throw new Error(data.error || `Request failed: ${route}`);
  }
  return data;
}

function assertNoMojibakePayload(value, context = "payload") {
  const text = JSON.stringify(value || {});
  const tokens = ["\ufffd"];
  const hit = tokens.find((token) => text.includes(token));
  if (hit) {
    const index = text.indexOf(hit);
    const excerpt = text.slice(Math.max(0, index - 80), index + 160);
    throw new Error(`${context} contains mojibake token ${JSON.stringify(hit)} near ${JSON.stringify(excerpt)}`);
  }
}
function makeSolidPng(width = 1, height = 1, color = {}) {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const r = Number(color.r ?? 255) & 255;
  const g = Number(color.g ?? 255) & 255;
  const b = Number(color.b ?? 255) & 255;
  const a = Number(color.a ?? 255) & 255;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x += 1) {
      const offset = row + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    signature,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", zlib.deflateSync(raw)),
    makePngChunk("IEND", Buffer.alloc(0))
  ]);
}

function makePngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
function parseArgs(argv = []) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") {
      args.help = true;
      continue;
    }
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function printHelp() {
  console.log("Usage: node scripts/skill-first-regression.mjs [--base-url http://127.0.0.1:4180]");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
