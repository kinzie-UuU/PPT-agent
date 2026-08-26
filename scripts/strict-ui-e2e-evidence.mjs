#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.join(process.cwd(), "workspace", "delivery-evidence", "strict-ui-e2e");
const capturePath = path.join(root, "capture.json");
const capture = JSON.parse(await fs.readFile(capturePath, "utf8"));
const requiredTrue = [
  "taskSearchFiltersRows",
  "newTaskPanelOpens",
  "outlineRequestLocksInputs",
  "taskSidebarRemainsNavigableWhilePlanning",
  "outlineResultStaysInWorkspace",
  "compactOutlineSummaryVisible",
  "existingTaskClosesNewTaskPanel",
  "visualModeShowsTwentyPages",
  "editableModeShowsTwentyPagePlan",
  "editableReviewReturnsToWorkspace",
  "imageReviewDialogOpens",
  "imageReviewRiskFilterVisible",
  "imageReviewPendingFilterVisible",
  "imageReviewRiskFilterWorks",
  "imageReviewPendingFilterWorks",
  "imageReviewAllFilterRestoresRows",
  "imageReviewStaleEvidenceMessageVisible",
  "imageReviewTruncatedDiffsAbsent",
  "imageReviewSubmitDisabledUntilReviewed",
  "routeBHistoricalDraftVisible",
  "routeBReviewLockVisible",
  "blockedFinalDownloadRejected",
  "finalDownloadExposed",
  "deliveryBlockedMessageVisible",
  "medium1200DocumentOverflow",
  "medium1200InspectorVisible",
  "medium1181DocumentOverflow",
  "medium1181InspectorVisible",
  "readyWorkflowVisible",
  "readyDeliveryProductReady",
  "readyDeliveryDownloadable",
  "readyFinalDownloadExposed",
  "readyCompletedGuidanceVisible",
  "readyStaleGenerationActionAbsent",
  "readyTaskCountedComplete",
  "readyFinalDownloadClicked",
  "readyFinalDownloadAccepted",
  "mobileDocumentOverflow"
];
const inverted = new Set(["finalDownloadExposed", "medium1200DocumentOverflow", "medium1181DocumentOverflow", "mobileDocumentOverflow"]);
const assertionFailures = requiredTrue.filter((key) => inverted.has(key) ? capture.checks[key] !== false : capture.checks[key] !== true);
if (capture.workflow?.sourcePages !== 20 || capture.workflow?.visualPages !== 20 || capture.workflow?.editablePages !== 1 || capture.workflow?.closureStatus !== "blocked") assertionFailures.push("workflow-state");
if (capture.workflow?.readyFixture?.sourcePages !== 1 || capture.workflow?.readyFixture?.visualPages !== 1 || capture.workflow?.readyFixture?.editablePages !== 1 || capture.workflow?.readyFixture?.closureStatus !== "ready") assertionFailures.push("ready-fixture-workflow-state");
if (capture.checks?.readyFinalDownloadStatus !== 200) assertionFailures.push("ready-final-download-status");
if (capture.checks?.readyCompletedStageCount !== 5) assertionFailures.push("ready-stage-completion");
if (!capture.browser?.version || capture.browser.version === "unknown") assertionFailures.push("browser-version");
if (!capture.runner || !capture.flow || !capture.trace) assertionFailures.push("replay-artifacts");
if (capture.checks?.imageReviewImages !== 60 || capture.checks?.imageReviewImagesLoaded !== 60) assertionFailures.push("image-review-loads");
if (capture.checks?.imageReviewConfirmButtons !== 20 || capture.checks?.imageReviewRerunButtons !== 20) assertionFailures.push("image-review-actions");
if (
  capture.checks?.imageReviewAllFilterDeclaredCount !== 20
  || capture.checks?.imageReviewAllFilteredRows !== 20
  || capture.checks?.imageReviewRiskFilteredRows !== capture.checks?.imageReviewRiskFilterDeclaredCount
  || capture.checks?.imageReviewPendingFilteredRows !== capture.checks?.imageReviewPendingFilterDeclaredCount
) assertionFailures.push("image-review-filter-counts");
if (Number(capture.checks?.imageReviewConcreteDiffCount || 0) < 1) assertionFailures.push("image-review-concrete-diffs");
if (
  Number(capture.checks?.expectedSemanticBlockedPages || 0) < 1
  || capture.checks?.imageReviewSemanticConfirmations !== capture.checks?.expectedSemanticBlockedPages
) assertionFailures.push("image-review-semantic-confirmations");
if (
  Number(capture.checks?.expectedStyleDriftPages || 0) < 1
  || capture.checks?.imageReviewStyleConfirmations !== capture.checks?.expectedStyleDriftPages
) assertionFailures.push("image-review-style-confirmations");
if (
  Number(capture.checks?.imageReviewRiskAcceptButtonCount || 0) < 1
  || capture.checks?.imageReviewRiskAcceptButtonsDisabled !== capture.checks?.imageReviewRiskAcceptButtonCount
) assertionFailures.push("image-review-risk-acceptance-gate");
if (capture.checks?.editableReviewPassButtons !== 20 || capture.checks?.editableReviewPassButtonsDisabled !== 20) assertionFailures.push("editable-review-gate");
if (capture.checks?.consoleErrors !== 0 || capture.checks?.consoleWarnings !== 0 || capture.checks?.failedNetworkRequests !== 0) assertionFailures.push("browser-runtime-errors");

const distIndexPath = path.resolve("dist/index.html");
const distIndex = await fs.readFile(distIndexPath, "utf8");
const entryDistAssetPaths = [...distIndex.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/gi)]
  .map((match) => path.join("dist", match[1].replace(/^\//, "")));
if (!entryDistAssetPaths.length) assertionFailures.push("dist-assets-missing");
const loadedAssetNames = new Set((capture.loadedAssets || []).map((value) => path.basename(new URL(value, capture.baseUrl).pathname)));
const missingEntryAssets = entryDistAssetPaths.filter((value) => !loadedAssetNames.has(path.basename(value)));
if (missingEntryAssets.length) assertionFailures.push("latest-build-entry-assets-not-loaded");
const loadedDistAssetPaths = [...new Set((capture.loadedAssets || [])
  .map((value) => new URL(value, capture.baseUrl).pathname)
  .filter((value) => /^\/assets\/[^/]+\.(?:js|css)$/i.test(value))
  .map((value) => path.join("dist", value.replace(/^\//, ""))))];
const missingLoadedDistAssets = [];
for (const assetPath of loadedDistAssetPaths) {
  if (!await fileExists(assetPath)) missingLoadedDistAssets.push(assetPath);
}
if (missingLoadedDistAssets.length) assertionFailures.push("loaded-build-assets-missing-from-dist");
if (!loadedDistAssetPaths.some((value) => /^PptAgentWorkspace-.*\.js$/i.test(path.basename(value)))) assertionFailures.push("workspace-lazy-js-not-loaded");
if (!loadedDistAssetPaths.some((value) => /^PptAgentWorkspace-.*\.css$/i.test(path.basename(value)))) assertionFailures.push("workspace-lazy-css-not-loaded");
const distAssetPaths = [...new Set([...entryDistAssetPaths, ...loadedDistAssetPaths])];

const bundleSourcePaths = [
  "src/main.jsx",
  "src/styles.css",
  "src/api/client.js",
  "src/workflow/workflowSelectionGuard.js",
  "src/ui-v2/PptAgentWorkspace.jsx",
  "src/ui-v2/PptAgentWorkspace.module.css",
  "shared/workflowDeliveryStatus.js",
  "shared/workflowVisibility.js"
];
const sourcePaths = [
  ...bundleSourcePaths,
  "dist/index.html",
  ...distAssetPaths,
  "scripts/strict-ui-e2e.mjs",
  "scripts/strict-ui-e2e.playwright.js",
  "scripts/strict-ui-e2e-evidence.mjs",
  "scripts/smoke-workflow-e2e.mjs",
  "server/index.js",
  "server/doctor.js",
  "server/workflowPptMaster.js",
  "server/workflowJobs.js",
  "server/workflowApprovals.js",
  "server/workflowCodexPptDecisions.js",
  "server/workflowCodexPptRunState.js",
  "server/workflowDelivery.js",
  "server/workflowPageEvidence.js",
  "server/workflowFinalEvidence.js",
  "docs/strict-ui-e2e-procedure.md",
  "docs/ppt-master-provider.md"
];
const sourceFiles = await hashFiles(sourcePaths);
const screenshots = await hashFiles(capture.screenshots || []);
if (screenshots.length !== 4 || screenshots.some((item) => !item.sha256 || item.size <= 0)) assertionFailures.push("screenshot-evidence");
const buildTime = (await fs.stat(distIndexPath)).mtimeMs;
const bundleSourcesNewerThanBuild = [];
for (const sourcePath of bundleSourcePaths) {
  const stat = await fs.stat(path.resolve(sourcePath));
  if (stat.mtimeMs > buildTime) bundleSourcesNewerThanBuild.push(sourcePath);
}
if (bundleSourcesNewerThanBuild.length) assertionFailures.push("bundle-source-newer-than-build");
if (screenshots.some((item) => item.mtimeMs < buildTime)) assertionFailures.push("screenshots-predate-build");
const traceFiles = await hashFiles([capture.trace].filter(Boolean));
if (traceFiles.length !== 1 || traceFiles[0].size <= 0 || traceFiles[0].mtimeMs < buildTime) assertionFailures.push("trace-evidence");

const deliveryResponse = await fetch(`${capture.baseUrl.replace(/\/+$/, "")}/api/workflow-jobs/${capture.jobId}/delivery-status`);
const delivery = await deliveryResponse.json();
const deliveryProductReady = delivery?.finalGate?.productReady === true;
const deliveryDownloadable = delivery?.finalGate?.downloadable === true;
const deliveryBlocked = delivery?.status?.level === "blocked";
if (!deliveryResponse.ok || !deliveryBlocked || deliveryProductReady || deliveryDownloadable) assertionFailures.push("live-delivery-gate");
const readyDeliveryResponse = await fetch(`${capture.baseUrl.replace(/\/+$/, "")}/api/workflow-jobs/${capture.readyJobId}/delivery-status`);
const readyDelivery = await readyDeliveryResponse.json();
const readyDeliveryProductReady = readyDelivery?.finalGate?.productReady === true;
const readyDeliveryDownloadable = readyDelivery?.finalGate?.downloadable === true;
const readyDeliveryReady = readyDelivery?.status?.level === "ready";
if (!readyDeliveryResponse.ok || !readyDeliveryReady || !readyDeliveryProductReady || !readyDeliveryDownloadable) assertionFailures.push("live-ready-delivery-gate");

const performanceEvidencePath = path.join("workspace", "delivery-evidence", "performance", "latest.json");
const performanceEvidenceRaw = await fs.readFile(performanceEvidencePath, "utf8");
const performanceEvidence = JSON.parse(performanceEvidenceRaw);
if (performanceEvidence.status !== "pass") assertionFailures.push("performance-evidence-not-pass");
const performanceScopeFiles = await hashOptionalFiles((performanceEvidence.buildFingerprint?.files || []).map((entry) => entry.path));
const finalBuildFingerprintInPerformanceScope = sha256(stableJson(performanceScopeFiles.map(({ path: filePath, sha256: fileSha256 }) => ({ path: filePath, sha256: fileSha256 }))));
const performanceMatchesFinalBuild = performanceEvidence.buildFingerprint?.sha256 === finalBuildFingerprintInPerformanceScope;
if (!performanceMatchesFinalBuild) assertionFailures.push("performance-evidence-does-not-match-final-build");

const finishedAt = new Date().toISOString();
const evidence = {
  kind: "ppt-agent-strict-dual-state-ui-e2e",
  version: 4,
  scope: "automated-latest-production-build-blocked-and-synthetic-ready-workflow-ui",
  status: assertionFailures.length ? "fail" : "dual-state-pass",
  workflowClosureStatus: { blockedFixture: "blocked", syntheticReadyFixture: "ready" },
  productDeliveryClaimed: false,
  syntheticReadyClosureValidated: true,
  startedAt: capture.capturedAt,
  finishedAt,
  baseUrl: capture.baseUrl,
  jobId: capture.jobId,
  readyJobId: capture.readyJobId,
  browser: capture.browser,
  automatedReplay: true,
  runner: capture.runner,
  flow: capture.flow,
  procedure: "docs/strict-ui-e2e-procedure.md",
  assertionFailures,
  checks: capture.checks,
  liveDeliveryGate: {
    httpStatus: deliveryResponse.status,
    productReady: deliveryProductReady,
    downloadable: deliveryDownloadable,
    status: delivery?.status?.level || "unknown"
  },
  liveReadyDeliveryGate: {
    httpStatus: readyDeliveryResponse.status,
    productReady: readyDeliveryProductReady,
    downloadable: readyDeliveryDownloadable,
    status: readyDelivery?.status?.level || "unknown",
    scope: "synthetic-control-plane-fixture"
  },
  sourceFiles,
  sourceFingerprint: sha256(stableJson(sourceFiles)),
  screenshots,
  screenshotFingerprint: sha256(stableJson(screenshots)),
  traceFiles,
  traceFingerprint: sha256(stableJson(traceFiles)),
  loadedAssets: capture.loadedAssets || [],
  expectedEntryDistAssets: entryDistAssetPaths,
  loadedDistAssets: loadedDistAssetPaths,
  missingEntryAssets,
  missingLoadedDistAssets,
  bundleSourcesNewerThanBuild,
  upstreamPerformanceEvidence: {
    path: performanceEvidencePath.replaceAll("\\", "/"),
    sha256: sha256(performanceEvidenceRaw),
    status: performanceEvidence.status,
    performanceBuildFingerprint: performanceEvidence.buildFingerprint?.sha256 || "",
    finalBuildFingerprintInPerformanceScope,
    matchesFinalBuild: performanceMatchesFinalBuild
  }
};

const stamp = finishedAt.replace(/[:.]/g, "-");
const json = `${JSON.stringify(evidence, null, 2)}\n`;
const markdown = `# Strict dual-state UI E2E\n\n- Status: ${evidence.status}\n- Automated replay: yes\n- Blocked workflow closure: blocked\n- Synthetic ready workflow closure: ready\n- Product delivery claimed: no\n- Blocked job: ${evidence.jobId}\n- Synthetic ready job: ${evidence.readyJobId}\n- Browser: ${evidence.browser.name} ${evidence.browser.version}\n- Latest source and bundle fingerprint: \`${evidence.sourceFingerprint}\`\n- Screenshot fingerprint: \`${evidence.screenshotFingerprint}\`\n- Trace fingerprint: \`${evidence.traceFingerprint}\`\n- Assertion failures: ${assertionFailures.length ? assertionFailures.join(", ") : "none"}\n\nThis evidence validates blocked delivery protection and a fully ready control-plane/download closure. The ready fixture is synthetic and is not evidence of external image-generation quality.\n`;
await fs.writeFile(path.join(root, `${stamp}.json`), json, "utf8");
await fs.writeFile(path.join(root, `${stamp}.md`), markdown, "utf8");
await fs.writeFile(path.join(root, "latest.json"), json, "utf8");
await fs.writeFile(path.join(root, "latest.md"), markdown, "utf8");
console.log(JSON.stringify({ ok: !assertionFailures.length, status: evidence.status, workflowClosureStatus: evidence.workflowClosureStatus, sourceFingerprint: evidence.sourceFingerprint, screenshotFingerprint: evidence.screenshotFingerprint }, null, 2));
if (assertionFailures.length) process.exitCode = 1;

async function hashFiles(files) {
  const results = [];
  for (const file of files) {
    const absolute = path.resolve(file);
    const buffer = await fs.readFile(absolute);
    const stat = await fs.stat(absolute);
    results.push({ path: file.replaceAll("\\", "/"), size: buffer.length, mtimeMs: stat.mtimeMs, sha256: sha256(buffer) });
  }
  return results;
}

async function hashOptionalFiles(files) {
  const results = [];
  for (const file of files) {
    const absolute = path.resolve(file);
    const buffer = await fs.readFile(absolute).catch(() => null);
    results.push({ path: file.replaceAll("\\", "/"), sha256: buffer ? sha256(buffer) : "missing-after-final-build" });
  }
  return results;
}

async function fileExists(file) {
  return fs.access(path.resolve(file)).then(() => true).catch(() => false);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
