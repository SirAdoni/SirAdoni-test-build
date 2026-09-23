import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SELECTION_ACTION_BUTTON_CLASS,
  SELECTION_ACTION_LABEL_CLASS,
  SELECTION_EXTRA_ACTION_BUTTON_CLASS,
  SELECTION_EXTRA_ACTION_LABEL_CLASS,
} from "../../packages/client/src/components/ui/selection-action-classes.js";

// At 390px the selection bar truncated its labels ("Ex...", "De..."). Export and Delete are now each an
// inline-size container whose label hides (screen-reader only) when that button is too narrow; panel extras go
// icon-only and content-sized on phones and in a narrow panel, and hide their label by their own width otherwise.
// Every button names itself through title and aria-label so the icon-only state stays usable.
const classes = (value: string) => value.split(/\s+/u).filter(Boolean);
const widthHide = /^@max-\[[\d.]+rem\]:sr-only$/u;

// Export and Delete.
const main = classes(SELECTION_ACTION_BUTTON_CLASS);
for (const name of ["@container", "flex-1", "min-w-0", "mari-chrome-control"]) assert.ok(main.includes(name), name);
assert.ok(classes(SELECTION_ACTION_LABEL_CLASS).some((name) => widthHide.test(name)), "label hides by button width");
assert.ok(!SELECTION_ACTION_LABEL_CLASS.includes("max-[400px]"), "Export and Delete keep their words on phones");

// Extras: a size container cannot be content-sized, so it switches off exactly where the button turns flex-none.
const extra = classes(SELECTION_EXTRA_ACTION_BUTTON_CLASS);
for (const name of ["@container", "flex-1", "min-w-0", "mari-chrome-control"]) assert.ok(extra.includes(name), name);
for (const variant of ["max-[400px]:", "@max-[28rem]/panel:"]) {
  assert.ok(extra.includes(`${variant}flex-none`), `${variant} extras are content-sized`);
  assert.ok(extra.includes(`${variant}[container-type:normal]`), `${variant} extras stop being size containers`);
  assert.ok(classes(SELECTION_EXTRA_ACTION_LABEL_CLASS).includes(`${variant}sr-only`), `${variant} extras icon-only`);
}
assert.ok(classes(SELECTION_EXTRA_ACTION_LABEL_CLASS).some((name) => widthHide.test(name)), "extras hide by width");

const read = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");
const buttonsOf = (source: string) => source.match(/<button\b[\s\S]*?<\/button>/gu) ?? [];

for (const [path, kind] of [
  ["components/ui/SelectionActionBar.tsx", "ACTION"],
  ["components/panels/library/LibrarySelectionExtraActions.tsx", "EXTRA_ACTION"],
  ["components/panels/library/LorebookSelectionEnableActions.tsx", "EXTRA_ACTION"],
] as const) {
  const buttons = buttonsOf(read(path));
  assert.ok(buttons.length >= 2, `${path} renders its action buttons`);
  for (const button of buttons) {
    assert.match(button, new RegExp(`className=\\{(?:cn\\(\\s*)?SELECTION_${kind}_BUTTON_CLASS\\b`, "u"), path);
    assert.match(button, new RegExp(`className=\\{SELECTION_${kind}_LABEL_CLASS\\}`, "u"), `${path}: label class`);
    assert.match(button, /aria-label=\{/u, `${path}: every action button has an aria-label`);
    assert.match(button, /title=\{/u, `${path}: every action button has a title`);
    assert.match(button, /className="shrink-0"/u, `${path}: icons never shrink`);
  }
}

// The Characters panel's own extra (bulk tags) follows the same rule.
const characters = read("components/panels/CharactersPanel.tsx");
const tagsButton = buttonsOf(characters).find((button) => button.includes("characters.bulkTags.actionShort"));
assert.ok(tagsButton, "the bulk tags action exists");
assert.match(tagsButton, /className=\{SELECTION_EXTRA_ACTION_BUTTON_CLASS\}/u);
assert.match(tagsButton, /className=\{SELECTION_EXTRA_ACTION_LABEL_CLASS\}/u);

// No selection bar extra keeps a hand-written copy of the old viewport-only rule.
for (const path of ["components/panels/CharactersPanel.tsx", "components/panels/LorebooksPanel.tsx"]) {
  assert.doesNotMatch(read(path), /truncate max-\[400px\]:sr-only/u, `${path}: uses the shared label classes`);
}

console.log("selection-action-bar-compact regression passed");
