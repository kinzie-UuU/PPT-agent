#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildDeckDesignContract,
  buildDeckStructureAudit,
  buildDeckStyleSpec,
  classifyDeckText,
  getRoleTypography,
  hasDenseTableSignals,
  inferDeckPageRole,
  inferPageNumberPolicyFromOcrHints,
  isPageMarkerText,
  isSemanticClosingText,
  isTemplatePlaceholderText,
  normalizeDeckPageRole,
  resolveVisualSampleSelection
} from "../server/workflowDeckDesignSystem.js";
import { buildDeckStyleConsistencyReport } from "../server/workflowStyleConsistency.js";
import { buildVisualTextQualityReport } from "../server/workflowVisualTextQa.js";
import {
  buildEditableVisualQaSignature,
  evaluateEditableVisualFidelity,
  isBlockingEditableVisualIssue,
  isUsableCachedPowerPointOpenability
} from "../server/workflowFinalEvidence.js";
import { verifyOutputHashes } from "../server/workflowPageEvidence.js";

const TARGETED_IDS = new Set([6, 16, 21, 26, 30, 32, 33, 34, 35, 36, 37]);
const args = new Set(process.argv.slice(2));
const targeted = args.has("--targeted");
const evidenceRoot = path.join(process.cwd(), "workspace", "delivery-evidence", targeted ? "targeted-quality" : "quality-contract-37x2");
const lifecycleStartedAt = new Date().toISOString();
await fs.mkdir(evidenceRoot, { recursive: true });
await writeLatestState({ status: "running", startedAt: lifecycleStartedAt });
try {
  await runReplay();
} catch (error) {
  await writeLatestState({ status: "fail", startedAt: lifecycleStartedAt, finishedAt: new Date().toISOString(), error: error?.stack || error?.message || String(error) });
  throw error;
}

async function runReplay() {
const scenarios = buildScenarios();
if (scenarios.length !== 37) throw new Error(`Replay contract must contain exactly 37 scenarios, received ${scenarios.length}.`);

const selected = targeted ? scenarios.filter((item) => TARGETED_IDS.has(item.id)) : scenarios;
const rounds = targeted ? 1 : 2;
const startedAt = new Date().toISOString();
const roundResults = [];
for (let round = 1; round <= rounds; round += 1) roundResults.push(await runRound(selected, round));

const normalizedRounds = roundResults.map((round) => round.results.map(({ id, name, passed, actual, error }) => ({
  id,
  name,
  passed,
  actual,
  error
})));
const deterministic = rounds === 1 || normalizedRounds.slice(1).every((value) => stableJson(value) === stableJson(normalizedRounds[0]));
const failed = roundResults.flatMap((round) => round.results.filter((result) => !result.passed));
const sourcePaths = [
  "scripts/quality-replay-37x2.mjs",
  "server/workflowDeckDesignSystem.js",
  "server/workflowStyleConsistency.js",
  "server/workflowVisualTextQa.js",
  "server/workflowFinalEvidence.js",
  "server/workflowPageEvidence.js"
];
const sourceFiles = await hashFiles(sourcePaths);
const evidence = {
  kind: targeted ? "ppt-agent-targeted-quality-regression" : "ppt-agent-rule-contract-replay-37x2",
  version: 1,
  startedAt,
  finishedAt: new Date().toISOString(),
  noExternalApi: true,
  scenarioContractCount: scenarios.length,
  selectedScenarioCount: selected.length,
  rounds,
  scenarioExecutionCount: selected.length * rounds,
  passedCount: selected.length * rounds - failed.length,
  failedCount: failed.length,
  deterministic,
  sourceFiles,
  sourceFingerprint: sha256(stableJson(sourceFiles)),
  fingerprint: sha256(stableJson(normalizedRounds[0] || [])),
  status: failed.length || !deterministic ? "fail" : "pass",
  roundResults
};

const stamp = evidence.finishedAt.replace(/[:.]/g, "-");
const jsonPath = path.join(evidenceRoot, `${stamp}.json`);
const markdownPath = path.join(evidenceRoot, `${stamp}.md`);
await fs.writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await fs.writeFile(markdownPath, renderMarkdown(evidence), "utf8");
await fs.writeFile(path.join(evidenceRoot, "latest.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(evidenceRoot, "latest.md"), renderMarkdown(evidence), "utf8");

console.log(JSON.stringify({
  ok: evidence.status === "pass",
  kind: evidence.kind,
  scenarios: evidence.selectedScenarioCount,
  rounds: evidence.rounds,
  scenarioExecutions: evidence.scenarioExecutionCount,
  deterministic: evidence.deterministic,
  fingerprint: evidence.fingerprint,
  elapsedMs: Math.round(roundResults.reduce((sum, round) => sum + round.elapsedMs, 0)),
  evidence: path.relative(process.cwd(), jsonPath)
}, null, 2));

if (evidence.status !== "pass") process.exitCode = 1;
}

async function runRound(items, round) {
  const started = performance.now();
  const results = [];
  for (const item of items) {
    const caseStarted = performance.now();
    try {
      const actual = await item.run();
      results.push({ id: item.id, name: item.name, passed: true, actual: normalize(actual), error: "", elapsedMs: roundMs(performance.now() - caseStarted) });
    } catch (error) {
      results.push({ id: item.id, name: item.name, passed: false, actual: null, error: error?.stack || error?.message || String(error), elapsedMs: roundMs(performance.now() - caseStarted) });
    }
  }
  return { round, elapsedMs: roundMs(performance.now() - started), results };
}

function buildScenarios() {
  const list = [];
  const add = (name, run) => list.push({ id: list.length + 1, name, run });

  add("role alias maps opening to cover", () => expectEqual(normalizeDeckPageRole("opening"), "cover"));
  add("unknown role falls back to content", () => expectEqual(normalizeDeckPageRole("custom-layout"), "content"));
  add("English and Chinese placeholders are rejected", () => {
    const result = { english: isTemplatePlaceholderText("Your Brand"), chinese: isTemplatePlaceholderText("请输入") };
    assert.deepEqual(result, { english: true, chinese: true });
    return result;
  });
  add("English page marker is recognized", () => expectEqual(isPageMarkerText("Page 07 / 20"), true));
  add("compact page counter is recognized", () => expectEqual(isPageMarkerText("07 / 20"), true));
  add("contact text classification is stable", () => expectEqual(classifyDeckText("https://example.com"), "contact"));
  add("numeric business data is classified", () => expectEqual(classifyDeckText("增长 25%"), "data"));
  add("uppercase brand code is classified", () => expectEqual(classifyDeckText("INOVANCE"), "brand_or_code"));
  add("Chinese closing semantics are recognized", () => expectEqual(isSemanticClosingText("感谢聆听"), true));
  add("ordinary content is not treated as closing", () => expectEqual(isSemanticClosingText("感谢团队持续创新"), false));
  add("first page is inferred as cover", () => expectEqual(inferDeckPageRole({ pageNumber: 1, title: "方案" }, { totalPages: 8 }), "cover"));
  add("agenda semantics infer agenda role", () => expectEqual(inferDeckPageRole({ pageNumber: 2, title: "目录" }, { totalPages: 8 }), "agenda"));
  add("table signals override generic content", () => expectEqual(inferDeckPageRole({ pageNumber: 3, tableCount: 1 }, { totalPages: 8 }), "table"));
  add("comparison semantics infer comparison role", () => expectEqual(inferDeckPageRole({ pageNumber: 3, title: "方案对比" }, { totalPages: 8 }), "comparison"));
  add("process semantics infer process role", () => expectEqual(inferDeckPageRole({ pageNumber: 3, title: "实施流程" }, { totalPages: 8 }), "process"));
  add("product semantics infer product role", () => expectEqual(inferDeckPageRole({ pageNumber: 3, title: "产品选品" }, { totalPages: 8 }), "product"));
  add("image-led sparse page infers visual role", () => expectEqual(inferDeckPageRole({ pageNumber: 3, imageCount: 2, textChars: 30 }, { totalPages: 8 }), "visual"));
  add("semantic last page infers closing role", () => expectEqual(inferDeckPageRole({ pageNumber: 8, ocrText: ["Thank you"] }, { totalPages: 8 }), "closing"));
  add("dense pricing evidence is detected", () => expectEqual(hasDenseTableSignals({}, "产品名称 数量 10 价格 20 合计 200 规格 A1"), true));
  add("single-page OCR does not invent page numbers", () => expectEqual(inferPageNumberPolicyFromOcrHints({ pages: [{ ocrLines: [{ text: "01 / 01" }] }] }), "none"));
  add("majority page counters select normalize policy", () => expectEqual(inferPageNumberPolicyFromOcrHints({ pages: [
    { ocrLines: [] },
    { ocrLines: [{ text: "02 / 04" }] },
    { ocrLines: [{ text: "03 / 04" }] },
    { ocrLines: [{ text: "04 / 04" }] }
  ] }), "normalize"));
  add("explicit page-number policy wins", () => expectEqual(inferPageNumberPolicyFromOcrHints({ pages: [] }, "preserve"), "preserve"));
  add("existing deck recommends rather than invents closing", () => {
    const audit = buildDeckStructureAudit([{ title: "封面" }, { title: "内容" }, { title: "总结" }, { title: "计划" }], { sourceDeck: true });
    assert.equal(audit.closingRecommended, true);
    assert.equal(audit.closingAction, "recommend-only");
    return { closingRecommended: audit.closingRecommended, closingAction: audit.closingAction };
  });
  add("brief deck plans a closing when missing", () => {
    const audit = buildDeckStructureAudit([{ title: "封面" }, { title: "内容" }, { title: "总结" }, { title: "计划" }], { sourceDeck: false });
    assert.equal(audit.closingAction, "plan-in-outline");
    return audit.closingAction;
  });
  add("representative sample avoids the cover", () => {
    const result = resolveVisualSampleSelection([
      { pageNumber: 1, title: "封面" },
      { pageNumber: 2, title: "核心方案", textChars: 100 },
      { pageNumber: 3, title: "Thank you" }
    ]);
    assert.equal(result.pageNumber, 2);
    return { pageNumber: result.pageNumber, role: result.role };
  });
  add("explicit cover sample requires opt-in", () => {
    const result = resolveVisualSampleSelection([
      { pageNumber: 1, title: "封面" },
      { pageNumber: 2, title: "核心方案", textChars: 100 },
      { pageNumber: 3, title: "Thank you" }
    ], { pageNumber: 1 });
    assert.equal(result.blocked, true);
    assert.equal(result.blockerCode, "CODEX_PPT_NON_REPRESENTATIVE_SAMPLE_REQUIRES_OPT_IN");
    return { blocked: result.blocked, code: result.blockerCode, recommended: result.recommendedPageNumber };
  });
  add("missing sample page is blocked", () => {
    const result = resolveVisualSampleSelection([{ pageNumber: 1 }, { pageNumber: 2 }], { pageNumber: 9 });
    assert.equal(result.blockerCode, "CODEX_PPT_SAMPLE_PAGE_NOT_FOUND");
    return result.blockerCode;
  });
  add("table typography remains compact", () => expectEqual(getRoleTypography("table").titlePt, [24, 32]));
  add("design contract forbids invented page numbers", () => {
    const contract = buildDeckDesignContract({ pageNumberPolicy: "none" });
    assert.match(contract.master.pageNumberRule, /Do not render slide numbers/);
    return contract.master.pageNumberPolicy;
  });
  add("style spec keeps stable master anchors", () => {
    const spec = buildDeckStyleSpec({ styleBrief: "clean premium business" });
    assert.ok(spec.variation.stableAcrossPages.includes("page-number anchor"));
    assert.deepEqual(spec.master.outerMarginPercent, [5, 7]);
    return { familyMode: spec.typography.familyMode, margins: spec.master.outerMarginPercent };
  });
  add("style QA reports insufficient data below minimum", () => {
    const report = buildDeckStyleConsistencyReport([stylePage("page_001", "content", baseMetrics())]);
    assert.equal(report.status, "insufficient-data");
    return { status: report.status, checkedPages: report.checkedPages };
  });
  add("style QA accepts a stable deck", () => {
    const report = buildDeckStyleConsistencyReport([
      stylePage("page_001", "content", baseMetrics()),
      stylePage("page_002", "content", { ...baseMetrics(), brightness: 0.51 }),
      stylePage("page_003", "content", { ...baseMetrics(), brightness: 0.49 })
    ]);
    assert.equal(report.status, "pass");
    return { status: report.status, driftCount: report.driftCount };
  });
  add("style QA catches cross-dimension drift", () => {
    const baseline = baseMetrics();
    const pages = [
      stylePage("page_001", "cover", { ...baseline, brightness: 0.82 }),
      stylePage("page_002", "visual", { ...baseline, saturationDensity: 0.78 }),
      stylePage("page_003", "table", { ...baseline, edgeDensity: 0.22 }),
      stylePage("page_004", "process", { ...baseline, textLikeScore: 0.12 }),
      stylePage("page_005", "product", { ...baseline, titleEdgeDensity: 0.19 })
    ];
    const report = buildDeckStyleConsistencyReport(pages, null, { approvedSampleMetrics: baseline, baselineSource: "approved-visual-sample" });
    const reasons = [...new Set(report.driftPages.flatMap((page) => page.reasons))].sort();
    for (const expected of ["style-brightness-drift", "style-color-drift", "style-density-drift", "style-text-density-drift", "style-title-density-drift"]) assert.ok(reasons.includes(expected));
    return { status: report.status, driftCount: report.driftCount, reasons };
  });
  add("semantic QA passes exact retained content", () => {
    const report = semanticReport({
      sourceLines: [ocrLine("Quality Assurance", 100, 34), ocrLine("Stable content retained", 260, 20)],
      visualLines: [ocrLine("Quality Assurance", 100, 34), ocrLine("Stable content retained", 260, 20)]
    });
    assert.equal(report.status, "pass");
    assert.equal(report.summary.complete, true);
    return { status: report.status, passCount: report.summary.passCount, complete: report.summary.complete };
  });
  add("semantic QA blocks placeholder and critical brand loss", () => {
    const report = semanticReport({
      sourceLines: [ocrLine("INOVANCE", 100, 34), ocrLine("Core solution", 260, 20)],
      visualLines: [ocrLine("Your Brand", 100, 34), ocrLine("Core solution", 260, 20)]
    });
    const reasons = report.pages[0].blockingReasons;
    assert.ok(reasons.includes("placeholder-text-detected"));
    assert.ok(reasons.includes("critical-brand-or-code-missing"));
    return { status: report.status, reasons: [...reasons].sort() };
  });
  add("semantic QA blocks page-number position and value drift", () => {
    const contract = buildDeckDesignContract({ pageNumberPolicy: "normalize" });
    const source = [1, 2, 3].map((pageNumber) => hintPage(pageNumber, [ocrLine(`Section ${pageNumber}`, 100, 34), ocrLine(`${String(pageNumber).padStart(2, "0")} / 03`, 800, 12, [1100, 650, 90, 24])]));
    const visual = [
      hintPage(1, [ocrLine("Section 1", 100, 34), ocrLine("01 / 03", 800, 12, [1100, 650, 90, 24])]),
      hintPage(2, [ocrLine("Section 2", 100, 34), ocrLine("03 / 03", 800, 12, [100, 100, 90, 24])]),
      hintPage(3, [ocrLine("Section 3", 100, 34), ocrLine("03 / 03", 800, 12, [1100, 650, 90, 24])])
    ];
    const report = buildVisualTextQualityReport({ sourceHints: { pages: source }, visualHints: { pages: visual }, contract, expectedPageIds: ["page_001", "page_002", "page_003"] });
    assert.equal(report.summary.pageNumberPositionConsistent, false);
    assert.ok(report.pages[1].blockingReasons.includes("page-number-value-mismatch"));
    assert.ok(report.pages.some((page) => page.blockingReasons.includes("inconsistent-page-number-position")));
    return { status: report.status, positionConsistent: report.summary.pageNumberPositionConsistent, blocked: report.summary.blockedPageIds };
  });
  add("editable visual fidelity and complete output hashes enforce critical gates", async () => {
    const unavailable = evaluateEditableVisualFidelity({ available: false });
    const critical = evaluateEditableVisualFidelity({ available: true, rawScore: 0.8, targetEdgeCount: 200, edgeOverlap: 0.2, edgeRetention: 0.4 });
    const tiled = evaluateEditableVisualFidelity({ available: true, rawScore: 0.96, contentTileCount: 12, weakContentTileRatio: 0.25, lowContentTileScore: 0.6 });
    assert.deepEqual(unavailable, ["visual-comparison-unavailable"]);
    assert.ok(critical.includes("preview-visual-similarity-critical"));
    assert.ok(critical.includes("preview-structure-loss"));
    assert.ok(tiled.includes("preview-structure-loss"));
    assert.equal(isBlockingEditableVisualIssue("preview-structure-loss"), true);
    const signature = buildEditableVisualQaSignature({ pageId: "page_001", targetSize: 10, previewSize: 9, visualSimilarity: { rawScore: 0.96, score: 0.95, edgeOverlap: 0.8, weakContentTileRatio: 0 } });
    assert.equal(signature, buildEditableVisualQaSignature({ pageId: "page_001", targetSize: 10, previewSize: 9, visualSimilarity: { rawScore: 0.96, score: 0.95, edgeOverlap: 0.8, weakContentTileRatio: 0 } }));
    const packagePath = path.join(process.cwd(), "package.json");
    const packageHash = sha256(await fs.readFile(packagePath));
    const outputEvidence = Object.fromEntries([
      "page_manifest", "imagegen_jobs", "page_pptx", "preview", "contact_sheet", "validation", "page_result"
    ].map((key) => [key, { path: packagePath, exists: true }]));
    const hashResults = await verifyOutputHashes({ page_manifest: packageHash }, outputEvidence);
    assert.equal(hashResults.length, 7);
    assert.equal(hashResults.filter((item) => item.missing).length, 6);
    assert.equal(hashResults.every((item) => item.matched), false);
    const finalFile = { exists: true, size: 10 };
    const final = { size: 10, sha256: "final-hash" };
    assert.equal(isUsableCachedPowerPointOpenability({ available: true, openable: true }, finalFile, final, "final-hash"), false, "A legacy cache without finalSha256 must not be reused.");
    assert.equal(isUsableCachedPowerPointOpenability({ available: true, openable: true, finalSha256: "old-hash" }, finalFile, final, "final-hash"), false, "A cache for another final file must not be reused.");
    assert.equal(isUsableCachedPowerPointOpenability({ available: true, openable: true, finalSha256: "final-hash" }, finalFile, final, "final-hash"), true, "A cache bound to the current final hash may be reused.");
    return { unavailable, critical: [...critical].sort(), tiled: [...tiled].sort(), signature, missingHashes: hashResults.filter((item) => item.missing).map((item) => item.key), openabilityCacheBoundToHash: true };
  });
  return list;
}

function semanticReport({ sourceLines, visualLines }) {
  return buildVisualTextQualityReport({
    sourceHints: { pages: [hintPage(1, sourceLines)] },
    visualHints: { pages: [hintPage(1, visualLines)] },
    expectedPageIds: ["page_001"]
  });
}

function hintPage(pageNumber, ocrLines) {
  return { pageId: `page_${String(pageNumber).padStart(3, "0")}`, pageNumber, imageSha256: `sha-${pageNumber}`, ocrLines };
}

function ocrLine(text, y = 100, fontPt = 24, box = null) {
  return { text, confidence: 1, low_confidence: false, mojibake_suspect: false, box_px: box || [100, y, 700, Math.max(24, fontPt * 1.3)], font_pt_if_cjk: fontPt };
}

function baseMetrics() {
  return { brightness: 0.5, saturationDensity: 0.3, hueCoverage: 0.4, hueHistogram: [0.8, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], dominantHue: 0, edgeDensity: 0.08, textLikeScore: 0.04, titleEdgeDensity: 0.06 };
}

function stylePage(pageId, role, metrics) {
  return { pageId, pageNumber: Number(pageId.slice(-3)), role, visualQa: { status: "pass", full: metrics, titleArea: { edgeDensity: metrics.titleEdgeDensity } } };
}

function expectEqual(actual, expected) {
  assert.deepEqual(actual, expected);
  return actual;
}

function normalize(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function stableJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function renderMarkdown(evidence) {
  const failures = evidence.roundResults.flatMap((round) => round.results.filter((result) => !result.passed).map((result) => `- Round ${round.round}, #${result.id} ${result.name}: ${result.error}`));
  return `# ${evidence.kind}\n\n- Status: ${evidence.status}\n- Scenarios: ${evidence.selectedScenarioCount}/${evidence.scenarioContractCount}\n- Rounds: ${evidence.rounds}\n- Scenario executions: ${evidence.scenarioExecutionCount}\n- Passed: ${evidence.passedCount}\n- Failed: ${evidence.failedCount}\n- Deterministic: ${evidence.deterministic}\n- External API calls: 0\n- Fingerprint: \`${evidence.fingerprint}\`\n\n## Failures\n\n${failures.length ? failures.join("\n") : "None."}\n`;
}

async function hashFiles(files) {
  const results = [];
  for (const file of files) results.push({ path: file, sha256: sha256(await fs.readFile(path.resolve(file))) });
  return results;
}

async function writeLatestState(state) {
  const payload = {
    kind: targeted ? "ppt-agent-targeted-quality-regression" : "ppt-agent-rule-contract-replay-37x2",
    version: 2,
    ...state
  };
  await fs.writeFile(path.join(evidenceRoot, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(evidenceRoot, "latest.md"), `# ${payload.kind}\n\n- Status: ${payload.status}\n- Error: ${payload.error || "none"}\n`, "utf8");
}
