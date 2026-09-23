import assert from "node:assert/strict";
import { convertChatHtmlNewlines } from "../../packages/client/src/lib/chat-html-newlines.js";

const lineBreak = '<br style="display:block;margin:0.2em 0">';

assert.equal(
  convertChatHtmlNewlines('<span style="color: #F8BBD0">"Hi."</span>\n<span style="color: #FFF59D">"Hello."</span>'),
  `<span style="color: #F8BBD0">"Hi."</span>${lineBreak}<span style="color: #FFF59D">"Hello."</span>`,
  "adjacent inline siblings should keep an intentional visual line break",
);

assert.equal(
  convertChatHtmlNewlines("<div>\n  <span>Nested</span>\n</div>\n<p>Next block</p>"),
  "<div><span>Nested</span></div><p>Next block</p>",
  "pretty-printed block and nested markup should not gain visual gaps",
);

assert.equal(
  convertChatHtmlNewlines("<strong>First</strong>\r\n\t<em>Second</em>"),
  `<strong>First</strong>${lineBreak}<em>Second</em>`,
  "CRLF and indentation should preserve a single inline-sibling break",
);

assert.equal(
  convertChatHtmlNewlines('<img src="/portrait.png" alt="Portrait">\n<span>Caption</span>'),
  `<img src="/portrait.png" alt="Portrait">${lineBreak}<span>Caption</span>`,
  "void inline siblings should also keep an intentional visual line break",
);

const svg = '<svg viewBox="0 0 10 10">\n<path d="M0 0 L10 10" />\n</svg>';
assert.equal(convertChatHtmlNewlines(svg), svg, "SVG newlines must remain untouched");

const multilineAttribute = '<span style="color: red;\nfont-weight: bold">Text</span>';
assert.equal(
  convertChatHtmlNewlines(multilineAttribute),
  multilineAttribute,
  "newlines inside quoted attributes must remain untouched",
);

assert.equal(
  convertChatHtmlNewlines("First line\nSecond line"),
  `First line${lineBreak}Second line`,
  "ordinary authored newlines should continue to render as breaks",
);

console.log("Chat HTML newline regression passed");
