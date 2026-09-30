import assert from "node:assert/strict";
import { containsPackagedAboutMeAgent } from "../about-me-package-boundary.mjs";
const retired =
  '["about-me-keeper","prompt-reviewer","response-orchestrator","schedule-planner","chat-summary","autonomous-messenger","youtube","secret-plot-driver"]';
const deadMigration = `var retired=${retired},ids=new Set(retired);`;
const lazyMigration = `var a,retired,ids,b,init=()=>{a=[];retired=${retired},ids=new Set(retired),b=[];};`;
assert.equal(containsPackagedAboutMeAgent(deadMigration, true), false);
assert.equal(containsPackagedAboutMeAgent(lazyMigration, true), false);
assert.equal(containsPackagedAboutMeAgent(deadMigration), true);
assert.equal(containsPackagedAboutMeAgent(`${deadMigration}var agent={id:"about-me-keeper"};`, true), true);
assert.equal(containsPackagedAboutMeAgent(`${deadMigration}var agent={id:retired[0]};`, true), true);
assert.equal(containsPackagedAboutMeAgent(`${lazyMigration}registerAgents(ids);`, true), true);
assert.equal(containsPackagedAboutMeAgent(JSON.stringify(deadMigration), true), true);
assert.equal(containsPackagedAboutMeAgent(retired, true), true);
assert.equal(containsPackagedAboutMeAgent('["about-me-keeper","different-id"]', true), true);
for (const marker of ["about-me-keeper", "About Me Keeper", "aboutMeKeeper"]) {
  assert.equal(containsPackagedAboutMeAgent(marker, true), true);
  assert.equal(containsPackagedAboutMeAgent(marker), true);
}
console.log("About Me boundary permits only unused migration metadata and rejects active registry references.");
