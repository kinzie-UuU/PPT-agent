import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const explicitTextTargets = [
  "README.md",
  "docs/product-goal.md",
  "server/index.js",
  "server/smoke-tests.js",
  "server/workflowDelivery.js",
  "server/workflowV1AcceptanceReport.js",
  "server/workflowV1Readiness.js"
].filter((target) => fs.existsSync(path.join(root, target)));

const targets = explicitTextTargets
  .concat(collectSourceFiles(path.join(root, "src")))
  .concat(collectSourceFiles(path.join(root, "shared")))
  .map((filePath) => path.relative(root, filePath));

const mojibakePatterns = [
  /[\uE000-\uF8FF\uFFFD]/,
  /閿|鈧|燂拷/,
  /濮潀|閻|閺|闁|閸|鐎|娣|婢|缂|娴|妞|鑴|绱|顦|縷|绮|鍨|嘲/,
  /鏉|妤|闂|閳|浜у搧|宸ュ叿|鍓嶇|鍚庣|鐢熸垚|鍥剧|涓绘|褰撳|瀹屾|闂|鎵€|杈撳|涓嬭|鏂囦欢|妯℃|鍙|鐪熷/
];

const allowedLinePatterns = [
  /function isMojibake/,
  /scoreDecodedName/,
  /score -=/,
  /mojibakePatterns/
];

const findings = [];

for (const target of targets) {
  const filePath = path.join(root, target);
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!mojibakePatterns.some((pattern) => pattern.test(line))) return;
    if (allowedLinePatterns.some((pattern) => pattern.test(line))) return;
    findings.push(`${target}:${index + 1}: ${line.trim()}`);
  });
}

if (findings.length) {
  console.error("Mojibake audit failed:");
  for (const line of findings.slice(0, 50)) console.error(line);
  if (findings.length > 50) console.error(`...and ${findings.length - 50} more`);
  process.exit(1);
}

console.log("Mojibake audit passed.");

function collectSourceFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(filePath));
    else if (/\.(js|jsx|mjs|ts|tsx)$/.test(entry.name)) files.push(filePath);
  }
  return files;
}
