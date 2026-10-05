import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { PrivateNotebookDocument } from "../../packages/shared/src/index.js";
import {
  getDirtyPrivateNotebookDrafts,
  getPrivateNotebookDraftQueryKey,
  reconcilePrivateNotebookDrafts,
  restorePrivateNotebookDrafts,
  type PrivateNotebookDraftMap,
} from "../../packages/client/src/components/chat/private-notebook-draft-cache.js";

const clientRequire = createRequire(new URL("../../packages/client/package.json", import.meta.url));
const { QueryClient } = clientRequire("@tanstack/react-query");
const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
const target = { scope: "chat" } as const;
const targetKey = () => "chat";
const document = (content: string, revision: number) => ({ target, content, revision }) as PrivateNotebookDocument;
const dirtyDrafts: PrivateNotebookDraftMap = {
  chat: {
    target,
    content: "unsaved note",
    savedContent: "server note",
    revision: 1,
    status: "saving",
    conflictDocument: null,
  },
};
const firstChatKey = getPrivateNotebookDraftQueryKey("chat-one");
const secondChatKey = getPrivateNotebookDraftQueryKey("chat-two");

queryClient.setQueryData(firstChatKey, getDirtyPrivateNotebookDrafts(dirtyDrafts));
assert.equal((queryClient.getQueryData(firstChatKey) as PrivateNotebookDraftMap)?.chat.content, "unsaved note");
assert.equal(queryClient.getQueryData(secondChatKey), undefined, "draft cache must be isolated by chat id");

const restored = restorePrivateNotebookDrafts(queryClient.getQueryData(firstChatKey) as PrivateNotebookDraftMap);
assert.equal(restored.chat.status, "unsaved", "interrupted save is resumable after the panel remounts");

const unchangedServer = reconcilePrivateNotebookDrafts(restored, [document("server note", 2)], targetKey);
assert.equal(unchangedServer.chat.content, "unsaved note");
assert.equal(unchangedServer.chat.revision, 2, "safe drafts advance to the fresh server revision");
assert.equal(unchangedServer.chat.status, "unsaved");

const concurrentEdit = reconcilePrivateNotebookDrafts(unchangedServer, [document("new server note", 3)], targetKey);
assert.equal(concurrentEdit.chat.content, "unsaved note", "conflict reconciliation preserves the user's draft");
assert.equal(concurrentEdit.chat.status, "conflict");
assert.equal(concurrentEdit.chat.conflictDocument?.content, "new server note");
const reopenedConflict = reconcilePrivateNotebookDrafts(concurrentEdit, [document("new server note", 3)], targetKey);
assert.equal(
  reopenedConflict.chat.status,
  "conflict",
  "reopening must not silently resolve a conflict and autosave mine",
);
assert.equal(reopenedConflict.chat.content, "unsaved note");
assert.equal(reopenedConflict.chat.conflictDocument?.content, "new server note");

const savedElsewhere = reconcilePrivateNotebookDrafts(restored, [document("unsaved note", 4)], targetKey);
assert.deepEqual(
  getDirtyPrivateNotebookDrafts(savedElsewhere),
  {},
  "a server-confirmed draft is removed from recovery cache",
);
queryClient.removeQueries({ queryKey: firstChatKey, exact: true });
assert.equal(queryClient.getQueryData(firstChatKey), undefined, "safe-save cleanup removes the per-chat cache entry");

const cleanDrafts = reconcilePrivateNotebookDrafts({}, [document("server note", 1)], targetKey);
assert.deepEqual(
  getDirtyPrivateNotebookDrafts(cleanDrafts),
  {},
  "saved notebook content is not copied into the draft cache",
);

queryClient.clear();
console.info("Private notebook draft-cache regression passed.");
