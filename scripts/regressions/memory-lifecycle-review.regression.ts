import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

const root = mkdtempSync(join(tmpdir(), "memory-lifecycle-review-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { chats, gameContinuityBatches } = await import("../../packages/server/src/db/schema/index.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { continuityCampaignIdentity } = await import("../../packages/server/src/services/game/continuity-identity.js");
const db = await createFileNativeDB();
let failures = 0;
try {
  const now = new Date().toISOString();
  const chat = (id: string, gameId: string, groupId: string | null, mode = "game") => ({
    id,
    name: id,
    mode,
    groupId,
    characterIds: "[]",
    metadata: JSON.stringify({ gameId }),
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(chats)
    .values([
      chat("root", "root", null),
      chat("sibling", "root", "different-group"),
      chat("unrelated", "other", "root"),
      chat("ordinary", "root", "root", "chat"),
    ]);
  const source = readFileSync(
    new URL("../../packages/server/src/services/game/continuity-retirement.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile("retirement.ts", source, ts.ScriptTarget.Latest, true);
  const funcs = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      ["metadataObject", "otherCampaignSessionChatIds"].includes(node.name?.text ?? ""),
  );
  assert.equal(funcs.length, 2);
  const compiled = ts.transpileModule(funcs.map((f) => f.getText(ast)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const siblings = new Function(
    "chats",
    "eq",
    "continuityCampaignIdentity",
    compiled + "; return otherCampaignSessionChatIds;",
  )(chats, eq, continuityCampaignIdentity);
  try {
    assert.deepEqual(
      await siblings(db, "root"),
      ["sibling"],
      "root game identity finds siblings independently of group IDs",
    );
    assert.deepEqual(
      await siblings(db, "sibling"),
      ["root"],
      "metadata game identity excludes unrelated group matches",
    );
    process.stdout.write("PASS retirement campaign identity\n");
  } catch (error) {
    failures++;
    process.stderr.write(String(error) + "\n");
  }
  await db.insert(gameContinuityBatches).values(
    ["root", "sibling"].map((chatId) => ({
      id: "batch-" + chatId,
      chatId,
      sessionNumber: 1,
      sourceHash: "source",
      configHash: "config",
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })),
  );
  await db.delete(chats).where(eq(chats.id, "root"));
  try {
    assert.deepEqual(
      (await db.select().from(gameContinuityBatches)).map((row) => row.id),
      ["batch-sibling"],
      "chat deletion removes only that chat's continuity receipts",
    );
    process.stdout.write("PASS continuity receipt cascade\n");
  } catch (error) {
    failures++;
    process.stderr.write(String(error) + "\n");
  }
} finally {
  await db._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
