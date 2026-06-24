import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const rootDir = process.cwd();
const port = Number(process.env.PORT || 4180);

function readText(relativePath) {
  try {
    return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  } catch {
    return "";
  }
}

function readJson(relativePath) {
  const text = readText(relativePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function collectServerRoutes() {
  const source = readText("server/index.js");
  const routes = [];
  const pattern = /app\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  for (const match of source.matchAll(pattern)) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return routes;
}

function collectApiRefs(relativePath) {
  const source = readText(relativePath);
  return Array.from(new Set(source.match(/\/api\/[A-Za-z0-9_./:?-]+/g) || [])).sort();
}

function collectDistAssets() {
  const assetsDir = path.join(rootDir, "dist", "assets");
  if (!fs.existsSync(assetsDir)) return [];
  return fs.readdirSync(assetsDir).sort();
}

function getPortOwner() {
  if (process.platform !== "win32") return null;
  const command = [
    "$conn = Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;",
    "if ($conn) {",
    "$pidValue = [int]$conn.OwningProcess;",
    "Get-CimInstance Win32_Process -Filter \"ProcessId=$pidValue\" |",
    "Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
    "} else { 'null' }"
  ].join(" ");
  try {
    const stdout = execFileSync("powershell", ["-NoProfile", "-Command", command], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    return stdout && stdout !== "null" ? JSON.parse(stdout) : null;
  } catch (error) {
    return { error: error.message };
  }
}

async function getHealth() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (contentType.includes("application/json")) {
      return { status: response.status, json: JSON.parse(text) };
    }
    return { status: response.status, text: text.slice(0, 180).replace(/\s+/g, " ").trim() };
  } catch (error) {
    return { error: error.message };
  }
}

function formatList(items, formatter = (item) => item) {
  if (!items.length) return "- none";
  return items.map((item) => `- ${formatter(item)}`).join("\n");
}

const pkg = readJson("package.json") || {};
const routes = collectServerRoutes();
const scripts = pkg.scripts || {};
const workerScripts = Object.keys(scripts).filter((name) => name.startsWith("worker:")).sort();
const labScripts = Object.keys(scripts).filter((name) => name.startsWith("lab:")).sort();
const allowedWorkerScripts = new Set(["worker:batch", "worker:briefs", "worker:codex-slide", "worker:once"]);
const nonOrchestrationWorkerScripts = workerScripts.filter((name) => !allowedWorkerScripts.has(name));
const experimentalWorkerScripts = workerScripts.filter((name) => /local|model|pipeline|visual|asset|assemble/i.test(name));
const srcApiRefs = collectApiRefs("src/main.jsx");
const distApiRefs = collectDistAssets()
  .filter((file) => file.endsWith(".js"))
  .flatMap((file) => collectApiRefs(path.join("dist", "assets", file)));
const uniqueDistApiRefs = Array.from(new Set(distApiRefs)).sort();
const distIndex = readText("dist/index.html");
const portOwner = getPortOwner();
const health = await getHealth();
const healthRoot = health?.json?.rootDir || "";
const ownedByThisRepo = Boolean(health?.json?.ok && normalizePath(healthRoot) === normalizePath(rootDir));
const distLooksBuiltFromReact = /assets\/index-.*\.js/.test(distIndex);
const legacyApiRefs = uniqueDistApiRefs.filter((api) => !routes.some((route) => api.startsWith(route.path.replace(/:[^/]+/g, ""))));

console.log(`# Entrypoint Audit`);
console.log("");
console.log(`- root: ${rootDir}`);
console.log(`- expected port: ${port}`);
console.log(`- package name: ${pkg.name || "unknown"}`);
console.log(`- scripts.dev: ${pkg.scripts?.dev || "missing"}`);
console.log(`- scripts.local: ${pkg.scripts?.local || "missing"}`);
console.log(`- worker scripts: ${workerScripts.length}`);
console.log(`- lab scripts: ${labScripts.length}`);
console.log(`- non-orchestration worker scripts: ${nonOrchestrationWorkerScripts.length ? nonOrchestrationWorkerScripts.join(", ") : "none"}`);
console.log(`- experimental scripts exposed as worker:*: ${experimentalWorkerScripts.length ? experimentalWorkerScripts.join(", ") : "none"}`);
console.log(`- dist index: ${distIndex ? "present" : "missing"}`);
console.log(`- dist looks like Vite React build: ${distLooksBuiltFromReact ? "yes" : "no"}`);
console.log(`- current port owner: ${portOwner ? `${portOwner.Name || "unknown"} pid=${portOwner.ProcessId || "unknown"}` : "none"}`);
if (portOwner?.CommandLine) console.log(`- current port command: ${portOwner.CommandLine}`);
console.log(`- /api/health belongs to this repo: ${ownedByThisRepo ? "yes" : "no"}`);
if (health?.json) console.log(`- /api/health rootDir: ${healthRoot || "missing"}`);
if (health?.text) console.log(`- /api/health non-json preview: ${health.text}`);
if (health?.error) console.log(`- /api/health error: ${health.error}`);
console.log("");
console.log(`## Server Routes (${routes.length})`);
console.log(formatList(routes, (route) => `${route.method} ${route.path}`));
console.log("");
console.log(`## Worker Scripts (${workerScripts.length})`);
console.log(formatList(workerScripts, (name) => `${name} -> ${scripts[name]}`));
console.log("");
console.log(`## Lab Scripts (${labScripts.length})`);
console.log(formatList(labScripts, (name) => `${name} -> ${scripts[name]}`));
console.log("");
console.log(`## Source API References (${srcApiRefs.length})`);
console.log(formatList(srcApiRefs));
console.log("");
console.log(`## Dist API References (${uniqueDistApiRefs.length})`);
console.log(formatList(uniqueDistApiRefs));
console.log("");
console.log(`## Dist API References Without Matching server/index.js Route (${legacyApiRefs.length})`);
console.log(formatList(legacyApiRefs));
