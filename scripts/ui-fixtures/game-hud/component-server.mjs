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
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/component.css"></head><body style="margin:0;background:#101216"><main id="root" style="height:100vh"></main><script type="module" src="/component-bundle.js"></script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") {
    res.setHeader("Content-Type", "text/html");
    return res.end(html);
  }
  if (url.pathname === "/api/game/hud-chat/contacts") {
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        contacts: [
          {
            id: "real-npc",
            characterId: "char-real",
            name: "Real NPC",
            avatar: "/npc-silhouette.svg",
            opinion: 0,
            relationshipStatus: "friend-of",
            automaticCategories: ["trusted"],
            evidenceMessageIds: ["m1"],
          },
          { id: "unknown", name: "Unknown", relationshipStatus: "", automaticCategories: [], evidenceMessageIds: [] },
        ],
        coverage: { complete: true, pendingSessions: 0 },
      }),
    );
  }
  const files = { "/component-bundle.js": bundle, "/component.css": css, "/locales/en.json": localeEn };
  const filename = files[url.pathname] ?? resolveClientPublicAsset(url.pathname);
  if (!filename) {
    res.statusCode = 404;
    return res.end("not found");
  }
  res.setHeader(
    "Content-Type",
    url.pathname.endsWith(".css")
      ? "text/css"
      : url.pathname.endsWith(".json")
        ? "application/json"
        : url.pathname.endsWith(".js")
          ? "text/javascript"
          : clientPublicContentType(filename),
  );
  fs.createReadStream(filename).pipe(res);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
