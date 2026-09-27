import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { buildClientCss } from "../lib/build-client-css.mjs";
import { clientNodePaths, clientPublicAssetPlugin, clientPublicContentType, fixtureDir, localeEn, outputDir, repoRoot, resolveClientPublicAsset } from "../lib/fixture-paths.mjs";

const root = fixtureDir(import.meta.url), out = outputDir(import.meta.url), bundle = path.join(out, "component-bundle.js"), css = path.join(out, "component.css");
await build({ entryPoints: [path.join(root, "component-entry.tsx")], outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022", absWorkingDir: repoRoot, nodePaths: clientNodePaths, plugins: [clientPublicAssetPlugin()], define: { "import.meta.env.VITE_MARINARA_LITE": "false" }, logLevel: "warning" });
await buildClientCss(css);

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Game turn review fixture</title><link rel="stylesheet" href="/component.css"></head><body style="margin:0"><main id="root"></main><script type="module" src="/component-bundle.js"></script></body></html>`;
let review = {
  messageId: "fixture-message", swipeIndex: 0, revision: "rev-1", pending: false, canCorrect: true,
  before: { time: { day: 7, hour: 21, minute: 45 }, location: { id: "harbor", name: "Moon Harbor" }, present: ["Player", "Companion"] },
  after: { time: { day: 8, hour: 6, minute: 5 }, location: { id: "archive", name: "Northern Archive" }, present: ["Player", "Companion"] },
  changes: [
    { id: "time", field: "time", before: "Day 7, 21:45", after: "Day 8, 06:05", evidence: { messageId: "fixture-message", swipeIndex: 0, quote: "The bells mark dawn." }, source: "recorded" },
    { id: "location", field: "location", before: "Moon Harbor", after: "Northern Archive", evidence: null, source: "state_only" },
    { id: "presence-player", field: "presence", subject: "Player", before: "Present", after: "Present", evidence: null, source: "state_only" },
  ],
  locations: [{ id: "harbor", name: "Moon Harbor" }, { id: "archive", name: "Northern Archive" }],
};
let conflictOnce = true;
let modeOverride = null;
const sendJson = (res, status, body) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/") { res.setHeader("Content-Type", "text/html"); return res.end(html); }
  if (url.pathname === "/locales/en.json") { res.setHeader("Content-Type", "application/json"); return fs.createReadStream(localeEn).pipe(res); }
  if (url.pathname === "/control") { modeOverride = url.searchParams.get("mode"); return sendJson(res, 200, { ok: true }); }
  if (url.pathname === "/api/game/fixture-chat/turn-review/fixture-message" && req.method === "GET") {
    const mode = modeOverride;
    if (mode === "error") return sendJson(res, 500, { error: "fixture review failure" });
    if (mode === "mismatch") return sendJson(res, 200, { ...review, swipeIndex: 1 });
    if (mode === "readonly") return sendJson(res, 200, { ...review, canCorrect: false, readOnlyReason: "This saved turn is read-only." });
    if (mode === "pending") return sendJson(res, 200, { ...review, pending: true, canCorrect: false });
    return sendJson(res, 200, review);
  }
  if (url.pathname === "/api/game/fixture-chat/turn-review/fixture-message" && req.method === "PATCH") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (conflictOnce) { conflictOnce = false; review = { ...review, revision: "rev-2", after: { ...review.after, time: { day: 8, hour: 7, minute: 0 } } }; return sendJson(res, 409, { error: "stale review" }); }
      const item = JSON.parse(raw || "{}").correction ?? {};
      if (item.field === "time") review = { ...review, revision: `rev-${Date.now()}`, after: { ...review.after, time: item.value } };
      if (item.field === "location") { const location = review.locations.find((entry) => entry.id === item.locationId) ?? null; review = { ...review, revision: `rev-${Date.now()}`, after: { ...review.after, location } }; }
      if (item.field === "presence") { const present = new Set(review.after.present ?? []); if (item.present) present.add(item.name); else present.delete(item.name); review = { ...review, revision: `rev-${Date.now()}`, after: { ...review.after, present: [...present] } }; }
      setTimeout(() => sendJson(res, 200, review), 650);
    });
    return;
  }
  const files = { "/component-bundle.js": bundle, "/component.css": css };
  const filename = files[url.pathname] ?? resolveClientPublicAsset(url.pathname);
  if (!filename) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("Content-Type", url.pathname.endsWith(".css") ? "text/css" : url.pathname.endsWith(".js") ? "text/javascript" : clientPublicContentType(filename));
  fs.createReadStream(filename).pipe(res);
});
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: server.address().port })));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
