import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { PDFParse } from "pdf-parse";
import { getProviderConfig, testImageProvider, testOcrProvider } from "./providers.js";
import { rootDir, outputDir, uploadDir } from "./store.js";
import { workflowRootDir } from "./workflowJobs.js";
import { testEditableRuntime } from "./workflowEditable.js";
import { resolvePowerShellExecutable } from "./pptxEditability.js";
import { testPptMasterRuntime } from "./workflowPptMaster.js";

const execFileAsync = promisify(execFile);

export async function runProductDoctor(options = {}) {
  const startedAt = new Date().toISOString();
  const providers = getProviderConfig();
  const checks = [];

  checks.push(makeCheck("node", "Node.js runtime", true, process.version, {
    platform: process.platform,
    arch: process.arch
  }));

  checks.push(makeCheck("workspace-root", "Workspace root", fsSync.existsSync(rootDir), rootDir));
  checks.push(await checkWritableDir("outputs", "Output directory", outputDir));
  checks.push(await checkWritableDir("uploads", "Upload directory", uploadDir));
  checks.push(await checkWritableDir("workflow-root", "Workflow job directory", workflowRootDir));

  checks.push(makeCheck(
    "llm-provider",
    "LLM provider",
    Boolean(providers.llm.configured),
    providers.llm.configured ? `${providers.llm.model} via ${providers.llm.baseUrl}` : "Missing API key",
    publicProviderDetails(providers.llm)
  ));

  const imageProbe = await testImageProvider({ generateProbe: false }).catch((error) => ({
    ok: false,
    error: error.message || "Image provider test failed"
  }));
  checks.push(makeCheck(
    "image-provider",
    "Image provider",
    Boolean(imageProbe.ok),
    imageProbe.ok ? `${providers.image.model} via ${providers.image.baseUrl}` : imageProbe.error || "Image provider unavailable",
    publicProviderDetails(providers.image)
  ));
  checks.push(makeCheck(
    "image-edit-provider",
    "Source image edit provider",
    Boolean(providers.image.configured && providers.image.enabled && providers.image.supportsImageEdit),
    providers.image.supportsImageEdit
      ? `${providers.image.model} via ${providers.image.editEndpoint || "/images/edits"}`
      : "Image edit endpoint disabled; product visual redraw needs source-page image input",
    {
      ...publicProviderDetails(providers.image),
      editEndpoint: providers.image.editEndpoint || "/images/edits",
      requiredInputMode: providers.image.requiredInputMode || "source-page-edit"
    },
    providers.image.supportsImageEdit ? {} : {
      nextAction: "启用 IMAGE_EDIT_ENABLED 或选择支持 /images/edits 的 OpenAI-compatible 图片服务。"
    }
  ));

  checks.push(checkCodexPptSkillContract());

  const pptMaster = await testPptMasterRuntime({ timeoutMs: Number(options.pptMasterTimeoutMs || 15000) }).catch((error) => ({
    ok: false,
    error: error.message || "PPT Master runtime check failed"
  }));
  checks.push(makeCheck(
    "ppt-master",
    "PPT Master native provider",
    Boolean(pptMaster.ok),
    pptMaster.message || pptMaster.error || "PPT Master provider unavailable",
    pptMaster,
    pptMaster.nextAction ? { nextAction: pptMaster.nextAction } : {}
  ));

  const ocrProbe = providers.ocr.enabled
    ? await testOcrProvider().catch((error) => ({ ok: false, error: error.message || "OCR probe failed" }))
    : { ok: false, error: "OCR disabled" };
  checks.push(makeCheck(
    "ocr-provider",
    "OCR provider",
    Boolean(ocrProbe.ok),
    ocrProbe.ok
      ? `${providers.ocr.provider}${providers.ocr.fallbackProvider ? ` fallback ${providers.ocr.fallbackProvider}` : ""}`
      : ocrProbe.error || "OCR unavailable",
    {
      provider: providers.ocr.provider,
      fallbackProvider: providers.ocr.fallbackProvider || "",
      pythonPath: providers.ocr.pythonPath,
      probe: ocrProbe
    }
  ));

  const editable = await testEditableRuntime({ timeoutMs: Number(options.editpptTimeoutMs || 60000) }).catch((error) => ({
    ok: false,
    error: error.message || "editppt doctor failed"
  }));
  checks.push(makeCheck(
    "editppt",
    "editppt runtime",
    Boolean(editable.ok),
    editable.ok ? "doctor passed" : editable.error || editable.doctor?.next || "doctor failed",
    {
      runtime: editable.runtime || null,
      textHints: editable.doctor?.text_hints || null
    }
  ));
  checks.push(makeCheck(
    "image-to-editable-contract",
    "image-to-editable-ppt contract",
    Boolean(editable.contract?.ok),
    editable.contract?.ok
      ? `${editable.contract.mode}${editable.contract.agentsSkillRoot ? " via .agents skill" : ""}`
      : editable.contract?.error || "image-to-editable-ppt skill contract is legacy or unknown",
    {
      contract: editable.contract || null,
      runtime: editable.runtime || null
    },
    editable.contract?.ok ? {} : {
      nextAction: "请刷新 image-to-editable-ppt skill 到 v0.3，并确认 EDITPPT_SKILL_ROOT 指向 .agents/skills/image-to-editable-ppt。"
    }
  ));

  const powerpoint = await checkPowerPointCom();
  checks.push(powerpoint);
  checks.push(await checkPdfRenderer());

  const required = new Set(["node", "workspace-root", "outputs", "uploads", "workflow-root", "llm-provider", "image-provider", "image-edit-provider", "codex-ppt-contract", "editppt", "image-to-editable-contract"]);
  const failedRequired = checks.filter((check) => required.has(check.id) && !check.ok);
  const warnings = checks.filter((check) => !required.has(check.id) && !check.ok);

  return {
    ok: failedRequired.length === 0,
    level: failedRequired.length ? "blocked" : warnings.length ? "warning" : "ready",
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: failedRequired.length
      ? `${failedRequired.length} required check(s) failed`
      : warnings.length
        ? `${warnings.length} optional check(s) need attention`
        : "All required product runtime checks passed",
    checks,
    required: [...required],
    system: {
      cwd: process.cwd(),
      rootDir,
      workflowRootDir,
      outputDir,
      uploadDir,
      tmpDir: os.tmpdir()
    }
  };
}

function checkCodexPptSkillContract() {
  const skillRoot = firstExistingPath([
    process.env.CODEX_PPT_SKILL_ROOT,
    path.join(os.homedir(), ".agents", "skills", "codex-ppt"),
    path.join(os.homedir(), ".codex", "skills", "codex-ppt")
  ]);
  const skillPath = path.join(skillRoot || "", "SKILL.md");
  if (!skillRoot || !fsSync.existsSync(skillPath)) {
    return makeCheck("codex-ppt-contract", "codex-ppt contract", false, "Official codex-ppt skill is missing", { skillRoot, skillPath });
  }
  const source = fsSync.readFileSync(skillPath, "utf8");
  const agentsSkillRoot = /[\\\/]\.agents[\\\/]skills[\\\/]codex-ppt/i.test(skillRoot);
  const customStyleLibrary = /CODEX_PPT_HOME[\s\S]{0,160}\.codex-ppt-skill[\s\S]{0,120}references/i.test(source);
  const sampleGenerationMethod = /sample_generation_method/i.test(source);
  const mandatorySubagents = /subagents are mandatory|must be dispatched to a slide subagent/i.test(source);
  const generatedImageOnly = /Local drawing[\s\S]{0,220}failure modes/i.test(source);
  const ok = Boolean(agentsSkillRoot && customStyleLibrary && sampleGenerationMethod && mandatorySubagents && generatedImageOnly);
  return makeCheck(
    "codex-ppt-contract",
    "codex-ppt contract",
    ok,
    ok ? "v0.5.5-compatible via .agents skill" : "codex-ppt skill is not the canonical v0.5.5-compatible contract",
    {
      mode: ok ? "v0.5.5-compatible" : "legacy-or-unknown",
      skillRoot,
      skillPath,
      agentsSkillRoot,
      customStyleLibrary,
      sampleGenerationMethod,
      mandatorySubagents,
      generatedImageOnly
    },
    ok ? {} : { nextAction: "Refresh codex-ppt from the official repository and point CODEX_PPT_SKILL_ROOT to .agents/skills/codex-ppt." }
  );
}

function firstExistingPath(candidates = []) {
  return candidates.find((candidate) => candidate && fsSync.existsSync(candidate)) || candidates.find(Boolean) || "";
}

async function checkWritableDir(id, label, dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.doctor-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    await fs.writeFile(probe, "ok", "utf8");
    await fs.unlink(probe);
    return makeCheck(id, label, true, dirPath);
  } catch (error) {
    return makeCheck(id, label, false, error.message || "Directory is not writable", { path: dirPath });
  }
}

async function checkPowerPointCom() {
  if (process.platform !== "win32") {
    return makeCheck("powerpoint", "PowerPoint COM", false, "Windows only check", { platform: process.platform });
  }
  const command = "$type = [type]::GetTypeFromProgID('PowerPoint.Application'); if ($type) { 'registered' } else { 'missing' }";
  try {
    const { stdout } = await execFileAsync(resolvePowerShellExecutable(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      timeout: 10000,
      windowsHide: true
    });
    const value = String(stdout || "").trim();
    return makeCheck("powerpoint", "PowerPoint COM", value === "registered", value || "missing");
  } catch (error) {
    return makeCheck("powerpoint", "PowerPoint COM", false, error.message || "PowerPoint COM check failed");
  }
}

async function checkPdfRenderer() {
  const command = process.env.PDFTOPPM_PATH || "pdftoppm";
  try {
    const { stdout, stderr } = await execFileAsync(command, ["-v"], {
      timeout: 10000,
      windowsHide: true
    });
    const output = String(stdout || stderr || "").trim().split(/\r?\n/)[0] || "pdftoppm available";
    return makeCheck("pdf-renderer", "PDF renderer", true, output, {
      command,
      dpi: Number(process.env.PDF_RENDER_DPI || 160),
      configKeys: ["PDFTOPPM_PATH", "PDFTOPPM_ARGS_PREFIX_JSON", "PDF_RENDER_DPI", "PDF_RENDER_TIMEOUT_MS"]
    });
  } catch (error) {
    const fallback = checkPdfParseFallback();
    if (fallback.ok) {
      return makeCheck("pdf-renderer", "PDF renderer", true, "pdf-parse fallback available", {
        command,
        code: error.code || "",
        fallback: fallback.name,
        dpi: Number(process.env.PDF_RENDER_DPI || 160),
        desiredWidth: Number(process.env.PDF_PARSE_RENDER_WIDTH || 1600),
        configKeys: ["PDFTOPPM_PATH", "PDFTOPPM_ARGS_PREFIX_JSON", "PDF_RENDER_DPI", "PDF_RENDER_TIMEOUT_MS", "PDF_PARSE_RENDER_WIDTH"]
      }, {
        nextAction: "Poppler 未配置；当前会使用 pdf-parse 本地渲染 PDF 页面。安装 Poppler 后可走 pdftoppm 快路径。"
      });
    }
    return makeCheck("pdf-renderer", "PDF renderer", false, "Optional: install Poppler pdftoppm or set PDFTOPPM_PATH to render PDF inputs.", {
      command,
      code: error.code || "",
      dpi: Number(process.env.PDF_RENDER_DPI || 160),
      configKeys: ["PDFTOPPM_PATH", "PDFTOPPM_ARGS_PREFIX_JSON", "PDF_RENDER_DPI", "PDF_RENDER_TIMEOUT_MS"]
    }, {
      nextAction: "安装 Poppler，或把 PDFTOPPM_PATH 设置为 pdftoppm.exe 的完整路径，然后重启本地服务。",
      docs: "README.md#configuration"
    });
  }
}

function checkPdfParseFallback() {
  return { ok: Boolean(PDFParse), name: "pdf-parse" };
}

function publicProviderDetails(provider = {}) {
  return {
    provider: provider.provider || "",
    configured: Boolean(provider.configured),
    enabled: provider.enabled !== false,
    baseUrl: provider.baseUrl || "",
    model: provider.model || "",
    timeoutMs: provider.timeoutMs,
    maxRetries: provider.maxRetries,
    concurrency: provider.concurrency,
    supportsImageEdit: Boolean(provider.supportsImageEdit),
    editEndpoint: provider.editEndpoint || "",
    requiredInputMode: provider.requiredInputMode || ""
  };
}

function makeCheck(id, label, ok, message = "", details = {}, extra = {}) {
  return {
    id,
    label,
    ok: Boolean(ok),
    status: ok ? "pass" : "fail",
    message: String(message || ""),
    details,
    ...extra,
    checkedAt: new Date().toISOString()
  };
}
