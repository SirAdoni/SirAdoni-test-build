const CHAT_HTML_LINE_BREAK = '<br style="display:block;margin:0.2em 0">';
const ATTRIBUTE_NEWLINE_PLACEHOLDER = "\x00ATTRNL\x00";

// These are the inline elements accepted by ChatMessage's HTML sanitizer.
// A newline between two sibling inline elements carries layout meaning; block
// elements already establish their own layout and may be separated by source
// formatting without creating an extra visual gap.
const INLINE_CHAT_HTML_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "img",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);

function previousInlineTagName(tag: string): string | null {
  const match = /^<\s*\/\s*([a-z][\w-]*)\s*>$/i.exec(tag);
  const name = match?.[1]?.toLowerCase();
  if (name && INLINE_CHAT_HTML_TAGS.has(name)) return name;

  // Images are void inline elements, so their opening tag is also their
  // complete sibling boundary. A preceding <br> already supplies a break.
  const voidMatch = /^<\s*(img)\b[^>]*>$/i.exec(tag);
  return voidMatch?.[1]?.toLowerCase() ?? null;
}

function openingInlineTagName(tag: string): string | null {
  const match = /^<\s*([a-z][\w-]*)\b[^>]*>$/i.exec(tag);
  const name = match?.[1]?.toLowerCase();
  return name && INLINE_CHAT_HTML_TAGS.has(name) ? name : null;
}

function newlineSeparatesInlineSiblings(previousTag: string, nextTag: string): boolean {
  const previousName = previousInlineTagName(previousTag);
  if (!previousName) return false;
  return openingInlineTagName(nextTag) !== null;
}

/**
 * Convert authored chat-message newlines into HTML breaks without turning
 * pretty-printed block markup into extra blank lines.
 */
export function convertChatHtmlNewlines(html: string): string {
  const attributeProtected = html.replace(
    /(<[^>]*?)("[^"]*"|'[^']*')([^>]*>)/g,
    (_match, before: string, attribute: string, after: string) =>
      before + attribute.replace(/\r?\n/g, ATTRIBUTE_NEWLINE_PLACEHOLDER) + after,
  );

  return attributeProtected
    .replace(
      /(<svg\b[\s\S]*?<\/svg>)|(<[^>]+>)[\t ]*\r?\n(?:[\t ]*\r?\n)*[\t ]*(?=(<[^>]+>))|\r?\n/gi,
      (_match, svgBlock: string | undefined, previousTag: string | undefined, nextTag: string | undefined) => {
        if (svgBlock) return svgBlock;
        if (previousTag && nextTag) {
          const separator = newlineSeparatesInlineSiblings(previousTag, nextTag) ? CHAT_HTML_LINE_BREAK : "";
          return `${previousTag}${separator}`;
        }
        return CHAT_HTML_LINE_BREAK;
      },
    )
    .replace(new RegExp(ATTRIBUTE_NEWLINE_PLACEHOLDER, "g"), "\n");
}
