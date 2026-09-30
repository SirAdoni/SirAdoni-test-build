import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const checker = resolve(dirname(fileURLToPath(import.meta.url)), "../check-impeccable-context.mjs");
const root = mkdtempSync(join(tmpdir(), "me-impeccable-link-"));
const run = () => spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8", windowsHide: true });
try {
  mkdirSync(join(root, ".agents"));
  writeFileSync(join(root, ".agents/skills"), "../.claude/skills");
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing.*SKILL.md/);
  const skill = join(root, ".claude/skills/impeccable");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "fixture skill");
  const product = `## Register\nproduct\n\n## Users\n${"Known product context. ".repeat(15)}`;
  writeFileSync(join(skill, "scripts/load-context.mjs"), `process.stdout.write(JSON.stringify(${JSON.stringify({ hasProduct: true, hasDesign: true, product })}));`);
  assert.equal(run().status, 0, "materialized tracked link must resolve the real dependency");
  writeFileSync(join(root, ".agents/skills"), "../../unrelated-skills");
  assert.equal(run().status, 1, "unexpected text must not redirect the validation gate");
  console.log("impeccable Git link regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
