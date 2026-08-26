import fsSync from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { rootDir } from "./store.js";

const execFileAsync = promisify(execFile);

export const PRESENTATION_ROUTE_IMAGE_FIDELITY = "image-fidelity";
export const PRESENTATION_ROUTE_PPT_MASTER_NATIVE = "ppt-master-native";
export const PRESENTATION_ROUTES = Object.freeze([
  PRESENTATION_ROUTE_IMAGE_FIDELITY,
  PRESENTATION_ROUTE_PPT_MASTER_NATIVE
]);

const REQUIRED_PPT_MASTER_FILES = Object.freeze([
  "SKILL.md",
  path.join("workflows", "routing.md"),
  path.join("workflows", "generate-pptx.md"),
  path.join("scripts", "attribution_guard.py"),
  path.join("scripts", "project_manager.py"),
  path.join("scripts", "svg_to_pptx.py"),
  "requirements.txt"
]);

export function normalizePresentationRoute(value = "") {
  const route = String(value || "").trim().toLowerCase();
  if (["ppt-master", "ppt_master", "native-svg", "native_editable", PRESENTATION_ROUTE_PPT_MASTER_NATIVE].includes(route)) {
    return PRESENTATION_ROUTE_PPT_MASTER_NATIVE;
  }
  return PRESENTATION_ROUTE_IMAGE_FIDELITY;
}

export function getPptMasterRuntimeConfig(env = globalThis.process?.env || {}) {
  const checkoutRoot = firstExistingPath([
    env.PPT_MASTER_ROOT,
    path.join(rootDir, "external", "ppt-master")
  ]);
  const skillRoot = firstExistingPath([
    env.PPT_MASTER_SKILL_ROOT,
    checkoutRoot ? path.join(checkoutRoot, "skills", "ppt-master") : "",
    path.join(os.homedir(), ".agents", "skills", "ppt-master"),
    path.join(os.homedir(), ".codex", "skills", "ppt-master")
  ]);
  return {
    checkoutRoot,
    skillRoot,
    pythonPath: resolvePptMasterPythonPath(env),
    runnerCommand: String(env.PPT_MASTER_RUNNER_COMMAND || "").trim(),
    runnerConfigured: Boolean(String(env.PPT_MASTER_RUNNER_COMMAND || "").trim())
  };
}

function resolvePptMasterPythonPath(env = {}) {
  const configured = String(env.PPT_MASTER_PYTHON_PATH || "").trim();
  const configuredPath = configured && (path.isAbsolute(configured) || /[\\/]/.test(configured))
    ? path.resolve(rootDir, configured)
    : "";
  const localPython = firstExistingPath([
    configuredPath,
    path.join(rootDir, ".venv", "Scripts", "python.exe"),
    path.join(rootDir, "venv", "Scripts", "python.exe"),
    path.join(rootDir, ".venv", "bin", "python"),
    path.join(rootDir, "venv", "bin", "python")
  ]);
  return localPython || configured || "python";
}

export async function testPptMasterRuntime(options = {}) {
  const config = getPptMasterRuntimeConfig(options.env || globalThis.process?.env || {});
  const files = REQUIRED_PPT_MASTER_FILES.map((relativePath) => ({
    relativePath,
    path: config.skillRoot ? path.join(config.skillRoot, relativePath) : "",
    ok: Boolean(config.skillRoot && fsSync.existsSync(path.join(config.skillRoot, relativePath)))
  }));
  const skillPath = config.skillRoot ? path.join(config.skillRoot, "SKILL.md") : "";
  const source = skillPath && fsSync.existsSync(skillPath) ? fsSync.readFileSync(skillPath, "utf8") : "";
  const version = source.match(/version:\s*["']?([^"'\r\n]+)["']?/i)?.[1]?.trim() || "";
  const officialRepository = source.match(/official_repository:\s*["']?([^"'\r\n]+)["']?/i)?.[1]?.trim() || "";
  const contract = {
    officialRepository,
    version,
    routedWorkflow: /PPT Master is a routed presentation workflow/i.test(source),
    attributionGuard: /attribution_guard\.py/i.test(source),
    nativeEditable: /editable PPTX decks/i.test(source)
  };
  contract.ok = Boolean(
    files.every((item) => item.ok)
    && /github\.com\/hugohe3\/ppt-master/i.test(officialRepository)
    && contract.routedWorkflow
    && contract.attributionGuard
    && contract.nativeEditable
  );

  let python = { ok: false, command: config.pythonPath, error: "Python probe did not run" };
  let integrity = { ok: false, skipped: true, error: "PPT Master contract is unavailable" };
  if (config.skillRoot) {
    python = await runProbe(config.pythonPath, ["--version"], { timeoutMs: Number(options.timeoutMs || 15000) });
    if (python.ok && files.find((item) => item.relativePath.endsWith("attribution_guard.py"))?.ok) {
      integrity = await runProbe(config.pythonPath, [path.join(config.skillRoot, "scripts", "attribution_guard.py")], {
        cwd: config.skillRoot,
        timeoutMs: Number(options.timeoutMs || 15000)
      });
    }
  }

  const installed = Boolean(config.skillRoot && files.some((item) => item.ok));
  const ready = Boolean(installed && contract.ok && python.ok && integrity.ok);
  return {
    ok: ready,
    installed,
    ready,
    runnable: Boolean(ready && config.runnerConfigured),
    automaticExecutionImplemented: false,
    route: PRESENTATION_ROUTE_PPT_MASTER_NATIVE,
    version,
    skillRoot: config.skillRoot,
    checkoutRoot: config.checkoutRoot,
    python,
    integrity,
    contract,
    files,
    runner: {
      configured: config.runnerConfigured,
      command: config.runnerConfigured ? path.basename(config.runnerCommand) : ""
    },
    message: !installed
      ? "PPT Master is not installed."
      : !ready
        ? "PPT Master is installed, but its local contract or integrity check failed."
        : config.runnerConfigured
          ? `PPT Master ${version || "runtime"} is ready with an explicit runner.`
          : `PPT Master ${version || "runtime"} is ready for Agent use; automatic product execution remains disabled until PPT_MASTER_RUNNER_COMMAND is configured.`,
    nextAction: ready && !config.runnerConfigured
      ? "Configure an audited PPT Master runner before enabling this route in the product UI."
      : ""
  };
}

async function runProbe(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: Number(options.timeoutMs || 15000),
      windowsHide: true
    });
    return {
      ok: true,
      command,
      output: String(stdout || stderr || "").trim().split(/\r?\n/).slice(0, 4).join("\n")
    };
  } catch (error) {
    return {
      ok: false,
      command,
      code: error.code || "",
      error: String(error.stderr || error.stdout || error.message || error).trim().slice(0, 800)
    };
  }
}

function firstExistingPath(candidates = []) {
  return candidates.find((candidate) => candidate && fsSync.existsSync(candidate)) || candidates.find(Boolean) || "";
}
