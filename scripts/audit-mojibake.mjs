import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const targets = collectSourceFiles(path.join(root, "src"))
  .concat(collectSourceFiles(path.join(root, "shared")))
  .map((filePath) => path.relative(root, filePath));

const mojibakePattern = /[\uE000-\uF8FF\uFFFD]|姝|鐢|鏈|鏃|瑙|绯|閿|闇|寮|鍚|瀹|鍥|淇|璇|鏂|绔|璧|澶|鍘|彶|缂|緫|鈫|脳|浠诲姟鎬绘暟|杈圭晫|椤甸潰/;

const allowedLinePatterns = [
  /function isMojibake/
];

const findings = [];

for (const target of targets) {
  const filePath = path.join(root, target);
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!mojibakePattern.test(line)) return;
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
