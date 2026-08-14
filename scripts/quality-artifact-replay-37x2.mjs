#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeGeneratedImage } from "../server/imageQa.js";
import { inspectEditablePptx, inspectPowerPointOpenability } from "../server/pptxEditability.js";
import { buildDeckDesignContract } from "../server/workflowDeckDesignSystem.js";
import { buildDeckStyleConsistencyReport } from "../server/workflowStyleConsistency.js";
import { buildVisualTextQualityReport } from "../server/workflowVisualTextQa.js";

const execFileAsync = promisify(execFile);
const workerMode = process.argv.includes("--worker");
const corpus = [
  { jobId: "workflow_20260629-021146Z_619d82", pages: 20, semantic: false, fixtureType: "real-user-workflow" },
  { jobId: "workflow_20260624-191529Z_b783f0", pages: 15, semantic: false, fixtureType: "real-user-workflow" },
  { jobId: "workflow_20260812-065323Z_eddcbe", pages: 1, semantic: true, fixtureType: "synthetic-api-transition" },
  { jobId: "workflow_20260812-060948Z_d6a8b1", pages: 1, semantic: true, fixtureType: "synthetic-api-transition" }
];
const semanticFixtureJobId = "workflow_20260804-094558Z_162643";
const evidenceRoot = path.join(process.cwd(), "workspace", "delivery-evidence", "quality-replay-37x2");

if (workerMode) {
  process.stdout.write(JSON.stringify(await runArtifactRound()));
} else {
  await runReplayWithLifecycle();
}

async function runReplayWithLifecycle() {
  const startedAt = new Date().toISOString();
  await fs.mkdir(evidenceRoot, { recursive: true });
  await writeLatestState({ status: "running", startedAt });
  try {
    await runReplay(startedAt);
  } catch (error) {
    await writeLatestState({ status: "fail", startedAt, finishedAt: new Date().toISOString(), error: error?.stack || error?.message || String(error) });
    throw error;
  }
}

async function runReplay(startedAt) {
  const sourceFiles = [
    "scripts/quality-artifact-replay-37x2.mjs",
    "server/imageQa.js",
    "server/pptxEditability.js",
    "server/workflowDeckDesignSystem.js",
    "server/workflowStyleConsistency.js",
    "server/workflowVisualTextQa.js"
  ];
  const sourceHashes = await hashFiles(sourceFiles);
  const rounds = [];
  for (let round = 1; round <= 2; round += 1) {
    const started = performance.now();
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.resolve(process.argv[1]), "--worker"], {
      cwd: process.cwd(),
      env: { ...process.env, PPT_ARTIFACT_REPLAY_ROUND: String(round) },
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    if (String(stderr || "").trim()) throw new Error(`Artifact replay worker ${round} wrote to stderr: ${stderr}`);
    rounds.push({ round, elapsedMs: roundMs(performance.now() - started), result: JSON.parse(stdout) });
  }

  const normalizedRounds = rounds.map(({ result }) => result);
  const deterministic = stableJson(normalizedRounds[0]) === stableJson(normalizedRounds[1]);
  const first = normalizedRounds[0];
  const integrityPassed = first.pageCount === 37
    && first.uniquePageCount === 37
    && first.missingFiles.length === 0
    && first.hashMismatches.length === 0
    && first.corpusSemanticReplays.every((replay) => replay.matchesStoredEvidence === true)
    && first.externalSemanticRegression.matchesStoredEvidence === true;
  const qualityRegressionPassed = integrityPassed && deterministic;
  const artifactAcceptanceReady = qualityRegressionPassed
    && first.detectorDisposition.pixelWarnings === 0
    && first.detectorDisposition.styleReviewDecks === 0
    && first.detectorDisposition.semanticStatus === "pass"
    && first.coverage.corpusSemanticPages === 37
    && first.coverage.editablePages === 37
    && first.coverage.openablePages === 37;
  const evidence = {
    kind: "ppt-agent-stored-artifact-quality-replay-37x2",
    version: 3,
    scope: "real-local-artifact-regression-replay; artifact acceptance is reported separately",
    startedAt,
    finishedAt: new Date().toISOString(),
    status: qualityRegressionPassed ? (artifactAcceptanceReady ? "pass" : "regression-pass-artifact-blocked") : "fail",
    qualityRegression: {
      status: qualityRegressionPassed ? "pass" : "fail",
      meaning: "The same 37 stored pages (35 real workflow pages and 2 synthetic API transition pages) were evaluated in two fresh processes and produced identical integrity and detector outcomes."
    },
    artifactAcceptance: {
      status: artifactAcceptanceReady ? "pass" : "fail",
      ready: artifactAcceptanceReady,
      meaning: "Historical artifacts are deliverable only when visual, semantic, editable and openability checks all pass."
    },
    containsSyntheticFixtures: true,
    realPageCount: 35,
    syntheticPageCount: 2,
    externalApiCalls: 0,
    corpusPageCount: 37,
    rounds: 2,
    pageEvaluationCount: 74,
    freshProcessPerRound: true,
    deterministic,
    sourceFiles: sourceHashes,
    sourceFingerprint: sha256(stableJson(sourceHashes)),
    corpus,
    performanceEvidenceJobId: semanticFixtureJobId,
    corpusFingerprint: first.corpusFingerprint,
    detectorDisposition: first.detectorDisposition,
    corpusSemanticReplays: first.corpusSemanticReplays,
    externalSemanticRegression: first.externalSemanticRegression,
    coverage: first.coverage,
    integrity: {
      passed: integrityPassed,
      uniquePageCount: first.uniquePageCount,
      missingFiles: first.missingFiles,
      hashMismatches: first.hashMismatches
    },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    roundResults: rounds.map(({ round, elapsedMs, result }) => ({
      round,
      elapsedMs,
      pageCount: result.pageCount,
      corpusFingerprint: result.corpusFingerprint,
      outputFingerprint: sha256(stableJson(result))
    }))
  };

  const stamp = evidence.finishedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(evidenceRoot, `${stamp}.json`);
  const markdownPath = path.join(evidenceRoot, `${stamp}.md`);
  const markdown = renderMarkdown(evidence);
  await fs.writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, markdown, "utf8");
  await fs.writeFile(path.join(evidenceRoot, "latest.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(evidenceRoot, "latest.md"), markdown, "utf8");

  console.log(JSON.stringify({
    ok: evidence.qualityRegression.status === "pass",
    kind: evidence.kind,
    pages: evidence.corpusPageCount,
    rounds: evidence.rounds,
    pageEvaluations: evidence.pageEvaluationCount,
    deterministic,
    corpusFingerprint: evidence.corpusFingerprint,
    detectorDisposition: evidence.detectorDisposition,
    evidence: path.relative(process.cwd(), jsonPath)
  }, null, 2));
  if (evidence.qualityRegression.status !== "pass") process.exitCode = 1;
}

async function runArtifactRound() {
  const pages = [];
  const missingFiles = [];
  const hashMismatches = [];
  const decks = [];
  let editablePages = 0;
  let openablePages = 0;
  const corpusSemanticReplays = [];

  for (const fixture of corpus) {
    const statePath = path.join(process.cwd(), "workspace", "jobs", fixture.jobId, "state.json");
    const state = await readJson(statePath);
    const renderedPages = Array.isArray(state.artifacts?.renderedPages) ? state.artifacts.renderedPages : [];
    const visualImages = Array.isArray(state.artifacts?.visualImages) ? state.artifacts.visualImages : [];
    const outline = state.artifacts?.codexPptOutline?.path ? await readJson(state.artifacts.codexPptOutline.path) : {};
    assert.ok(renderedPages.length >= fixture.pages, `${fixture.jobId} rendered pages are incomplete.`);
    assert.ok(visualImages.length >= fixture.pages, `${fixture.jobId} visual pages are incomplete.`);
    const deckPages = [];

    for (let index = 0; index < fixture.pages; index += 1) {
      const pageId = `page_${String(index + 1).padStart(3, "0")}`;
      const source = renderedPages.find((item) => item.pageId === pageId || item.pageNumber === index + 1);
      const visual = visualImages.find((item) => item.pageId === pageId || item.pageNumber === index + 1);
      for (const [kind, artifact] of [["source", source], ["visual", visual]]) {
        if (!artifact?.path || !(await fileExists(artifact.path))) missingFiles.push(`${fixture.jobId}:${pageId}:${kind}`);
      }
      if (!source?.path || !visual?.path || !(await fileExists(source.path)) || !(await fileExists(visual.path))) continue;
      const [sourceStat, visualStat, sourceHash, visualHash, visualQa] = await Promise.all([
        fs.stat(source.path),
        fs.stat(visual.path),
        hashFile(source.path),
        hashFile(visual.path),
        analyzeGeneratedImage(visual.path)
      ]);
      if (visual.sha256 && visual.sha256 !== visualHash) hashMismatches.push(`${fixture.jobId}:${pageId}:visual`);
      const outlineStep = Array.isArray(outline.layoutSequence) ? outline.layoutSequence[index] : null;
      const record = {
        fixtureId: `${fixture.jobId}:${pageId}`,
        jobId: fixture.jobId,
        pageId,
        pageNumber: index + 1,
        role: String(outlineStep?.layout || "content"),
        source: { sha256: sourceHash, size: sourceStat.size, width: Number(source.width || 0), height: Number(source.height || 0) },
        visual: { sha256: visualHash, recordedSha256: visual.sha256 || "", size: visualStat.size, width: visualQa.width, height: visualQa.height },
        pixelQa: compactPixelQa(visualQa)
      };
      pages.push(record);
      deckPages.push({ pageId, pageNumber: index + 1, role: record.role, visualQa });
    }

    const style = buildDeckStyleConsistencyReport(deckPages);
    const finalPptxPath = state.artifacts?.editableFinal?.path || "";
    const [editability, openability, finalPptxSha256] = finalPptxPath && await fileExists(finalPptxPath)
      ? await Promise.all([
          inspectEditablePptx(finalPptxPath),
          inspectPowerPointOpenability(finalPptxPath, { timeoutMs: 120000 }),
          hashFile(finalPptxPath)
        ])
      : [{ editable: false, slideCount: 0 }, { openable: false, slideCount: 0 }, ""];
    const selectedEditablePages = editability.editable === true && editability.slideCount >= fixture.pages ? fixture.pages : 0;
    const selectedOpenablePages = openability.openable === true && openability.slideCount >= fixture.pages ? fixture.pages : 0;
    editablePages += selectedEditablePages;
    openablePages += selectedOpenablePages;
    decks.push({
      jobId: fixture.jobId,
      fixtureType: fixture.fixtureType,
      pageCount: deckPages.length,
      semanticCoverage: fixture.semantic ? "source-and-visual-ocr" : "legacy-no-visual-ocr",
      editableCoverage: selectedEditablePages,
      openableCoverage: selectedOpenablePages,
      finalPptx: {
        sha256: finalPptxSha256,
        slideCount: editability.slideCount,
        editable: editability.editable === true,
        openable: openability.openable === true,
        rasterOnlySlides: Number(editability.rasterOnlySlides || 0)
      },
      style: compactStyleReport(style)
    });

    if (fixture.semantic) {
      corpusSemanticReplays.push({
        fixtureJobId: fixture.jobId,
        fixturePageCount: fixture.pages,
        ...await replaySemanticEvidence(state, outline)
      });
    }
  }

  const semanticState = await readJson(path.join(process.cwd(), "workspace", "jobs", semanticFixtureJobId, "state.json"));
  const semanticOutline = semanticState.artifacts?.codexPptOutline?.path ? await readJson(semanticState.artifacts.codexPptOutline.path) : {};
  const externalSemanticRegression = await replaySemanticEvidence(semanticState, semanticOutline);
  externalSemanticRegression.fixtureJobId = semanticFixtureJobId;

  const fixtureIds = pages.map((page) => page.fixtureId);
  const corpusFingerprint = sha256(stableJson(pages.map((page) => ({
    fixtureId: page.fixtureId,
    sourceSha256: page.source.sha256,
    visualSha256: page.visual.sha256
  }))));
  return {
    pageCount: pages.length,
    uniquePageCount: new Set(fixtureIds).size,
    missingFiles,
    hashMismatches,
    corpusFingerprint,
    detectorDisposition: {
      pixelWarnings: pages.filter((page) => page.pixelQa.status === "warn").length,
      pixelPasses: pages.filter((page) => page.pixelQa.status === "pass").length,
      styleReviewDecks: decks.filter((deck) => deck.style.status === "review").length,
      semanticStatus: externalSemanticRegression.recomputed?.status || "unavailable",
      note: "Replay pass means the stored artifacts, integrity checks and quality detectors are reproducible; it does not relabel known visual findings as acceptable."
    },
    corpusSemanticReplays,
    externalSemanticRegression,
    coverage: {
      visualIntegrityPages: pages.length,
      pixelQaPages: pages.length,
      styleQaPages: pages.length,
      corpusSemanticPages: corpusSemanticReplays.reduce((total, replay) => total + (replay.available ? Number(replay.fixturePageCount || 0) : 0), 0),
      externalSemanticRegressionPages: externalSemanticRegression.available ? Number(externalSemanticRegression.recomputed?.pageCount || 0) : 0,
      editablePages,
      openablePages
    },
    decks,
    pages
  };
}

async function replaySemanticEvidence(state, outline) {
  const sourcePath = state.artifacts?.ocrTextHints?.path;
  const visualPath = state.artifacts?.visualOcrTextHints?.path;
  const storedPath = state.artifacts?.visualTextQuality?.path;
  if (!sourcePath || !visualPath || !storedPath) return { available: false, matchesStoredEvidence: false, reason: "required OCR or stored semantic evidence is missing" };
  const [sourceHints, visualHints, stored] = await Promise.all([readJson(sourcePath), readJson(visualPath), readJson(storedPath)]);
  const expectedPageIds = Array.from({ length: Number(state.artifacts?.sourceMeta?.pageCount || 0) }, (_item, index) => `page_${String(index + 1).padStart(3, "0")}`);
  const contract = buildDeckDesignContract({ pageNumberPolicy: stored.contract?.pageNumberPolicy || "none" });
  if (stored.contract?.typographyFamilyMode) contract.typography.familyMode = stored.contract.typographyFamilyMode;
  const recomputed = buildVisualTextQualityReport({ sourceHints, visualHints, outline, contract, expectedPageIds });
  const current = compactSemanticReport(recomputed);
  const baseline = compactSemanticReport(stored);
  return {
    available: true,
    matchesStoredEvidence: stableJson(current) === stableJson(baseline),
    sourceOcrSha256: await hashFile(sourcePath),
    visualOcrSha256: await hashFile(visualPath),
    storedEvidenceSha256: await hashFile(storedPath),
    recomputed: current,
    stored: baseline
  };
}

function compactPixelQa(qa) {
  return {
    status: qa.status,
    risks: [...qa.risks].sort(),
    width: qa.width,
    height: qa.height,
    full: qa.full,
    textSafe: qa.textSafe,
    titleArea: qa.titleArea
  };
}

function compactStyleReport(report) {
  return {
    status: report.status,
    checkedPages: report.checkedPages,
    driftCount: report.driftCount,
    driftPages: (report.driftPages || []).map((page) => ({ pageId: page.pageId, role: page.role, reasons: [...page.reasons].sort(), deltas: page.deltas }))
  };
}

function compactSemanticReport(report) {
  const summary = report?.summary || {};
  return {
    status: report?.status || "",
    pageCount: summary.pageCount || 0,
    expectedPageCount: summary.expectedPageCount || 0,
    complete: summary.complete === true,
    passCount: summary.passCount || 0,
    reviewCount: summary.reviewCount || 0,
    blockedCount: summary.blockedCount || 0,
    blockedPageIds: summary.blockedPageIds || [],
    placeholderPageIds: summary.placeholderPageIds || [],
    pageNumberPageIds: summary.pageNumberPageIds || [],
    pageNumberFormats: summary.pageNumberFormats || [],
    pageNumberConsistent: summary.pageNumberConsistent ?? null,
    pageNumberPositionConsistent: summary.pageNumberPositionConsistent ?? null,
    sourceHasSemanticClosing: summary.sourceHasSemanticClosing ?? null,
    visualHasSemanticClosing: summary.visualHasSemanticClosing ?? null,
    closingRecommended: summary.closingRecommended ?? null,
    closingAction: summary.closingAction || "",
    pageBlockingReasons: (report?.pages || []).map((page) => ({ pageId: page.pageId, reasons: [...(page.blockingReasons || [])].sort() }))
  };
}

async function hashFiles(files) {
  return Promise.all(files.map(async (file) => ({ path: file, sha256: await hashFile(path.resolve(file)) })));
}

async function hashFile(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function roundMs(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function renderMarkdown(evidence) {
  return `# PPT Agent stored artifact quality replay 37 x 2\n\n- Overall status: ${evidence.status}\n- Software quality regression: ${evidence.qualityRegression.status}\n- Historical artifact acceptance: ${evidence.artifactAcceptance.status}\n- Scope: ${evidence.scope}\n- Corpus composition: ${evidence.realPageCount} real workflow pages + ${evidence.syntheticPageCount} synthetic API transition pages\n- External API calls: 0\n- Corpus pages: ${evidence.corpusPageCount}\n- Fresh process rounds: ${evidence.rounds}\n- Page evaluations: ${evidence.pageEvaluationCount}\n- Deterministic: ${evidence.deterministic}\n- Corpus fingerprint: \`${evidence.corpusFingerprint}\`\n- Pixel warnings retained as findings: ${evidence.detectorDisposition.pixelWarnings}\n- Style review decks retained as findings: ${evidence.detectorDisposition.styleReviewDecks}\n- External semantic detector status: ${evidence.detectorDisposition.semanticStatus}\n- Corpus semantic evidence: ${evidence.coverage.corpusSemanticPages}/37\n- External semantic regression: ${evidence.coverage.externalSemanticRegressionPages} pages, matches stored evidence: ${evidence.externalSemanticRegression.matchesStoredEvidence}\n- Editable coverage: ${evidence.coverage.editablePages}/37\n- Openable coverage: ${evidence.coverage.openablePages}/37\n\nA regression pass proves that stored page artifacts and detector outcomes are intact and reproducible. Artifact acceptance remains failed while any visual finding or corpus semantic coverage gap remains.\n`;
}

async function writeLatestState(state) {
  const payload = { kind: "ppt-agent-stored-artifact-quality-replay-37x2", version: 4, ...state };
  await fs.writeFile(path.join(evidenceRoot, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(evidenceRoot, "latest.md"), `# PPT Agent stored artifact quality replay 37 x 2\n\n- Status: ${payload.status}\n- Error: ${payload.error || "none"}\n`, "utf8");
}
