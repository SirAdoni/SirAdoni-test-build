import assert from "node:assert/strict";
import { parseGameJsonish } from "../../packages/server/src/services/game/jsonish.js";

assert.deepEqual(parseGameJsonish('{"ok":true}'), { ok: true });
assert.deepEqual(parseGameJsonish('Thinking briefly.\n{"ok":true}\nDone.'), { ok: true });
assert.deepEqual(parseGameJsonish('Unfinished thought [perhaps\n{"ok":true}\nDone.'), { ok: true });
assert.deepEqual(parseGameJsonish('Meta [not valid JSON].\n["usable", {"nested": true}]\nFinished.'), [
  "usable",
  { nested: true },
]);
assert.deepEqual(
  parseGameJsonish(
    '<think>An example was {"discard":"this"}.</think>\n{"posts":[],"interactions":[],"follows":[],"digests":[]}',
  ),
  { posts: [], interactions: [], follows: [], digests: [] },
);
assert.deepEqual(parseGameJsonish('```json\n{"message":"a } and ] inside a string"}\n```\nAccidental footer'), {
  message: "a } and ] inside a string",
});
assert.deepEqual(parseGameJsonish('Preface\n{"items":[1,2,],}\nFooter'), { items: [1, 2] });
assert.deepEqual(parseGameJsonish('Preface\n{"payload":{"ok":true},}\nFooter'), { payload: { ok: true } });
assert.throws(() => parseGameJsonish("No structured output was returned."));

process.stdout.write("Embedded JSON output regression passed.\n");
