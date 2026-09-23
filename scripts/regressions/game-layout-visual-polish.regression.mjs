import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Edit layout chrome: text on the accent fill must use the theme's primary foreground
// (white on the default pink accent is about 3.5:1, below AA for 12px text), and menu
// popovers must be clamped inside the viewport.
const read = (file) => readFileSync(resolve("packages/client/src/components/game", file), "utf8");

const toolbar = read("GameLayoutEditToolbar.tsx");
const panel = read("FloatingGamePanel.tsx");
const popover = read("GameLayoutPopover.tsx");

for (const [name, source] of [
  ["GameLayoutEditToolbar.tsx", toolbar],
  ["FloatingGamePanel.tsx", panel],
]) {
  for (const line of source.split("\n")) {
    if (/chrome-accent\)\]|EDIT_ACCENT|data-panel-size-badge/.test(line) && /\btext-white\b/.test(line)) {
      assert.fail(`${name}: white text on the accent fill: ${line.trim()}`);
    }
  }
}
assert.match(toolbar, /data-layout-tool="done"[\s\S]{0,400}text-\[var\(--primary-foreground\)\]/);
assert.match(panel, /tabular-nums text-\[var\(--primary-foreground\)\]/);

// Row action icons in the menus share one size.
assert.doesNotMatch(toolbar, /size=\{11\}|size=\{13\}/);

// Popover opened below its anchor is pulled back up so its bottom stays on screen.
assert.match(popover, /window\.innerHeight - margin - Math\.min\(height, maxHeight\)/);

console.log("game-layout-visual-polish regression passed");
