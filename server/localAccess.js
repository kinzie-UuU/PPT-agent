const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function resolveLocalAccessConfig(env = process.env, port = 4180) {
  const host = normalizeHost(env.PPT_TOOL_HOST || "127.0.0.1");
  if (!isLoopbackHost(host)) {
    const error = new Error("PPT_TOOL_HOST must be a loopback address. Remote access is disabled until authenticated remote mode is implemented.");
    error.code = "PPT_TOOL_REMOTE_ACCESS_DISABLED";
    throw error;
  }
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`
  ]);
  for (const value of splitConfiguredOrigins(env.PPT_TOOL_ALLOWED_ORIGINS)) {
    const normalized = normalizeLocalOrigin(value);
    if (!normalized) {
      const error = new Error(`PPT_TOOL_ALLOWED_ORIGINS contains a non-loopback or invalid origin: ${value}`);
      error.code = "PPT_TOOL_INVALID_ALLOWED_ORIGIN";
      throw error;
    }
    allowedOrigins.add(normalized);
  }
  return {
    host,
    accessMode: "loopback-only",
    allowedHosts: [...LOOPBACK_HOSTS],
    allowedOrigins: [...allowedOrigins]
  };
}

export function createLocalRequestBoundary(config) {
  const allowedOrigins = new Set(config.allowedOrigins || []);
  return function localRequestBoundary(req, res, next) {
    const hostname = normalizeHost(req.hostname || req.headers.host || "");
    if (!isLoopbackHost(hostname)) {
      res.status(403).json({
        ok: false,
        code: "LOCAL_HOST_REQUIRED",
        error: "PPT Agent only accepts requests addressed to a loopback host."
      });
      return;
    }
    const origin = String(req.headers.origin || "").trim();
    if (origin && !allowedOrigins.has(normalizeOrigin(origin))) {
      res.status(403).json({
        ok: false,
        code: WRITE_METHODS.has(req.method) ? "UNTRUSTED_WRITE_ORIGIN" : "UNTRUSTED_BROWSER_ORIGIN",
        error: "Cross-site browser access to the local PPT Agent is not allowed."
      });
      return;
    }
    next();
  };
}

export function createLocalCorsOptions(config) {
  const allowedOrigins = new Set(config.allowedOrigins || []);
  return {
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(normalizeOrigin(origin)));
    },
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-PPT-Agent-Request-Id", "X-PPT-Agent-Recover-Pending"],
    maxAge: 600
  };
}

export function localSecurityHeaders(_req, res, next) {
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

export function isLoopbackHost(value = "") {
  return LOOPBACK_HOSTS.has(normalizeHost(value));
}

function normalizeHost(value = "") {
  const text = String(value).trim().toLowerCase();
  if (text.startsWith("[")) return text.slice(1, text.indexOf("]"));
  if (text === "::1") return text;
  return text.split(":")[0];
}

function normalizeLocalOrigin(value = "") {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !isLoopbackHost(url.hostname)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function normalizeOrigin(value = "") {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function splitConfiguredOrigins(value = "") {
  return String(value || "").split(/[;,\s]+/).map((item) => item.trim()).filter(Boolean);
}
