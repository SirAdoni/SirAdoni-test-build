import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { buildClientCss } from "../lib/build-client-css.mjs";
import {
  clientNodePaths,
  clientPublicAssetPlugin,
  clientPublicContentType,
  fixtureDir,
  localeEn,
  outputDir,
  repoRoot,
  resolveClientPublicAsset,
} from "../lib/fixture-paths.mjs";

const root = fixtureDir(import.meta.url);
const out = outputDir(import.meta.url);
const bundle = path.join(out, "component-bundle.js");
const css = path.join(out, "component.css");
await build({
  entryPoints: [path.join(root, "component-entry.tsx")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  target: "es2022",
  absWorkingDir: repoRoot,
  nodePaths: clientNodePaths,
  tsconfigRaw: { compilerOptions: { baseUrl: repoRoot, paths: { "@/*": ["packages/client/src/*"] } } },
  plugins: [clientPublicAssetPlugin()],
  define: { "import.meta.env.VITE_MARINARA_LITE": "false" },
  logLevel: "warning",
});
await buildClientCss(css);

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Backup settings fixture</title><link rel="stylesheet" href="/component.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/component-bundle.js"></script></body></html>`;
let settings = {
  enabled: false,
  frequency: "weekly",
  retentionCount: 5,
  mode: "full",
  lastBackupAt: null,
  lastError: null,
  nextBackupAt: null,
  backupExists: false,
};
let backups = [
  {
    name: "marinara-backup-incremental-fixture",
    createdAt: new Date().toISOString(),
    path: "fixture",
    mode: "incremental",
  },
];
let failNextPut = false;
let delayNextPut = false;
let delayAutomaticGet = false;
let sequence = 0;
const events = [];

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    return res.end(html);
  }
  if (url.pathname === "/locales/en.json") {
    res.setHeader("Content-Type", "application/json");
    return fs.createReadStream(localeEn).pipe(res);
  }
  if (url.pathname === "/control" && req.method === "GET") {
    if (url.searchParams.has("failPut")) failNextPut = true;
    if (url.searchParams.has("delayPut")) delayNextPut = true;
    if (url.searchParams.has("delayAutomaticGet")) delayAutomaticGet = true;
    return sendJson(res, 200, { events, settings, backups });
  }
  if (url.pathname === "/api/backup/automatic" && req.method === "GET") {
    if (delayAutomaticGet) {
      delayAutomaticGet = false;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return sendJson(res, 200, settings);
  }
  if (url.pathname === "/api/backup/automatic" && req.method === "PUT") {
    const body = await readJson(req);
    events.push({ type: "settings", body });
    if (failNextPut) {
      failNextPut = false;
      return sendJson(res, 500, { error: "fixture settings save failed" });
    }
    if (delayNextPut) {
      delayNextPut = false;
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
    settings = { ...settings, ...body };
    return sendJson(res, 200, settings);
  }
  if (url.pathname === "/api/backup" && req.method === "GET") return sendJson(res, 200, backups);
  if (url.pathname === "/api/backup" && req.method === "POST") {
    const name = `marinara-backup-incremental-${++sequence}`;
    const backup = { name, createdAt: new Date().toISOString(), path: "fixture", mode: settings.mode };
    backups = [backup, ...backups];
    events.push({ type: "create", mode: settings.mode, name });
    return sendJson(res, 201, backup);
  }
  if (url.pathname === "/api/backup/download/start" && req.method === "POST") {
    const body = await readJson(req);
    const jobId = `job-${++sequence}`;
    events.push({ type: "download", ...body, jobId });
    return sendJson(res, 200, { jobId, status: "preparing" });
  }
  if (url.pathname.startsWith("/api/backup/download/status/") && req.method === "GET") {
    const jobId = url.pathname.split("/").at(-1);
    return sendJson(res, 200, { status: "ready", downloadUrl: `/portable/${encodeURIComponent(jobId)}.zip` });
  }
  if (url.pathname.startsWith("/portable/") && req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="portable-backup.zip"');
    return res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  }
  if (url.pathname === "/api/usage/summary") {
    return sendJson(res, 200, {
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      totals: { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      byConnection: [],
      byChat: [],
      byDay: [],
    });
  }
  if (url.pathname === "/api/connections" || url.pathname === "/api/characters") return sendJson(res, 200, []);
  if (url.pathname === "/api/personal-extensions/policy")
    return sendJson(res, 200, { externalEnabled: false, allowInstall: false });
  if (url.pathname === "/api/agents/import-policy") return sendJson(res, 200, { enabled: false });
  if (url.pathname.startsWith("/api/")) return sendJson(res, 200, {});

  const files = { "/component-bundle.js": bundle, "/component.css": css };
  const filename = files[url.pathname] ?? resolveClientPublicAsset(url.pathname);
  if (!filename) {
    res.statusCode = 404;
    return res.end("not found");
  }
  res.setHeader(
    "Content-Type",
    url.pathname.endsWith(".css")
      ? "text/css"
      : url.pathname.endsWith(".js")
        ? "text/javascript"
        : clientPublicContentType(filename),
  );
  fs.createReadStream(filename).pipe(res);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
