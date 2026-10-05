import assert from "node:assert/strict";
import {
  resolveCampaignLineage,
  type CampaignLineageChat,
} from "../../packages/server/src/services/game/campaign-lineage.js";

const make = (
  id: string,
  session: number,
  messageIds: string[],
  metadata: Record<string, unknown> = {},
): CampaignLineageChat => ({
  id,
  mode: "game",
  groupId: "g",
  messageIds,
  metadata: { gameId: "g", gameSessionNumber: session, ...metadata },
});
const branch = (
  child: CampaignLineageChat,
  parent: CampaignLineageChat,
  sourceId: string | null,
  copiedId: string | null,
  count: number,
) => {
  child.metadata = {
    ...child.metadata,
    branchParentChatId: parent.id,
    branchParentMessageId: sourceId,
    branchMessageId: copiedId,
    branchLineageVersion: 1,
    branchCopyMode: count === 0 ? "full-prefix" : "through-message",
    branchCopiedMessageCount: count,
  };
};

const legacyGroupOnly = make("legacy-group-only", 1, ["legacy"]);
delete legacyGroupOnly.metadata.gameId;
assert.equal(resolveCampaignLineage("g", legacyGroupOnly.id, [legacyGroupOnly]).status, "ready");
const conflictingGameIds = make("conflicting-game-ids", 1, ["x"]);
conflictingGameIds.metadata.gameId = "other";
assert.equal(resolveCampaignLineage("g", conflictingGameIds.id, [conflictingGameIds]).status, "held");
const malformedGameId = make("malformed-game-id", 1, ["x"]);
malformedGameId.metadata.gameId = 7;
assert.equal(resolveCampaignLineage("g", malformedGameId.id, [malformedGameId]).status, "held");
const wrongGroup = make("wrong-group", 1, ["x"]);
wrongGroup.groupId = "other";
assert.equal(resolveCampaignLineage("g", wrongGroup.id, [wrongGroup]).status, "held");
const wrongMode = make("wrong-mode", 1, ["x"]);
wrongMode.mode = "chat";
assert.equal(resolveCampaignLineage("g", wrongMode.id, [wrongMode]).status, "held");

const first = make("s1", 1, ["a", "b"]);
const a = make("a-branch", 1, ["a1", "b1"]);
branch(a, first, "b", "b1", 2);
const sibling = make("sibling", 1, ["a2", "b2"]);
branch(sibling, first, "b", "b2", 2);
const second = make("s2", 2, ["c", "d"], { gameSessionParentChatId: a.id });
const selected = make("selected", 2, ["c1", "d1"], { gameSessionParentChatId: a.id });
branch(selected, second, "d", "d1", 2);
const resolved = resolveCampaignLineage("g", selected.id, [first, a, sibling, second, selected]);
assert.equal(resolved.status, "ready");
assert.deepEqual(
  resolved.sessions.map((session) => session.chatId),
  [a.id, selected.id],
);
assert.deepEqual(resolved.sessions[1]?.branchPathChatIds, [second.id, selected.id]);
assert.ok(!resolved.sessions.some((session) => session.chatId === sibling.id));

// Parent edits/removal outside the still-present cutoff anchor never rebuild the saved child snapshot.
first.messageIds = ["b"];
assert.equal(resolveCampaignLineage("g", a.id, [first, a]).status, "ready");
first.messageIds = [];
assert.equal(resolveCampaignLineage("g", a.id, [first, a]).status, "held");

const empty = make("empty", 1, []);
const emptyBranch = make("empty-branch", 1, ["later"]);
branch(emptyBranch, empty, null, null, 0);
assert.equal(resolveCampaignLineage("g", emptyBranch.id, [empty, emptyBranch]).status, "ready");
const ambiguous = make("legacy-empty", 1, [], {
  branchParentChatId: empty.id,
  branchParentMessageId: null,
  branchMessageId: null,
});
assert.equal(resolveCampaignLineage("g", ambiguous.id, [empty, ambiguous]).status, "held");
const missingParent = make("s2-missing-parent", 2, ["m"]);
assert.equal(
  resolveCampaignLineage("g", missingParent.id, [missingParent]).holds[0]?.reason,
  "required predecessor is missing",
);
assert.equal(resolveCampaignLineage("g", "deleted-target", [first]).holds[0]?.edge, "target");
const foreign = make("foreign", 1, ["foreign-end"], { gameId: "other" });
const crossGameBranch = make("cross-game-branch", 1, ["copy-end"]);
branch(crossGameBranch, foreign, "foreign-end", "copy-end", 1);
assert.equal(resolveCampaignLineage("g", crossGameBranch.id, [crossGameBranch, foreign]).status, "held");
const badCount = make("bad-count", 1, ["copy-end"]);
branch(badCount, first, "b", "copy-end", 0);
assert.equal(resolveCampaignLineage("g", badCount.id, [first, badCount]).status, "held");
const partialProof = make("partial-proof", 1, ["copy-end"], {
  branchParentChatId: first.id,
  branchParentMessageId: "b",
  branchMessageId: "copy-end",
  branchCopyMode: "unknown",
  branchCopiedMessageCount: 0,
});
assert.equal(resolveCampaignLineage("g", partialProof.id, [first, partialProof]).status, "held");
const danglingProof = make("dangling-proof", 1, [], { branchCopiedMessageCount: 0 });
assert.equal(resolveCampaignLineage("g", danglingProof.id, [danglingProof]).status, "held");
const cyclicA = make("cycle-a", 1, ["x"]);
const cyclicB = make("cycle-b", 1, ["y"]);
branch(cyclicA, cyclicB, "y", "x", 1);
branch(cyclicB, cyclicA, "x", "y", 1);
assert.equal(resolveCampaignLineage("g", cyclicA.id, [cyclicA, cyclicB]).status, "held");

console.info("Campaign lineage regression passed");
