import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyTextareaQuoteFormat } from "../../packages/client/src/lib/textarea-quotes.js";

const gameInput = readFileSync(
  new URL("../../packages/client/src/components/game/GameInput.tsx", import.meta.url),
  "utf8",
);
assert.match(gameInput, /applyTextareaQuoteFormat\(e\.target, quoteFormat, e\.nativeEvent as InputEvent\)/u);

let animationFrames = 0;
Object.assign(globalThis, {
  window: {
    requestAnimationFrame: () => ++animationFrames,
    cancelAnimationFrame: () => undefined,
  },
});

const runPaste = (value: string, format: "straight" | "typographic") => {
  let selectionRestores = 0;
  const textarea = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    selectionDirection: "none",
    setSelectionRange: () => {
      selectionRestores += 1;
    },
  } as unknown as HTMLTextAreaElement;
  Object.assign(globalThis, { document: { activeElement: textarea } });
  const result = applyTextareaQuoteFormat(textarea, format, {
    inputType: "insertFromPaste",
    data: value,
    isComposing: false,
  } as InputEvent);
  return { result, selectionRestores };
};

const largePaste = "A long pasted paragraph.\n".repeat(20_000);
const unchanged = runPaste(largePaste, "typographic");
assert.equal(unchanged.result, largePaste);
assert.equal(unchanged.selectionRestores, 0, "quote-free large paste must not restore selection");

const alreadyFormatted = runPaste("He said “hello”.", "typographic");
assert.equal(alreadyFormatted.result, "He said “hello”.");
assert.equal(alreadyFormatted.selectionRestores, 0, "unchanged typographic paste must not restore selection");

const normalized = runPaste("He said 'hello'.", "typographic");
assert.equal(normalized.result, "He said ‘hello’.");
assert.equal(normalized.selectionRestores, 1, "changed quotes must preserve the caret");
assert.equal(animationFrames, 1);

console.info("Game input paste regression passed.");
