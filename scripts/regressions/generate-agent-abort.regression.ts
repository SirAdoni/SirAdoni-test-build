import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActiveAgentRun } from "../../packages/server/src/routes/generate/retry-agents-route.js";

// Never open the tree's real data dir: an engine running there holds the writer lease.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "marinara-agent-abort-"));
process.env.FILE_STORAGE_DIR = join(process.env.DATA_DIR, "storage");
// Server modules load after the env is set, so no import reads the default data dir first.
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await generateRoutes(app);

const primaryController = new AbortController();
const agentController = new AbortController();
const activeGenerations = (
  app as unknown as {
    activeGenerations: Map<string, ActiveAgentRun>;
  }
).activeGenerations;
activeGenerations.set("attached-agent-abort", {
  abortController: primaryController,
  agentAbortController: agentController,
  backendUrl: null,
  messageId: null,
  swipeIndex: null,
});

try {
  const response = await app.inject({
    method: "POST",
    url: "/abort",
    payload: { chatId: "attached-agent-abort", agentsOnly: true },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { aborted: true, count: 1 });
  assert.equal(agentController.signal.aborted, true, "Stop Agents must cancel attached agent work");
  assert.equal(primaryController.signal.aborted, false, "Stop Agents must preserve the primary response");

  console.info("Attached agent abort regression passed.");
} finally {
  activeGenerations.clear();
  await app.close();
  await closeDB();
}
