// ──────────────────────────────────────────────
// Readable transcript documents: Markdown and a standalone HTML story
// ──────────────────────────────────────────────

export interface TranscriptDocumentEntry {
  /** Stable key for avatar lookup and color assignment. */
  speakerKey: string;
  speaker: string;
  role: string;
  content: string;
  createdAt?: string | null;
  thinking?: string | null;
  /** A user-marked chapter starts at this entry; exports render it as a heading. */
  chapter?: TranscriptChapter | null;
}

export interface TranscriptChapter {
  title: string;
  summary?: string | null;
}

export interface TranscriptDocumentInput {
  title: string;
  entries: TranscriptDocumentEntry[];
  /** Optional data: URIs keyed by speakerKey. Anything else is ignored. */
  avatars?: ReadonlyMap<string, string>;
  /** Formats dates for the header and message stamps; defaults to ISO-like strings. */
  formatDate?: (iso: string) => string;
  generatedAt?: string;
}

/** Hidden, system and empty turns are left out of readable documents. */
export interface TranscriptVisibilityInput {
  role: string;
  content: string;
  extra: Record<string, unknown>;
}

export function isStoryTranscriptMessage(message: TranscriptVisibilityInput): boolean {
  if (message.role === "system") return false;
  if (!message.content.trim()) return false;
  const { extra } = message;
  return extra.hiddenFromUser !== true && extra.commandOnly !== true && extra.roleplayPrivateOnly !== true;
}

function defaultFormatDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toISOString().slice(0, 16).replace("T", " ");
}

function formatDay(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : iso;
}

/** "2026-01-02 to 2026-02-03", or a single day, from the first and last dated entries. */
export function describeTranscriptDateRange(entries: readonly TranscriptDocumentEntry[]): string {
  const times = entries
    .map((entry) => (entry.createdAt ? Date.parse(entry.createdAt) : Number.NaN))
    .filter((time) => Number.isFinite(time));
  if (times.length === 0) return "";
  let first = times[0]!;
  let last = times[0]!;
  for (const time of times) {
    if (time < first) first = time;
    if (time > last) last = time;
  }
  const start = formatDay(new Date(first).toISOString());
  const end = formatDay(new Date(last).toISOString());
  return start === end ? start : `${start} to ${end}`;
}

/** Chapters of the document in reading order, with the anchor id each HTML heading gets. */
export function listTranscriptChapters(
  entries: readonly TranscriptDocumentEntry[],
): Array<{ id: string; index: number; chapter: TranscriptChapter }> {
  const out: Array<{ id: string; index: number; chapter: TranscriptChapter }> = [];
  entries.forEach((entry, index) => {
    const title = entry.chapter?.title?.trim();
    if (title) out.push({ id: `chapter-${out.length + 1}`, index, chapter: { ...entry.chapter, title } });
  });
  return out;
}

// ── Markdown ──

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_[\]#<>|])/gu, "\\$1");
}

export function renderTranscriptMarkdown(input: TranscriptDocumentInput): string {
  const range = describeTranscriptDateRange(input.entries);
  const lines: string[] = [`# ${escapeMarkdownInline(input.title.trim() || "Chat")}`, ""];
  if (range) lines.push(`_${range}_`, "");
  lines.push("---", "");
  const chapterAt = new Map(listTranscriptChapters(input.entries).map((item) => [item.index, item.chapter]));
  input.entries.forEach((entry, index) => {
    const chapter = chapterAt.get(index);
    if (chapter) {
      lines.push(`## ${escapeMarkdownInline(chapter.title)}`, "");
      if (chapter.summary?.trim())
        lines.push(`_${escapeMarkdownInline(chapter.summary.trim().replace(/\s+/gu, " "))}_`, "");
    }
    lines.push(`### ${escapeMarkdownInline(entry.speaker)}`, "");
    lines.push(entry.content.trim(), "");
    if (entry.thinking?.trim()) {
      // A literal closing tag inside the reasoning would end the block early and spill the rest into the story.
      const thinking = entry.thinking.trim().replace(/<\/(details|summary)\s*>/giu, "&lt;/$1&gt;");
      lines.push("<details><summary>Thinking</summary>", "", thinking, "", "</details>", "");
    }
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

// ── HTML ──

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/** Escapes first, then applies a small safe subset of Markdown emphasis. */
export function renderStoryInline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/gu, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/gu, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/gu, "$1<em>$2</em>");
}

function renderStoryBody(content: string): string {
  return content
    .replace(/\r\n?/gu, "\n")
    .trim()
    .split(/\n{2,}/u)
    .map((paragraph) => `<p>${paragraph.split("\n").map(renderStoryInline).join("<br>")}</p>`)
    .join("");
}

const SAFE_AVATAR_URI = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/u;

function speakerHue(key: string): number {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  return hash % 360;
}

function initialOf(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toLocaleUpperCase() : "?";
}

const STORY_CSS = `
:root{color-scheme:light dark;--bg:#faf8f5;--paper:#fff;--ink:#1f1d1a;--muted:#6b665e;--line:#e6e1d8;--user:#f2efe9;--accent:#8a5a2b}
@media (prefers-color-scheme:dark){:root{--bg:#141312;--paper:#1c1b19;--ink:#ece8e1;--muted:#a39d93;--line:#34312d;--user:#24221f;--accent:#e0a868}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.65 Georgia,"Iowan Old Style","Palatino Linotype",serif}
main{max-width:46rem;margin:0 auto;padding:3rem 1.25rem 4rem}
header{border-bottom:1px solid var(--line);margin-bottom:2rem;padding-bottom:1.25rem}
h1{font-size:2rem;line-height:1.2;margin:0 0 .35rem;font-weight:600}
.range{color:var(--muted);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0}
.turn{display:flex;gap:.9rem;padding:1rem 0;border-bottom:1px solid var(--line);break-inside:avoid;page-break-inside:avoid}
.turn:last-child{border-bottom:0}
.turn.user .text{background:var(--user);border-radius:.6rem;padding:.6rem .85rem}
.avatar{flex:0 0 2.5rem;width:2.5rem;height:2.5rem;border-radius:50%;object-fit:cover;display:flex;align-items:center;justify-content:center;font:600 1rem/1 system-ui,sans-serif;color:#fff}
.body{min-width:0;flex:1}
.meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:.5rem;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;margin-bottom:.3rem}
.name{font-weight:650;color:var(--accent)}
.time{color:var(--muted)}
.text p{margin:0 0 .75rem;overflow-wrap:anywhere}
.text p:last-child{margin-bottom:0}
.turn.narrator .text{font-style:italic}
code{font:.9em ui-monospace,Consolas,monospace;background:var(--user);padding:0 .25em;border-radius:.25em}
details{margin-top:.5rem;color:var(--muted);font-size:.9em}
.toc{margin:0 0 2rem;padding:1rem 1.25rem;border:1px solid var(--line);border-radius:.6rem;background:var(--paper);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.toc h2{margin:0 0 .5rem;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.toc ol{margin:0;padding-left:1.4rem}
.toc li{margin:.2rem 0}
.toc a{color:var(--accent);text-decoration:none}
.toc a:hover{text-decoration:underline}
.toc .sum{display:block;color:var(--muted);font-size:13px}
.chapter{margin:2.5rem 0 .25rem;padding-top:1.5rem;border-top:2px solid var(--line);font-size:1.45rem;line-height:1.25;font-weight:600;scroll-margin-top:1rem}
.chapter.lead{margin-top:0;padding-top:0;border-top:0}
.chapter-summary{margin:0 0 .5rem;color:var(--muted);font-style:italic}
footer{margin-top:2.5rem;color:var(--muted);font:12px/1.4 system-ui,sans-serif;text-align:center}
@media (max-width:480px){body{font-size:16px}main{padding:2rem 1rem 3rem}.avatar{flex-basis:2rem;width:2rem;height:2rem}}
@media print{:root{--bg:#fff;--paper:#fff;--ink:#000;--muted:#555;--line:#ccc;--user:#f3f3f3;--accent:#333}body{font-size:12pt}main{max-width:none;padding:0}details{display:none}.chapter{break-after:avoid;page-break-after:avoid}}
`;

export function renderTranscriptHtml(input: TranscriptDocumentInput): string {
  const title = input.title.trim() || "Chat";
  const formatDate = input.formatDate ?? defaultFormatDate;
  const range = describeTranscriptDateRange(input.entries);
  const chapters = listTranscriptChapters(input.entries);
  const chapterAt = new Map(chapters.map((item) => [item.index, item]));
  const toc =
    chapters.length > 0
      ? `<nav class="toc" aria-labelledby="toc-title"><h2 id="toc-title">Contents</h2><ol>${chapters
          .map(
            ({ id, chapter }) =>
              `<li><a href="#${id}">${escapeHtml(chapter.title)}</a>${chapter.summary?.trim() ? `<span class="sum">${escapeHtml(chapter.summary.trim())}</span>` : ""}</li>`,
          )
          .join("")}</ol></nav>\n`
      : "";
  const turns = input.entries
    .map((entry, index) => {
      const chapterItem = chapterAt.get(index);
      const chapterHtml = chapterItem
        ? `<h2 class="chapter${index === 0 ? " lead" : ""}" id="${chapterItem.id}">${escapeHtml(chapterItem.chapter.title)}</h2>${chapterItem.chapter.summary?.trim() ? `<p class="chapter-summary">${escapeHtml(chapterItem.chapter.summary.trim())}</p>` : ""}\n`
        : "";
      const avatar = input.avatars?.get(entry.speakerKey);
      const avatarHtml =
        avatar && SAFE_AVATAR_URI.test(avatar)
          ? `<img class="avatar" src="${avatar}" alt="">`
          : `<div class="avatar" aria-hidden="true" style="background:hsl(${speakerHue(entry.speakerKey)} 45% 45%)">${escapeHtml(initialOf(entry.speaker))}</div>`;
      const time = entry.createdAt
        ? `<time class="time" datetime="${escapeHtml(entry.createdAt)}">${escapeHtml(formatDate(entry.createdAt))}</time>`
        : "";
      const thinking = entry.thinking?.trim()
        ? `<details><summary>Thinking</summary>${renderStoryBody(entry.thinking)}</details>`
        : "";
      const roleClass = ["user", "assistant", "narrator"].includes(entry.role) ? entry.role : "assistant";
      return `${chapterHtml}<article class="turn ${roleClass}">${avatarHtml}<div class="body"><div class="meta"><span class="name">${escapeHtml(entry.speaker)}</span>${time}</div><div class="text">${renderStoryBody(entry.content)}</div>${thinking}</div></article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Marinara Engine">
<title>${escapeHtml(title)}</title>
<style>${STORY_CSS}</style>
</head>
<body>
<main>
<header><h1>${escapeHtml(title)}</h1>${range ? `<p class="range">${escapeHtml(range)}</p>` : ""}</header>
${toc}${turns}
<footer>Exported from Marinara Engine${input.generatedAt ? ` on ${escapeHtml(formatDay(input.generatedAt))}` : ""}</footer>
</main>
</body>
</html>
`;
}
