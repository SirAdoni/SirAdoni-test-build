const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function isAsciiWordCode(code: number) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || code === 95 || (code >= 97 && code <= 122);
}

function matchesAsciiCaseInsensitive(value: string, index: number, expected: string) {
  if (index + expected.length > value.length) return false;
  for (let offset = 0; offset < expected.length; offset += 1) {
    const code = value.charCodeAt(index + offset);
    const normalized = code >= 65 && code <= 90 ? code + 32 : code;
    if (normalized !== expected.charCodeAt(offset)) return false;
  }
  return true;
}

function findTagPrefix(value: string, prefix: string, from: number) {
  const lastStart = value.length - prefix.length;
  for (let index = from; index <= lastStart; index += 1) {
    if (value.charCodeAt(index) !== 60 || !matchesAsciiCaseInsensitive(value, index, prefix)) continue;
    if (!isAsciiWordCode(value.charCodeAt(index + prefix.length))) return index;
  }
  return -1;
}

function stripRawTextElement(value: string, tagName: "script" | "style") {
  const openingPrefix = `<${tagName}`;
  const closingPrefix = `</${tagName}`;
  const chunks: string[] = [];
  let outputCursor = 0;
  let searchCursor = 0;

  while (searchCursor < value.length) {
    const openingStart = findTagPrefix(value, openingPrefix, searchCursor);
    if (openingStart < 0) break;
    const openingEnd = value.indexOf(">", openingStart + openingPrefix.length);
    if (openingEnd < 0) break;

    const closingStart = findTagPrefix(value, closingPrefix, openingEnd + 1);
    if (closingStart < 0) {
      chunks.push(value.slice(outputCursor, openingStart));
      return chunks.join("");
    }
    const closingEnd = value.indexOf(">", closingStart + closingPrefix.length);
    if (closingEnd < 0) {
      chunks.push(value.slice(outputCursor, openingStart));
      return chunks.join("");
    }

    chunks.push(value.slice(outputCursor, openingStart), " ");
    outputCursor = closingEnd + 1;
    searchCursor = outputCursor;
  }

  chunks.push(value.slice(outputCursor));
  return chunks.join("");
}

function replaceHtmlTags(value: string) {
  const chunks: string[] = [];
  let outputCursor = 0;
  let searchCursor = 0;

  while (searchCursor < value.length) {
    const start = value.indexOf("<", searchCursor);
    if (start < 0) break;
    const end = value.indexOf(">", start + 1);
    if (end < 0) break;
    if (end === start + 1) {
      searchCursor = end + 1;
      continue;
    }
    chunks.push(value.slice(outputCursor, start), " ");
    outputCursor = end + 1;
    searchCursor = outputCursor;
  }

  chunks.push(value.slice(outputCursor));
  return chunks.join("");
}

export function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return ENTITY_MAP[normalized] ?? match;
  });
}

export function stripHtml(value: string) {
  const withoutRawText = stripRawTextElement(stripRawTextElement(value, "script"), "style");
  return decodeHtmlEntities(
    replaceHtmlTags(
      withoutRawText
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|section|article|aside|h[1-6]|tr|table|ul|ol)>/gi, "\n")
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/\r/g, ""),
    ),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanSnippet(value: unknown) {
  return typeof value === "string" ? stripHtml(value).replace(/\s+/g, " ").trim() : undefined;
}
