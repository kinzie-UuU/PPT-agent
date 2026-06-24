#!/usr/bin/env node
import "dotenv/config";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";

const DEFAULT_WORKFLOW_ROOT = firstExistingPath([
  process.env.PPT_WORKFLOW_ROOT,
  process.env.WORKFLOW_ROOT,
  "E:\\PPT\u5de5\u5177\\workspace\\jobs",
  "E:\\PPT工具\\workspace\\jobs",
  path.join(process.cwd(), "workspace", "jobs")
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const jobId = requireArg(args, "job-id");
  const agentId = String(args["agent-id"] || args.agentId || "worker-001").trim();
  const pages = parsePages(args.pages || args.page || "");
  const workflowRoot = path.resolve(String(args["workflow-root"] || args.workflowRoot || DEFAULT_WORKFLOW_ROOT));
  const jobRoot = path.join(workflowRoot, jobId);
  const state = await readJson(path.join(jobRoot, "state.json"));
  const runPointer = await readJson(path.join(jobRoot, "editable-run", "editable_run_pointer.json"));
  const runDir = path.resolve(runPointer.runDir || state.artifacts?.editableRun?.path || "");
  if (!fsSync.existsSync(runDir)) throw new Error(`Editable run not found: ${runDir}`);

  const textHintsPath = state.artifacts?.ocrTextHints?.path || "";
  const textHints = textHintsPath && fsSync.existsSync(textHintsPath) ? await readJson(textHintsPath) : null;
  const promptRecords = Array.isArray(state.artifacts?.editableWorkerPrompts) ? state.artifacts.editableWorkerPrompts : [];
  const taskRecords = Array.isArray(state.artifacts?.editableWorkerTasks) ? state.artifacts.editableWorkerTasks : [];
  const allPageIds = discoverPageIds(runDir).filter((pageId) => !pages.length || pages.includes(pageId));
  if (!allPageIds.length) throw new Error("No page directories found for selected pages.");

  const outDir = path.resolve(args.out || path.join(jobRoot, "worker-briefs"));
  await fs.mkdir(outDir, { recursive: true });

  const briefs = [];
  for (const pageId of allPageIds) {
    const pageDir = path.join(runDir, "pages", pageId);
    const pageRequest = await readJson(path.join(pageDir, "page_request.json"));
    const promptFile = findPromptFile({ pageId, pageDir, promptRecords });
    const promptSize = fsSync.existsSync(promptFile) ? fsSync.statSync(promptFile).size : 0;
    const ocrPage = findOcrPage(textHints, pageId);
    const task = taskRecords.find((item) => item.pageId === pageId) || null;
    const brief = buildBrief({
      jobId,
      jobRoot,
      runDir,
      pageId,
      pageDir,
      pageRequest,
      promptFile,
      promptSize,
      ocrPage,
      task,
      agentId
    });
    const pageOutDir = path.join(outDir, pageId);
    await fs.mkdir(pageOutDir, { recursive: true });
    const jsonPath = path.join(pageOutDir, "worker-brief.json");
    const mdPath = path.join(pageOutDir, "worker-brief.md");
    await writeJson(jsonPath, brief);
    await fs.writeFile(mdPath, renderBriefMarkdown(brief), "utf8");
    briefs.push({
      pageId,
      pageDir,
      sourceImage: brief.paths.sourceImage,
      promptFile,
      ocrLineCount: brief.ocr.lineCount,
      taskStatus: task?.status || "unknown",
      jsonPath,
      markdownPath: mdPath
    });
  }

  const index = {
    version: 1,
    kind: "page-worker-brief-index",
    jobId,
    jobRoot,
    runDir,
    outDir,
    pageCount: briefs.length,
    briefs,
    createdAt: new Date().toISOString()
  };
  await writeJson(path.join(outDir, "index.json"), index);
  await fs.writeFile(path.join(outDir, "README.md"), renderIndexMarkdown(index), "utf8");
  console.log(JSON.stringify(index, null, 2));
}

function buildBrief({ jobId, jobRoot, runDir, pageId, pageDir, pageRequest, promptFile, promptSize, ocrPage, task, agentId }) {
  const sourceImage = path.join(pageDir, "source.png");
  const visualAssetSpec = path.join(pageDir, "visual-asset-jobs.json");
  const rebuildSpec = path.join(pageDir, "page-rebuild-spec.json");
  return {
    version: 1,
    kind: "page-worker-brief",
    jobId,
    pageId,
    status: task?.status || "unknown",
    ownership: {
      pageDir,
      allowedWriteScope: pageRequest.allowed_write_scope,
      forbiddenPaths: pageRequest.forbidden_paths || [],
      parentMustNotWriteArtifacts: [
        "manifest.json",
        "page.pptx",
        "preview.png",
        "split_assets_contact.png",
        "validation.json",
        "page_result.json"
      ]
    },
    paths: {
      jobRoot,
      runDir,
      pageDir,
      sourceImage,
      pageRequest: path.join(pageDir, "page_request.json"),
      workerPrompt: promptFile,
      visualAssetSpec,
      rebuildSpec,
      outputArtifacts: pageRequest.required_outputs || {}
    },
    source: {
      width: pageRequest.source_size_px?.width || null,
      height: pageRequest.source_size_px?.height || null,
      slide: pageRequest.slide || null,
      contentBox: pageRequest.content_box || null,
      imageBackend: pageRequest.image_backend || null
    },
    ocr: {
      backend: ocrPage?.backend || "",
      lineCount: ocrPage?.lineCount || ocrPage?.ocrLines?.length || 0,
      lowConfidenceCount: ocrPage?.lowConfidenceCount || 0,
      requiredText: ocrPage?.requiredText || [],
      lines: (ocrPage?.ocrLines || []).map((line) => ({
        id: line.id,
        text: line.text,
        confidence: line.confidence,
        lowConfidence: Boolean(line.low_confidence),
        box_px: line.box_px,
        polygon_px: line.polygon_px,
        font_pt_if_cjk: line.font_pt_if_cjk
      }))
    },
    commands: {
      claimOnlyAfterRealWorkerSpawned: `npm.cmd run worker:once -- --job-id ${jobId} --agent-id ${agentId} --page ${pageId} --claim-only`,
      runPipelineAfterSpecReady: `npm.cmd run worker:once -- --job-id ${jobId} --agent-id ${agentId} --page ${pageId} --command "npm.cmd run lab:page-pipeline"`,
      visualAssetsHelper: `npm.cmd run lab:visual-assets -- --page-dir "${pageDir}" --spec "${visualAssetSpec}"`,
      assemblePage: `npm.cmd run lab:assemble-page -- --page-dir "${pageDir}" --spec "${rebuildSpec}"`,
      validatePage: `python -m editppt.cli page validate "${pageDir}" --report validation.json`
    },
    requiredWorkerActions: [
      "Read workerPrompt, page_request.json, source.png, OCR lines, manifest-schema.md, page-decision-tree.md, and cli-helper.md.",
      "Decide background strategy before using OCR text hints for layout.",
      "Separate any non-text foreground visual objects through serial editppt image edit/import/process-sheet calls; do not use source.png crops.",
      "Write visual-asset-jobs.json only if image assets are needed.",
      "Write page-rebuild-spec.json in pageDir after object decisions are complete.",
      "Run lab:page-pipeline or equivalent page build/contact-sheet/validate commands inside the worker session.",
      "Return only paths to required page artifacts; parent/runner then records the page."
    ],
    specSkeleton: buildSpecSkeleton(pageRequest, ocrPage),
    diagnostics: {
      workerPromptSize: promptSize,
      sourceImageExists: fsSync.existsSync(sourceImage),
      pageRequestExists: fsSync.existsSync(path.join(pageDir, "page_request.json")),
      ocrAvailable: Boolean(ocrPage)
    },
    createdAt: new Date().toISOString()
  };
}

function buildSpecSkeleton(pageRequest, ocrPage) {
  const width = pageRequest.source_size_px?.width || 1280;
  const height = pageRequest.source_size_px?.height || 720;
  return {
    schema_version: 1,
    strategy: "real-page-worker-rebuild",
    page_strategy: "real-page-worker-rebuild",
    text_inventory: (ocrPage?.ocrLines || []).map((line) => ({
      id: line.id,
      text: line.text,
      decision: "native-text-from-worker-verified-ocr"
    })),
    visual_inventory: [],
    background_strategy: {
      mode: "",
      source_consistency_contract: "",
      removed_foreground: [],
      comparison_note: ""
    },
    quality_checks: {
      font_size_calibrated: false,
      visual_inventory_matched: false,
      background_strategy_checked: false,
      shape_corner_geometry_checked: false
    },
    required_text: ocrPage?.requiredText || [],
    text_boxes: (ocrPage?.ocrLines || []).map((line, index) => ({
      id: line.id || `text_${index + 1}`,
      text: line.text || "",
      box_px: line.box_px || [0, 0, width, Math.max(1, Math.round(height * 0.08))],
      font_size: line.font_pt_if_cjk || 18,
      font_size_source: "ocr-estimated-worker-must-verify",
      font_face: "Microsoft YaHei",
      color: "#111111",
      wrap: true,
      fit_text: true,
      z_index: 100 + index
    })),
    shapes: [],
    images: [],
    asset_provenance: [],
    notes: "This skeleton is a brief aid outside the page directory. The real page worker must verify source.png and write page-rebuild-spec.json in pageDir."
  };
}

function renderBriefMarkdown(brief) {
  const lines = [
    `# Worker Brief: ${brief.pageId}`,
    "",
    "## Source",
    "",
    `![source](${brief.paths.sourceImage})`,
    "",
    `- Job: \`${brief.jobId}\``,
    `- Page dir: \`${brief.paths.pageDir}\``,
    `- Source image: \`${brief.paths.sourceImage}\``,
    `- Worker prompt: \`${brief.paths.workerPrompt}\``,
    `- OCR lines: ${brief.ocr.lineCount}`,
    `- Low-confidence OCR lines: ${brief.ocr.lowConfidenceCount}`,
    "",
    "## Required Boundary",
    "",
    "The worker owns only the page directory. The parent/workflow must not write page artifacts.",
    "",
    "Forbidden parent-authored artifacts:",
    ...brief.ownership.parentMustNotWriteArtifacts.map((name) => `- \`${name}\``),
    "",
    "## Commands",
    "",
    "Use the pipeline command after the real worker has authored `page-rebuild-spec.json`:",
    "",
    "```powershell",
    brief.commands.runPipelineAfterSpecReady,
    "```",
    "",
    "Advanced helper commands:",
    "",
    "```powershell",
    brief.commands.visualAssetsHelper,
    brief.commands.assemblePage,
    "```",
    "",
    "## OCR Lines",
    "",
    ...brief.ocr.lines.map((line) => `- ${line.id}: ${JSON.stringify(line.text)} box=${JSON.stringify(line.box_px)} conf=${line.confidence}`),
    "",
    "## Required Worker Actions",
    "",
    ...brief.requiredWorkerActions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## Spec Skeleton",
    "",
    "This skeleton is only guidance. Verify it against the source image before writing `page-rebuild-spec.json`.",
    "",
    "```json",
    JSON.stringify(brief.specSkeleton, null, 2),
    "```"
  ];
  return `${lines.join("\n")}\n`;
}

function renderIndexMarkdown(index) {
  const lines = [
    `# Worker Briefs: ${index.jobId}`,
    "",
    `- Run dir: \`${index.runDir}\``,
    `- Brief count: ${index.pageCount}`,
    "",
    "| Page | Status | OCR | Brief |",
    "| --- | --- | ---: | --- |",
    ...index.briefs.map((brief) => `| ${brief.pageId} | ${brief.taskStatus} | ${brief.ocrLineCount} | [worker-brief.md](${brief.markdownPath}) |`)
  ];
  return `${lines.join("\n")}\n`;
}

function discoverPageIds(runDir) {
  const pagesDir = path.join(runDir, "pages");
  return fsSync.readdirSync(pagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^page_\d{3}$/i.test(entry.name))
    .map((entry) => entry.name.toLowerCase())
    .sort((a, b) => a.localeCompare(b));
}

function findPromptFile({ pageId, pageDir, promptRecords }) {
  const record = promptRecords.find((item) => item.pageId === pageId);
  return path.resolve(record?.path || record?.promptFile || path.join(pageDir, "worker-prompt.md"));
}

function findOcrPage(textHints, pageId) {
  return (textHints?.pages || []).find((page) => page.pageId === pageId) || null;
}

function parsePages(value = "") {
  const text = String(value || "").trim();
  if (!text) return [];
  const pages = new Set();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Math.max(1, Number(range[1]));
      const end = Math.max(start, Number(range[2]));
      for (let page = start; page <= end; page += 1) pages.add(`page_${String(page).padStart(3, "0")}`);
      continue;
    }
    if (/^\d+$/.test(part)) pages.add(`page_${String(Number(part)).padStart(3, "0")}`);
    else if (/^page_\d{3}$/i.test(part)) pages.add(part.toLowerCase());
  }
  return [...pages].sort((a, b) => a.localeCompare(b));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function requireArg(args, name) {
  const value = args[name] || args[name.replace(/-/g, "_")];
  if (!value) throw new Error(`Missing --${name}`);
  return String(value);
}

function printHelp() {
  console.log(`Build page worker briefs

Usage:
  node scripts/build-worker-briefs.mjs --job-id <workflow_id> --pages 1-3
  node scripts/build-worker-briefs.mjs --job-id <workflow_id> --workflow-root "E:\\PPT工具\\workspace\\jobs"

Output:
  workspace/jobs/<workflow_id>/worker-briefs/page_001/worker-brief.md
  workspace/jobs/<workflow_id>/worker-briefs/page_001/worker-brief.json

This command does not write page artifacts. It creates external handoff briefs
for real page workers that will author page-rebuild-spec.json and run the worker
pipeline inside their assigned page directory.
`);
}

function firstExistingPath(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    const resolved = path.resolve(String(candidate));
    if (fsSync.existsSync(resolved)) return resolved;
  }
  return path.join(process.cwd(), "workspace", "jobs");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
