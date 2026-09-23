import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sanitizeChatMessageCss, scopeChatMessageCss } from "../../packages/client/src/lib/chat-message-css.js";

const importedCss = sanitizeChatMessageCss(`
  @import/* separator */url("https://example.invalid/theme.css");
  @import url("data:text/css;charset=utf-8,a;b");
  .safe { background-image: url("https://example.invalid/image.png"); }
`);
assert.doesNotMatch(importedCss, /@import/iu, "shared-message CSS cannot retain imported stylesheets");
assert.match(
  importedCss,
  /background-image:\s*url\("https:\/\/example\.invalid\/image\.png"\)/u,
  "ordinary HTTPS image styling remains available",
);

const positionedCss = sanitizeChatMessageCss(`
  .indirect { --message-position: fixed; position: var(--message-position); }
  .fixed { position: sticky !important; }
  .safe { position: relative; background-position: fixed; }
`);
assert.match(positionedCss, /\.indirect\s*\{[^}]*position:static/u, "indirect position values are neutralized");
assert.match(
  positionedCss,
  /\.fixed\s*\{[^}]*position:absolute/u,
  "viewport positions remain usable inside the message box",
);
assert.match(positionedCss, /\.safe\s*\{[^}]*position:relative/u, "safe positioning remains available");
assert.match(positionedCss, /background-position:\s*fixed/u, "unrelated position properties are not rewritten");

const contentCss = sanitizeChatMessageCss(`
  .layout { align-content: center; justify-content: space-between; place-content: stretch; }
  .label::before { content: "Untrusted label"; }
`);
assert.match(contentCss, /align-content:\s*center/u, "align-content remains available");
assert.match(contentCss, /justify-content:\s*space-between/u, "justify-content remains available");
assert.match(contentCss, /place-content:\s*stretch/u, "place-content remains available");
assert.doesNotMatch(contentCss, /(?<![-\w])content\s*:/iu, "standalone content declarations remain blocked");

const quotedComment = sanitizeChatMessageCss('[data-label="/* literal */"] { color: red; }');
assert.match(quotedComment, /"\/\* literal \*\/"/u, "comment-like text inside strings remains intact");

const reconstructedStyleTag = sanitizeChatMessageCss("<sty<style>le>.safe { color: red; }</sty</style>le>");
assert.doesNotMatch(reconstructedStyleTag, /</u, "tag-like text cannot reconstruct an HTML style element");
assert.match(reconstructedStyleTag, /\\3c /u, "literal angle brackets retain their CSS meaning through escaping");

for (const reconstructingImport of [
  '@imexpression(x)port url("https://example.invalid/expression.css"); .safe { color: red; }',
  '@im@import url("https://example.invalid/nested.css");port url("https://example.invalid/outer.css"); .safe { color: red; }',
]) {
  const reconstructedCss = sanitizeChatMessageCss(reconstructingImport);
  assert.doesNotMatch(reconstructedCss, /@import\b/iu, "removed syntax cannot concatenate into an import rule");
  assert.match(reconstructedCss, /\.safe\s*\{/u, "safe CSS after a rejected import remains available");
}

const scopedCss = scopeChatMessageCss(
  '@namespace svg url("https://example.invalid/ns"); .safe { color: red; }',
  ".message-scope",
);
assert.doesNotMatch(scopedCss, /@namespace/iu, "shared-message CSS cannot retain external namespaces");
assert.match(scopedCss, /\.message-scope \.safe\s*\{/u, "ordinary message selectors remain scoped");

const globalCss = scopeChatMessageCss(
  `
    @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
    @font-face { font-family: "Story Font"; src: url("https://example.invalid/story.woff2"); }
    @property --glow { syntax: "<color>"; inherits: false; initial-value: red; }
    @page { margin: 0; }
    @counter-style app-counter { system: numeric; symbols: "X"; }
    .animated { animation: 1s pulse; font-family: "Story Font"; color: var(--glow); }
  `,
  ".message-scope",
);
assert.doesNotMatch(globalCss, /@(?:page|counter-style)\b/iu, "document-global rules cannot affect the app");
assert.doesNotMatch(globalCss, /@keyframes\s+pulse\b/iu, "message keyframe names cannot collide with app animations");
assert.match(globalCss, /@keyframes\s+mari-msg-[\w-]+-pulse\b/iu, "message animations remain available by namespace");
assert.match(globalCss, /animation:\s*1s\s+mari-msg-[\w-]+-pulse/iu, "animation references use the namespace");
assert.doesNotMatch(globalCss, /font-family:\s*"Story Font"/iu, "message fonts cannot override an app family");
assert.match(globalCss, /font-family:\s*"mari-msg-font-[^"]+"/iu, "message fonts remain available by namespace");
assert.doesNotMatch(globalCss, /@property\s+--glow\b/iu, "registered properties cannot collide with app properties");
assert.match(
  globalCss,
  /var\(--mari-msg-[\w-]+-glow\)/iu,
  "registered custom properties remain available by namespace",
);

const conditionalCss = scopeChatMessageCss(
  `
    @media (min-width: 1px) { .inside:is(.wide, .narrow), [data-label="a,b"] { color: red; } }
    @layer attacker, base;
    @layer cards { .outer { & + .outside { color: green; } :is(&, body) .outside { color: blue; } } }
    .after { color: rgb(4, 5, 6); }
  `,
  ".message-scope",
);
assert.match(
  conditionalCss,
  /@media[^{}]*\{\s*\.message-scope \.inside:is\(\.wide, \.narrow\), \.message-scope \[data-label="a,b"\]\s*\{/u,
  "conditional rules and selector-list commas remain available inside the message scope",
);
assert.match(
  conditionalCss,
  /\}\s*\.message-scope \.after\s*\{/u,
  "a selector following a retained at-rule cannot escape the message scope",
);
assert.doesNotMatch(conditionalCss, /\}\s*\.after\s*\{/u, "an at-rule closing brace cannot expose a global selector");
assert.doesNotMatch(conditionalCss, /@layer\s+attacker/u, "statement layers cannot reorder the app's cascade");
assert.match(conditionalCss, /@layer\s+mari-msg-layer-[\w-]+\s*\{/u, "named message layers remain usable by namespace");
assert.match(conditionalCss, /\.message-scope \.outer\s*\{\s*\}/u, "the safely scoped parent rule remains available");
assert.doesNotMatch(conditionalCss, /&|:is\([^)]*body|\.outside/u, "nested rules cannot select outside the message");

const malformedBraceCss = scopeChatMessageCss(
  ".inside { color: red; }} .after-malformed { color: blue; }",
  ".message-scope",
);
assert.equal(malformedBraceCss, "", "malformed CSS fails closed instead of relying on browser error recovery");
assert.doesNotMatch(malformedBraceCss, /\}\s*\.after-malformed\s*\{/u);

const indirectGlobalCss = scopeChatMessageCss(
  `
    @keyframes pulse { from { opacity: 0; } }
    @font-face { font-family: "Story Font"; src: url("https://example.invalid/story.woff2"); }
    .indirect { --animation-name: pulse; --font-name: "Story Font"; animation-name: var(--animation-name); font-family: var(--font-name); }
  `,
  ".message-scope",
);
assert.match(indirectGlobalCss, /--animation-name:\s*mari-msg-[\w-]+-pulse/u, "indirect animations remain usable");
assert.match(indirectGlobalCss, /--font-name:\s*"mari-msg-font-[^"]+"/u, "indirect custom fonts remain usable");

const rejectedGlobalIdentifiers = scopeChatMessageCss(
  `
    @keyframes "app-spin" { from { opacity: 0; } }
    @keyframes évil { from { opacity: 0; } }
    @keyframes \\31 app { from { opacity: 0; } }
    @property --évil { syntax: "<color>"; inherits: false; initial-value: red; }
    @property --app\\5f color { syntax: "<color>"; inherits: false; initial-value: red; }
    @font-face { font-family: "Harmless"; font-family: "Inter"; src: local("}"); }
  `,
  ".message-scope",
);
assert.doesNotMatch(rejectedGlobalIdentifiers, /@keyframes\s+(?:"app-spin"|évil|\\31 app)/u);
assert.doesNotMatch(rejectedGlobalIdentifiers, /@property\s+(?:--évil|--app\\5f color)/u);
assert.doesNotMatch(rejectedGlobalIdentifiers, /font-family:\s*"(?:Harmless|Inter)"/u);
assert.match(
  rejectedGlobalIdentifiers,
  /font-family:\s*"mari-msg-font-[^"]+"/u,
  "every effective font-face family is namespaced even with duplicate declarations and brace-like strings",
);

const chatMessageSource = readFileSync(
  new URL("../../packages/client/src/components/chat/ChatMessage.tsx", import.meta.url),
  "utf8",
);
assert.match(
  chatMessageSource,
  /relative !overflow-hidden !contain-paint/u,
  "the rendered message box enforces clipping and a fixed-position containing block",
);

console.info("Chat message CSS security regressions passed.");
