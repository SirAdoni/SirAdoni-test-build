import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { buildClientCss } from "../lib/build-client-css.mjs";
import {
  clientNodePaths,
  clientPublicAssetPlugin,
  fixtureDir,
  localeEn,
  outputDir,
  repoRoot,
} from "../lib/fixture-paths.mjs";
const root = fixtureDir(import.meta.url),
  out = outputDir(import.meta.url);
await build({
  entryPoints: [path.join(root, "entry.tsx")],
  outfile: path.join(out, "bundle.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  target: "es2022",
  absWorkingDir: repoRoot,
  nodePaths: clientNodePaths,
  plugins: [clientPublicAssetPlugin()],
  define: { "import.meta.env.VITE_MARINARA_LITE": "false" },
  logLevel: "warning",
});
await buildClientCss(path.join(out, "client.css"));
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://fixture").pathname;
  if (pathname === "/")
    return res.end(
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/client.css"></head><body class="bg-background text-foreground"><main id="root" style="padding:16px"></main><script type="module" src="/bundle.js"></script></body></html>',
    );
  const files = {
    "/bundle.js": path.join(out, "bundle.js"),
    "/client.css": path.join(out, "client.css"),
    "/locales/en.json": localeEn,
  };
  if (!files[pathname]) {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader(
    "Content-Type",
    pathname.endsWith("css") ? "text/css" : pathname.endsWith("json") ? "application/json" : "text/javascript",
  );
  fs.createReadStream(files[pathname]).pipe(res);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port, pid: process.pid })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
