// Runs every Campaign Wiki rendered fixture in sequence and aggregates the
// *-results.json files from ./.out into ./.out/summary.json.
//   node scripts/ui-fixtures/campaign-wiki/run-all.mjs            default set
//   node scripts/ui-fixtures/campaign-wiki/run-all.mjs editor     substring filter
//   node scripts/ui-fixtures/campaign-wiki/run-all.mjs --all      include out-of-scope runners
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fixtureDir, outputDir } from "../lib/fixture-paths.mjs";

const root = fixtureDir(import.meta.url);
const out = outputDir(import.meta.url);
const DEFAULT_RUNNERS = [
  ["run-tests.mjs", "results.json"],
  ["run-editor.mjs", "editor-results.json"],
  ["run-create-evidence-owner.mjs", "create-evidence-owner-results.json"],
  ["run-lore-owner.mjs", "lore-owner-results.json"],
  ["run-pulse8-scrolled.mjs", "pulse8-scrolled-results.json"],
  ["run-commitment-conflict.mjs", "commitment-conflict-results.json"],
  ["run-branch-proof.mjs", "branch-results.json"],
  ["run-knowledge-setting-proof.mjs", "knowledge-setting-results.json"],
  ["run-review-canon.mjs", "review-canon-results.json"],
];
const EXTRA_RUNNERS = [["run-inventory-settings-proof.mjs", "inventory-settings-results.json"]];
const args = process.argv.slice(2);
const includeAll = args.includes("--all");
const filters = args.filter((arg) => !arg.startsWith("--"));
const runners = (includeAll ? [...DEFAULT_RUNNERS, ...EXTRA_RUNNERS] : DEFAULT_RUNNERS).filter(([name]) => filters.length === 0 || filters.some((filter) => name.includes(filter)));

const summary = { generatedAt: new Date().toISOString(), runners: [], pass: true };
for (const [runner, resultsFile] of runners) {
  const resultsPath = path.join(out, resultsFile);
  await fs.rm(resultsPath, { force: true });
  process.stdout.write(`[wiki-ui] ${runner} START\n`);
  const startedAt = Date.now();
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, runner)], { cwd: root, stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    child.stdout.on("data", () => undefined);
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
  let results = null;
  try { results = JSON.parse(await fs.readFile(resultsPath, "utf8")); } catch {}
  const checks = results?.checks ?? [];
  const failed = checks.filter((check) => !check.pass);
  const pass = exitCode === 0 && results !== null && failed.length === 0;
  summary.pass &&= pass;
  summary.runners.push({ runner, resultsFile, exitCode, durationMs: Date.now() - startedAt, checks: checks.length, failed: failed.map((check) => ({ name: check.name, detail: check.detail })) });
  process.stdout.write(`[wiki-ui] ${runner} ${pass ? "PASS" : "FAIL"} (${checks.length} checks, ${failed.length} failed, exit ${exitCode}, ${Math.round((Date.now() - startedAt) / 1000)}s)\n`);
  for (const check of failed) process.stdout.write(`[wiki-ui]   FAILED: ${check.name} ${check.detail ? `-- ${check.detail}` : ""}\n`);
}
await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
if (summary.pass) console.log("campaign-wiki ui fixtures passed");
else { console.log("campaign-wiki ui fixtures FAILED"); process.exitCode = 1; }
