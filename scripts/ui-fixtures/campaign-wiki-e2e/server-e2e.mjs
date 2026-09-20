// Boots an isolated Marinara Engine (packages/server/src/app.ts via the tsx
// loader) on an ephemeral port against an isolated DATA_DIR, seeds one
// character, game chat, message, entity and verified fact, and serves an
// esbuild bundle of the bare CampaignWiki component behind an /api proxy.
// Must be started with `node --import <tsx loader> server-e2e.mjs` and with
// E2E_DATA_DIR set (orchestrate.mjs does both). Never uses packages/server/data.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const dataDir = path.resolve(process.env.E2E_DATA_DIR ?? path.join(out, "data"));
const liveDataDir = path.join(repoRoot, "packages", "server", "data");
if (dataDir === liveDataDir || dataDir.startsWith(liveDataDir + path.sep)) throw new Error(`refusing to run against live storage: ${dataDir}`);
await fsp.mkdir(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = path.join(dataDir, "files");
process.env.MARINARA_ENV_FILE = path.join(root, "empty.env");
process.env.MARINARA_REQUEST_LOGGING = "false";
process.env.AUTO_OPEN_BROWSER = "false";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";
process.env.LOG_LEVEL ??= "silent";

const load = (relative) => import(pathToFileURL(path.join(repoRoot, relative)).href);
const { buildApp } = await load("packages/server/src/app.ts");
const { getDB, closeDB } = await load("packages/server/src/db/connection.ts");
const { createChatsStorage } = await load("packages/server/src/services/storage/chats.storage.ts");
const { createCharactersStorage } = await load("packages/server/src/services/storage/characters.storage.ts");
const { createCampaignMemoryStorage } = await load("packages/server/src/services/storage/campaign-memory.storage.ts");
const db = await getDB();
const chats = createChatsStorage(db);
const chars = createCharactersStorage(db);
const manifestPath = path.join(dataDir, "wiki-e2e-manifest.json");
let manifest;
try { manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")); } catch {}
if (!manifest) {
  const character = await chars.create({ name: "E2E Character", description: "A temporary character for Campaign Wiki proof.", personality: "calm", scenario: "proof", first_mes: "Hello.", mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "", tags: ["e2e"], creator: "fixture", character_version: "1.0", alternate_greetings: [], extensions: { talkativeness: 0.5, fav: false, world: "e2e", depth_prompt: { depth: 0, prompt: "", role: "system" }, backstory: "", appearance: "", versioningEnabled: true }, character_book: null });
  const chat = await chats.create({ name: "Real Campaign Memory E2E", mode: "game", characterIds: [character.id], groupId: null, personaId: null, promptPresetId: null, connectionId: null });
  // Seed shape only: session-summary-refresh.ts `descriptors()` falls back to the whole metadata
  // object when `gameSessionSummaryRefreshes` is absent and then reads `.status` off `summary: null`,
  // which crashes buildApp on a fresh store. Give the chat an empty descriptor map so the Engine boots.
  await chats.patchMetadata(chat.id, { gameSessionSummaryRefreshes: {} }, { touchUpdatedAt: false });
  const message = await chats.createMessage({ chatId: chat.id, role: "user", characterId: null, content: "The archive key is stored in the northern archive." });
  const memory = createCampaignMemoryStorage(db);
  const provenance = { source: "real-e2e", sourceRevision: "e2e-1", actor: "system", authoredAt: new Date().toISOString() };
  const entity = await memory.createEntity({ chatId: chat.id, entityId: "e2e-character", kind: "character", owner: { type: "existing", store: "characters", recordId: character.id }, aliases: ["E2E Character"], tags: ["e2e"], summary: "Original summary", attributes: {}, status: "active", manualLock: false, provenance });
  const fact = await memory.createFact({ chatId: chat.id, factId: "e2e-fact", subjectEntityId: entity.entityId, predicate: "holds archive key", value: "north", conditions: [], status: "verified", sourceRevision: "e2e-1", evidence: [{ messageId: message.id, quote: "The archive key is stored in the northern archive." }], author: "system", provenance, manualLock: false });
  manifest = { chatId: chat.id, characterId: character.id, entityId: entity.entityId, factId: fact.factId, messageId: message.id };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}
const chat = await chats.getById(manifest.chatId);
const memory = createCampaignMemoryStorage(db);
const entity = await memory.getEntity({ chatId: manifest.chatId }, manifest.entityId);
const fact = await memory.getFact({ chatId: manifest.chatId }, manifest.factId);
if (!chat || !entity || !fact) throw new Error("Manifest references missing seeded records");
await db._fileStore.flush();
const app = await buildApp();
await app.listen({ host: "127.0.0.1", port: 0 });
const engine = app.server.address().port;
const bundle = path.join(out, "bundle.js");
const css = path.join(out, "client.css");
await build({ entryPoints: [path.join(root, "entry-e2e.tsx")], outfile: bundle, bundle: true, format: "esm", platform: "browser", jsx: "automatic", target: "es2022", absWorkingDir: repoRoot, nodePaths: clientNodePaths, plugins: [clientPublicAssetPlugin()], define: { "import.meta.env.VITE_MARINARA_LITE": "false" }, logLevel: "warning" });
await buildClientCss(css);
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Campaign Wiki e2e</title><link rel="stylesheet" href="/client.css"></head><body style="margin:0"><main id="root" style="min-height:100vh;padding:16px"></main><script type="module" src="/bundle.js"></script></body></html>`;
const proxy = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  if (u.pathname.startsWith("/api/")) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await new Promise((resolve) => { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => resolve(Buffer.concat(chunks))); });
    const upstream = await fetch(`http://127.0.0.1:${engine}${u.pathname}${u.search}`, { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body });
    res.statusCode = upstream.status;
    upstream.headers.forEach((v, k) => { if (!["content-length", "content-encoding", "transfer-encoding", "connection"].includes(k.toLowerCase())) res.setHeader(k, v); });
    res.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }
  if (u.pathname === "/") return res.end(html);
  if (u.pathname === "/locales/en.json") { res.setHeader("Content-Type", "application/json"); return fs.createReadStream(localeEn).pipe(res); }
  const publicAsset = resolveClientPublicAsset(u.pathname);
  if (publicAsset) { res.setHeader("Content-Type", clientPublicContentType(publicAsset)); return fs.createReadStream(publicAsset).pipe(res); }
  const file = u.pathname === "/bundle.js" ? bundle : u.pathname === "/client.css" ? css : null;
  if (!file) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("Content-Type", u.pathname.endsWith(".css") ? "text/css" : "text/javascript");
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
console.log(JSON.stringify({ port: proxy.address().port, chatId: chat.id, enginePort: engine, messageId: manifest.messageId, factId: fact.factId, dataDir, manifest: manifestPath }));
const shutdown = async () => { await new Promise((resolve) => proxy.close(resolve)); await app.close(); await closeDB(); process.exit(0); };
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
