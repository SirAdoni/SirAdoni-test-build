// Static fixture server for the Campaign Wiki rendered checks. Bundles
// entry.tsx with esbuild into ./.out and compiles the client stylesheet from
// packages/client sources (never reads or writes packages/*/dist).
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
const bundle = path.join(out, "bundle.js");
const css = path.join(out, "client.css");
await build({ entryPoints: [path.join(root, "entry.tsx")], outfile: bundle, bundle: true, format: "esm", platform: "browser", sourcemap: false, jsx: "automatic", target: "es2022", absWorkingDir: repoRoot, nodePaths: clientNodePaths, plugins: [clientPublicAssetPlugin()], define: { "import.meta.env.VITE_MARINARA_LITE": "false" }, logLevel: "warning" });
await buildClientCss(css);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Campaign Wiki fixture</title><link rel="stylesheet" href="/client.css"></head><body style="margin:0;background:#101216"><main id="root" style="min-height:100vh;padding:16px"></main><script type="module" src="/bundle.js"></script></body></html>`;
const files = { "/bundle.js": bundle, "/client.css": css, "/locales/en.json": localeEn };
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (pathname === "/") return res.end(html);
  const filename = files[pathname];
  const publicAsset = resolveClientPublicAsset(pathname);
  if (publicAsset) { res.setHeader("Content-Type", clientPublicContentType(publicAsset)); return fs.createReadStream(publicAsset).pipe(res); }
  if (!filename) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("Content-Type", pathname.endsWith(".css") ? "text/css" : pathname.endsWith(".json") ? "application/json" : "text/javascript");
  fs.createReadStream(filename).pipe(res);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port, pid: process.pid })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
