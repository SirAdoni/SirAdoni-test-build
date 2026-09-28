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

const root = fixtureDir(import.meta.url),
  out = outputDir(import.meta.url),
  bundle = path.join(out, "component-bundle.js"),
  css = path.join(out, "component.css");
await build({
  entryPoints: [path.join(root, "component-entry.tsx")],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  absWorkingDir: repoRoot,
  nodePaths: clientNodePaths,
  plugins: [clientPublicAssetPlugin()],
  define: { "import.meta.env.VITE_MARINARA_LITE": "false" },
  logLevel: "warning",
});
await buildClientCss(css);

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game continuity connection fixture</title><link rel="stylesheet" href="/component.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/component-bundle.js"></script></body></html>`;
const status = {
  config: { mode: "active", extractorConnectionId: null, verifierConnectionId: null },
  connectionAvailable: false,
  counts: {},
  batches: [],
  gaps: [],
  verifiedThroughMessageId: null,
};
const sendJson = (res, body) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    return res.end(html);
  }
  if (url.pathname === "/locales/en.json") {
    res.setHeader("Content-Type", "application/json");
    return fs.createReadStream(localeEn).pipe(res);
  }
  if (url.pathname === "/api/game/fixture-chat/continuity" && req.method === "GET") return sendJson(res, status);
  if (url.pathname === "/api/connections" && req.method === "GET") return sendJson(res, []);
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
