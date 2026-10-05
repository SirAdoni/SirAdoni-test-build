import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildGameInputInsertion } from "../../packages/client/src/lib/game-input-insertion";

const replaced = buildGameInputInsertion(
  { markdown: "[asset](card://1)", chatId: "chat-1" },
  "chat-1",
  "before remove after",
  7,
  13,
);
assert.deepEqual(replaced, { value: "before [asset](card://1) after", cursor: 24 });

assert.equal(
  buildGameInputInsertion({ markdown: "[asset](card://1)", chatId: "other-chat" }, "chat-1", "draft", 2, 2),
  null,
  "an insert addressed to another chat must not alter this composer",
);

assert.deepEqual(
  buildGameInputInsertion({ markdown: "[asset](card://1)" }, "chat-1", "draft", null, null),
  { value: "draft[asset](card://1)", cursor: 22 },
  "an untargeted insert goes to the active composer at its current caret, or the end when no caret is available",
);

assert.equal(buildGameInputInsertion({ markdown: "" }, "chat-1", "draft", 2, 2), null);

const source = readFileSync(
  new URL("../../packages/client/src/components/game/GameInput.tsx", import.meta.url),
  "utf8",
);
assert.match(source, /addEventListener\(CARD_ASSET_INSERT_EVENT, handleCardAssetInsert\)/);
assert.match(source, /buildGameInputInsertion\(\s*detail,\s*draftKey,/);
assert.match(source, /updateText\(insertion\.value\)/);
assert.match(source, /setSelectionRange\(insertion\.cursor, insertion\.cursor\)/);

console.log("Game input card-asset insertion regression passed.");
