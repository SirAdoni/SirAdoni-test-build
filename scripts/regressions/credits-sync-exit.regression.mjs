import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(path.join(tmpdir(), "mari-credits-exit-"));
const source = new URL("../sync-credits.mjs", import.meta.url);
try {
  const scripts = path.join(root, "scripts");
  const modal = path.join(root, "packages/client/src/components/chat/HomeCreditsModal.tsx");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(path.dirname(modal), { recursive: true });
  copyFileSync(source, path.join(scripts, "sync-credits.mjs"));
  const preload = path.join(root, "fetch.mjs");
  writeFileSync(preload, `globalThis.fetch = async () => new Response(JSON.stringify([
    {login:"fixture",html_url:"https://github.com/fixture",contributions:7,type:"User"},
    {login:"fixture-bot",html_url:"https://github.com/fixture-bot",contributions:99,type:"Bot"}
  ]), {status:200});`);
  const stale = 'before\nconst CONTRIBUTORS = [\n  { login: "old", url: "https://github.com/old", contributions: 1 },\n];\nafter\n';
  const current = 'before\nconst CONTRIBUTORS = [\n  { login: "fixture", url: "https://github.com/fixture", contributions: 7 },\n];\nafter\n';
  const run = (...args) => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(scripts, "sync-credits.mjs"), ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
  writeFileSync(modal, stale);
  const checkStale = run("--check");
  assert.equal(checkStale.status, 1, checkStale.stderr);
  assert.equal(checkStale.signal, null);
  assert.match(checkStale.stderr, /Credits are stale/);
  assert.equal(readFileSync(modal, "utf8"), stale, "check must not change the modal");
  const sync = run();
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(readFileSync(modal, "utf8"), current);
  const checkCurrent = run("--check");
  assert.equal(checkCurrent.status, 0, checkCurrent.stderr);
  assert.equal(checkCurrent.signal, null);
  assert.match(checkCurrent.stdout, /Credits are up to date \(1 contributors\)/);
  assert.equal(readFileSync(modal, "utf8"), current);
  console.log("Credits sync: stale, update and current exit paths passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
