// Shared-message HTML may include author-supplied inline styles and <style>
// blocks. Keep that CSS useful, but prevent it from escaping the message box.

import postcss, { type AtRule, type Node, type Rule } from "postcss";

const STRING_OR_ESCAPE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\\(?:[0-9a-fA-F]{1,6}\s?|[\s\S])/g;
const SAFE_POSITION_VALUES = new Set([
  "absolute",
  "inherit",
  "initial",
  "relative",
  "revert",
  "revert-layer",
  "static",
  "unset",
]);
const GLOBAL_AT_RULES = new Set([
  "charset",
  "color-profile",
  "counter-style",
  "custom-media",
  "custom-selector",
  "font-feature-values",
  "font-palette-values",
  "function",
  "page",
  "position-try",
  "view-transition",
]);

/** Remove CSS comments without treating comment-like text inside strings as syntax. */
function stripCssComments(css: string): string {
  let result = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < css.length; index += 1) {
    const char = css[index]!;
    const next = css[index + 1];
    if (quote) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      continue;
    }
    if (char !== "/" || next !== "*") {
      result += char;
      continue;
    }

    // A comment separates CSS tokens, so preserve one space while dropping its
    // contents. This keeps the browser and sanitizer token boundaries aligned.
    result += " ";
    index += 2;
    while (index < css.length && !(css[index] === "*" && css[index + 1] === "/")) index += 1;
    if (index < css.length) index += 1;
  }

  return result;
}

/** Decode CSS escape sequences (`\XX` hex, `\c` literal) to browser-parsed characters. */
function decodeCssEscapes(input: string): string {
  return input.replace(
    /\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g,
    (_match, hex: string | undefined, char: string | undefined) => {
      if (hex) {
        const codePoint = parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "";
      }
      return char ?? "";
    },
  );
}

function canonicalizeKeywordEscapes(css: string): string {
  return css.replace(STRING_OR_ESCAPE, (match: string, stringLiteral: string | undefined) => {
    if (stringLiteral !== undefined) return stringLiteral;
    const decoded = decodeCssEscapes(match);
    return /^[-A-Za-z@]$/.test(decoded) ? decoded : match;
  });
}

function isCssNameCharacter(char: string | undefined): boolean {
  return char !== undefined && /[-_0-9A-Za-z\\\u0080-\uFFFF]/u.test(char);
}

function findAtRuleEnd(css: string, startIndex: number): number {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let parenthesisDepth = 0;
  let blockDepth = 0;

  for (let index = startIndex; index < css.length; index += 1) {
    const char = css[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(") parenthesisDepth += 1;
    else if (char === ")" && parenthesisDepth > 0) parenthesisDepth -= 1;
    else if (parenthesisDepth === 0 && char === "{") blockDepth += 1;
    else if (parenthesisDepth === 0 && char === "}" && blockDepth > 0) {
      blockDepth -= 1;
      if (blockDepth === 0) return index + 1;
    } else if (parenthesisDepth === 0 && blockDepth === 0 && char === ";") {
      return index + 1;
    }
  }

  return css.length;
}

/** Remove document-global at-rules while retaining conditional and namespaced message-local rules. */
function stripGlobalAtRules(css: string): string {
  let result = "";
  let cursor = 0;
  let index = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  while (index < css.length) {
    const char = css[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char !== "@") {
      index += 1;
      continue;
    }

    const nameMatch = /^@([-A-Za-z]+)/u.exec(css.slice(index));
    const name = nameMatch?.[1]?.toLowerCase();
    if (!name || !GLOBAL_AT_RULES.has(name)) {
      index += 1;
      continue;
    }

    result += `${css.slice(cursor, index)} `;
    index = findAtRuleEnd(css, index + name.length + 1);
    cursor = index;
  }

  return result + css.slice(cursor);
}

function hashCssScope(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function replaceCssIdentifier(input: string, identifier: string, replacement: string, flags = "g"): string {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return input.replace(new RegExp(`(^|[^-_A-Za-z0-9])${escaped}(?=$|[^-_A-Za-z0-9])`, flags), `$1${replacement}`);
}

/** Namespace the global names that CSS requires for otherwise message-local animations and fonts. */
function namespaceMessageCssGlobals(css: string, scopeSelector: string): string {
  const salt = hashCssScope(`${scopeSelector}\\0${css}`);
  const animationNames = new Map<string, string>();
  const fontNames = new Map<string, string>();
  const propertyNames = new Map<string, string>();
  try {
    const root = postcss.parse(css, { from: undefined });
    root.walkAtRules((atRule) => {
      const ruleName = atRule.name.toLowerCase();
      if (ruleName === "keyframes" || ruleName === "-webkit-keyframes") {
        const name = atRule.params.trim();
        if (!/^[-_A-Za-z][-_A-Za-z0-9]*$/u.test(name)) {
          atRule.remove();
          return;
        }
        const replacement = `mari-msg-${salt}-${name}`;
        animationNames.set(name, replacement);
        atRule.params = replacement;
        return;
      }
      if (ruleName === "property") {
        const name = atRule.params.trim();
        if (!/^--[-_A-Za-z0-9]+$/u.test(name)) {
          atRule.remove();
          return;
        }
        const replacement = `--mari-msg-${salt}-${name.slice(2)}`;
        propertyNames.set(name, replacement);
        atRule.params = replacement;
        return;
      }
      if (ruleName === "layer") {
        const name = atRule.params.trim();
        if (!atRule.nodes) {
          atRule.remove();
          return;
        }
        if (!name) return; // Anonymous layers do not create a document-global name.
        if (!/^[-_A-Za-z][-_A-Za-z0-9]*(?:\.[-_A-Za-z][-_A-Za-z0-9]*)*$/u.test(name)) {
          atRule.remove();
          return;
        }
        atRule.params = `mari-msg-layer-${salt}-${hashCssScope(name)}`;
        return;
      }
      if (ruleName !== "font-face") return;
      const families = atRule.nodes?.filter(
        (node): node is Extract<typeof node, { type: "decl" }> =>
          node.type === "decl" && node.prop.toLowerCase() === "font-family",
      );
      if (!families?.length) {
        atRule.remove();
        return;
      }
      for (const declaration of families) {
        const quoted = /^(?:"([^"]+)"|'([^']+)')$/u.exec(declaration.value.trim());
        const name = (quoted?.[1] ?? quoted?.[2] ?? declaration.value.trim()).trim();
        if (!name) {
          atRule.remove();
          return;
        }
        const replacement = `mari-msg-font-${salt}-${hashCssScope(name.toLowerCase())}`;
        fontNames.set(name.toLowerCase(), replacement);
        declaration.value = `"${replacement}"`;
      }
    });
    root.walkDecls((declaration) => {
      let value = declaration.value;
      const property = declaration.prop.toLowerCase();
      if (property === "animation" || property === "animation-name" || property.startsWith("--")) {
        for (const [name, replacement] of animationNames) value = replaceCssIdentifier(value, name, replacement);
      }
      if (property === "font" || property === "font-family" || property.startsWith("--")) {
        const orderedFontNames = [...fontNames].sort(([left], [right]) => right.length - left.length);
        for (const [name, replacement] of orderedFontNames) {
          const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          value = value.replace(new RegExp(`(['"])${escaped}\\1`, "gi"), `"${replacement}"`);
          value = replaceCssIdentifier(value, name, `"${replacement}"`, "gi");
        }
      }
      for (const [name, replacement] of propertyNames) value = replaceCssIdentifier(value, name, replacement);
      declaration.value = value;
      for (const [name, replacement] of propertyNames) {
        declaration.prop = replaceCssIdentifier(declaration.prop, name, replacement);
      }
    });
    return root.toString();
  } catch {
    return "";
  }
}

const CONDITIONAL_AT_RULES = new Set(["container", "layer", "media", "scope", "starting-style", "supports"]);
const PRESERVED_GLOBAL_AT_RULES = new Set(["font-face", "keyframes", "property", "-webkit-keyframes"]);

function isInsideGlobalRule(node: Rule): boolean {
  for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && PRESERVED_GLOBAL_AT_RULES.has((parent as AtRule).name.toLowerCase())) return true;
  }
  return false;
}

function isNestedRule(node: Rule): boolean {
  for (let parent: Node | undefined = node.parent; parent; parent = parent.parent) {
    if (parent.type === "rule") return true;
  }
  return false;
}

/** Parse complete rules so browser error recovery can never expose an unscoped selector. */
function scopeCssRuleList(css: string, scopeSelector: string): string {
  try {
    const root = postcss.parse(css, { from: undefined });
    root.walkAtRules((atRule) => {
      const name = atRule.name.toLowerCase();
      if (!atRule.nodes && CONDITIONAL_AT_RULES.has(name)) {
        atRule.remove();
        return;
      }
      if (!PRESERVED_GLOBAL_AT_RULES.has(name) && !CONDITIONAL_AT_RULES.has(name)) atRule.remove();
    });
    root.walkDecls((declaration) => {
      if (declaration.parent?.type === "root") declaration.remove();
    });
    root.walkRules((rule) => {
      if (isInsideGlobalRule(rule)) return;
      if (isNestedRule(rule)) {
        // Native nesting can select outside its parent through `&`, root
        // selectors, or relative combinators. Authors can express the same
        // styling as an ordinary selector, which this scoper contains safely.
        rule.remove();
        return;
      }
      rule.selectors = rule.selectors.map((selector) => {
        const trimmed = selector.trim();
        if (trimmed === ":root" || trimmed === "html" || trimmed === "body") return scopeSelector;
        return `${scopeSelector} ${trimmed}`;
      });
    });
    return root.toString();
  } catch {
    return ""; // Malformed author CSS is safer to omit than to let the browser recover globally.
  }
}

/** Strip statement at-rules through their terminating semicolon, respecting strings and functions. */
function stripForbiddenStatementAtRules(css: string): string {
  let result = "";
  let cursor = 0;
  let index = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let parenthesisDepth = 0;

  while (index < css.length) {
    const char = css[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "(") {
      parenthesisDepth += 1;
      index += 1;
      continue;
    }
    if (char === ")" && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
      index += 1;
      continue;
    }

    const lower = parenthesisDepth === 0 ? css.slice(index, index + 10).toLowerCase() : "";
    const keyword = lower.startsWith("@import") ? "@import" : lower.startsWith("@namespace") ? "@namespace" : null;
    if (!keyword || isCssNameCharacter(css[index + keyword.length])) {
      index += 1;
      continue;
    }

    result += `${css.slice(cursor, index)} `;
    index += keyword.length;
    let depth = 0;
    let statementQuote: '"' | "'" | null = null;
    let statementEscaped = false;
    while (index < css.length) {
      const statementChar = css[index]!;
      if (statementQuote) {
        if (statementEscaped) statementEscaped = false;
        else if (statementChar === "\\") statementEscaped = true;
        else if (statementChar === statementQuote) statementQuote = null;
      } else if (statementChar === '"' || statementChar === "'") {
        statementQuote = statementChar;
      } else if (statementChar === "(") {
        depth += 1;
      } else if (statementChar === ")" && depth > 0) {
        depth -= 1;
      } else if (statementChar === ";" && depth === 0) {
        index += 1;
        break;
      }
      index += 1;
    }
    cursor = index;
  }

  return result + css.slice(cursor);
}

function sanitizePositionDeclarations(css: string): string {
  return css.replace(
    /(^|[;{])(\s*)position\s*:\s*([^;}]*)/gim,
    (_match, boundary: string, spacing: string, rawValue: string) => {
      const value = rawValue
        .replace(/!important/gi, "")
        .trim()
        .toLowerCase();
      const safeValue =
        value === "fixed" || value === "sticky" ? "absolute" : SAFE_POSITION_VALUES.has(value) ? value : "static";
      return `${boundary}${spacing}position:${safeValue}`;
    },
  );
}

export function sanitizeChatMessageCss(css: string): string {
  let sanitized = canonicalizeKeywordEscapes(stripCssComments(css));
  sanitized = stripGlobalAtRules(stripForbiddenStatementAtRules(sanitized))
    .replace(/expression\s*\([^)]*\)/gi, " ")
    .replace(/javascript\s*:/gi, " ")
    .replace(/vbscript\s*:/gi, " ")
    .replace(/behavior\s*:/gi, "x-behavior:")
    .replace(/-moz-binding\s*:/gi, "x-moz-binding:")
    .replace(/url\s*\(\s*(?!['"]?(?:data:image\/|https?:\/\/))(['"]?)[^)]+\)/gi, "none")
    .replace(/!important/gi, " ")
    .replace(/(?<![-\w])content\s*:[^;}]*/gi, " ")
    .replace(/</g, "\\3c ");
  return sanitizePositionDeclarations(sanitized).trim();
}

export function scopeChatMessageCss(css: string, scopeSelector: string): string {
  const sanitized = namespaceMessageCssGlobals(sanitizeChatMessageCss(css), scopeSelector);
  if (!sanitized) return "";
  return scopeCssRuleList(sanitized, scopeSelector).trim();
}
