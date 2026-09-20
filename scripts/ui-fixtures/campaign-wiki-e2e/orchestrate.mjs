// Real-Engine browser harness: boots an isolated Engine on an ephemeral port
// with a fresh temp DATA_DIR, runs the knowledge e2e runner, stops the Engine,
// restarts it on the same DATA_DIR and runs the readback runner. Results land
// in ./.out/e2e-results.json. The temp DATA_DIR is removed afterwards unless
// E2E_KEEP_DATA=1; set E2E_DATA_DIR to reuse a specific isolated directory.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startFixtureServer, stopFixtureServer } from "../lib/fixture-server.mjs";
import { fixtureDir, outputDir, tsxLoaderUrl } from "../lib/fixture-paths.mjs";

const root = fixtureDir(import.meta.url);
const out = outputDir(import.meta.url);
const ownsDataDir = !process.env.E2E_DATA_DIR;
const dataDir = process.env.E2E_DATA_DIR ? path.resolve(process.env.E2E_DATA_DIR) : await fs.mkdtemp(path.join(os.tmpdir(), "marinara-wiki-e2e-"));
const nodeArgs = ["--import", tsxLoaderUrl()];
const serverScript = path.join(root, "server-e2e.mjs");

function startEngine() {
  return startFixtureServer(serverScript, { env: { E2E_DATA_DIR: dataDir }, nodeArgs });
}
function run(name, info) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, name)], { cwd: root, env: { ...process.env, E2E_BASE: `http://127.0.0.1:${info.port}`, E2E_CHAT: info.chatId, E2E_OUT: out }, stdio: "inherit", windowsHide: true });
    child.once("exit", (code) => (code ? reject(new Error(`${name} exited ${code}`)) : resolve()));
    child.once("error", reject);
  });
}

let result = { pass: false };
try {
  const first = startEngine();
  const { info: firstInfo } = await first.ready;
  try { await run(process.env.RUNNER ?? "run-knowledge-e2e.mjs", firstInfo); } finally { await stopFixtureServer(first.server); }
  const second = startEngine();
  const { info: secondInfo } = await second.ready;
  try { await run("readback.mjs", secondInfo); } finally { await stopFixtureServer(second.server); }
  const phase1 = JSON.parse(await fs.readFile(path.join(out, "phase1-results.json"), "utf8"));
  const restart = JSON.parse(await fs.readFile(path.join(out, "restart-results.json"), "utf8"));
  result = { generatedAt: new Date().toISOString(), dataDir, phase1, restart, pass: phase1.checks.every((check) => check.pass) && restart.checks.every((check) => check.pass) };
} catch (error) {
  console.error(error);
  result = { generatedAt: new Date().toISOString(), dataDir, error: String(error?.stack ?? error), pass: false };
} finally {
  if (ownsDataDir && process.env.E2E_KEEP_DATA !== "1") await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
await fs.writeFile(path.join(out, "e2e-results.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (result.pass) console.log("campaign-wiki e2e passed");
else { console.log("campaign-wiki e2e FAILED"); process.exitCode = 1; }
