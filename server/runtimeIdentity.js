import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_SCOPE = ["package.json", "index.html", "vite.config.js", "server", "shared", "src", "dist"];

export async function createRuntimeIdentityTracker(rootDir, options = {}) {
  const scope = Array.isArray(options.scope) && options.scope.length ? options.scope : DEFAULT_SCOPE;
  const cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs || 5000));
  const startup = await fingerprintRuntime(rootDir, scope);
  let cached = startup;
  let cachedAt = Date.now();
  let refreshPromise = null;
  return {
    startup,
    scope,
    async current() {
      if (Date.now() - cachedAt >= cacheTtlMs) {
        if (!refreshPromise) {
          refreshPromise = fingerprintRuntime(rootDir, scope).then((next) => {
            cached = next;
            cachedAt = Date.now();
            return next;
          }).finally(() => {
            refreshPromise = null;
          });
        }
        await refreshPromise;
      }
      return {
        startupFingerprint: startup.fingerprint,
        currentFingerprint: cached.fingerprint,
        sourceCurrent: startup.fingerprint === cached.fingerprint,
        restartRequired: startup.fingerprint !== cached.fingerprint,
        startupFileCount: startup.fileCount,
        currentFileCount: cached.fileCount,
        checkedAt: new Date(cachedAt).toISOString()
      };
    }
  };
}

export async function fingerprintRuntime(rootDir, scope = DEFAULT_SCOPE) {
  const groups = await Promise.all(scope.map(async (relative) => {
    const absolute = path.resolve(rootDir, relative);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat) {
      return [`${normalizePath(relative)}|missing`];
    }
    if (stat.isDirectory()) return collectDirectoryRecords(rootDir, absolute);
    return [formatRecord(rootDir, absolute, stat)];
  }));
  const records = groups.flat();
  records.sort();
  return {
    fingerprint: crypto.createHash("sha256").update(records.join("\n")).digest("hex"),
    fileCount: records.length
  };
}

async function collectDirectoryRecords(rootDir, directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const groups = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    if (entry.isDirectory()) return collectDirectoryRecords(rootDir, absolute);
    if (entry.isFile()) {
      const stat = await fs.stat(absolute).catch(() => null);
      return stat ? [formatRecord(rootDir, absolute, stat)] : [];
    }
    return [];
  }));
  return groups.flat();
}

function formatRecord(rootDir, absolute, stat) {
  return `${normalizePath(path.relative(rootDir, absolute))}|${stat.size}|${Math.round(stat.mtimeMs)}`;
}

function normalizePath(value = "") {
  return String(value).split(path.sep).join("/");
}
