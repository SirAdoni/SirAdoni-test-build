import assert from "node:assert/strict";

const {
  READER_DEFAULTS,
  READER_LIMITS,
  buildReaderEntries,
  clampPage,
  pageCharsForSettings,
  pageOfEntry,
  paginateReaderEntries,
  parseReaderParagraphs,
  positionForPage,
  readReaderPosition,
  readReaderSettings,
  readerKeyAction,
  readerKeyIsIsolated,
  resolveReaderPage,
  stepReaderSetting,
  toReaderText,
  writeReaderPosition,
  writeReaderSettings,
} = await import("../../packages/client/src/lib/reading-mode.ts");

// ── Text cleanup ──
assert.equal(toReaderText("<think>plan</think><p>Hello&nbsp;there</p><p>Again</p>"), "Hello there\n\nAgain");
assert.equal(toReaderText("<style>.x{}</style>A &amp; B\r\n\r\n\r\n\r\nC"), "A & B\n\nC");
// Numeric entities decode; invalid code points stay as written.
assert.equal(toReaderText("It&#39;s &#x2019; &#8220;fine&#8221; &#0; &#xD800;"), "It's ’ “fine” &#0; &#xD800;");

// ── Entries: active swipe content, hidden rows left out, bookmarks read from extra ──
const messages = [
  { id: "m1", role: "system", characterId: null, content: "setup" },
  {
    id: "m2",
    role: "assistant",
    characterId: "c1",
    content: "The gate creaks open.",
    extra: { bookmark: { label: " Arrival ", createdAt: "x" } },
  },
  {
    id: "m3",
    role: "user",
    characterId: null,
    content: "I step inside.",
    extra: JSON.stringify({ personaSnapshot: { name: "Tamsin" } }),
  },
  { id: "m4", role: "assistant", characterId: "c1", content: "secret", extra: { hiddenFromUser: true } },
  { id: "m5", role: "assistant", characterId: "c1", content: "ooc aside", extra: { hiddenFromAI: true } },
  { id: "m6", role: "narrator", characterId: null, content: "   " },
  { id: "m7", role: "assistant", characterId: "c1", content: "Rain falls.", extra: { bookmark: { createdAt: "y" } } },
];
const names: Record<string, string> = { c1: "Ysolde" };
const entries = buildReaderEntries(messages, {
  resolveSpeaker: (message, extra) =>
    message.role === "user"
      ? String((extra.personaSnapshot as { name?: string } | undefined)?.name ?? "You")
      : (message.characterId && names[message.characterId]) || "Narrator",
});
assert.deepEqual(
  entries.map((entry) => [entry.id, entry.number, entry.speaker, entry.bookmark]),
  [
    ["m2", 2, "Ysolde", "Arrival"],
    ["m3", 3, "Tamsin", null],
    ["m7", 7, "Ysolde", ""],
  ],
);
const withHidden = buildReaderEntries(messages, { resolveSpeaker: () => "x", includeHiddenFromAI: true });
assert.ok(
  withHidden.some((entry) => entry.id === "m5"),
  "hidden-from-AI rows can be opted in",
);

// ── Inline formatting ──
assert.deepEqual(parseReaderParagraphs("She said **no** and *left*.\n\nsnake_case stays _as is_"), [
  [{ text: "She said " }, { text: "no", strong: true }, { text: " and " }, { text: "left", em: true }, { text: "." }],
  [{ text: "snake_case stays " }, { text: "as is", em: true }],
]);

// ── Pagination ──
const text = (length: number) => "a".repeat(length);
const plain = [text(420), text(420), text(420), text(2000), text(10)].map((value) => ({ text: value, bookmark: null }));
// Each entry weighs its length + 80.
assert.deepEqual(paginateReaderEntries(plain, 1000), [
  { start: 0, end: 2 },
  { start: 2, end: 3 },
  { start: 3, end: 4 },
  { start: 4, end: 5 },
]);
assert.deepEqual(paginateReaderEntries([], 1000), []);
const chaptered = [
  { text: "a", bookmark: null },
  { text: "b", bookmark: "Part two" },
  { text: "c", bookmark: "" },
  { text: "d", bookmark: null },
];
assert.deepEqual(
  paginateReaderEntries(chaptered, 10_000),
  [
    { start: 0, end: 1 },
    { start: 1, end: 4 },
  ],
  "a labeled bookmark starts a page, an unlabeled one does not",
);
assert.equal(pageCharsForSettings(READER_DEFAULTS), 6000);
assert.ok(pageCharsForSettings({ fontSize: 30, lineWidth: 40 }) >= 1500);
assert.ok(pageCharsForSettings({ fontSize: 13, lineWidth: 100 }) <= 16000);
assert.ok(pageCharsForSettings({ fontSize: 24, lineWidth: 68 }) < 6000, "bigger text means fewer characters per page");

const pages = [
  { start: 0, end: 2 },
  { start: 2, end: 4 },
];
assert.equal(pageOfEntry(pages, 3), 1);
assert.equal(pageOfEntry(pages, 99), 1);
assert.equal(pageOfEntry(pages, -1), 0);
assert.equal(pageOfEntry([], 2), 0);
assert.equal(clampPage(5, 2), 1);
assert.equal(clampPage(-3, 2), 0);
assert.equal(clampPage(Number.NaN, 2), 0);
assert.equal(clampPage(1, 0), 0);

// ── Saved position ──
const posEntries = [
  { id: "a", number: 1 },
  { id: "b", number: 3 },
  { id: "c", number: 6 },
  { id: "d", number: 9 },
];
assert.equal(resolveReaderPage(posEntries, pages, null), 0);
assert.equal(resolveReaderPage(posEntries, pages, { messageId: "c", number: 6 }), 1);
assert.equal(
  resolveReaderPage(posEntries, pages, { messageId: "gone", number: 5 }),
  1,
  "falls forward to the next message",
);
assert.equal(
  resolveReaderPage(posEntries, pages, { messageId: "gone", number: 50 }),
  1,
  "past the end opens the last page",
);
assert.equal(resolveReaderPage(posEntries, pages, { messageId: "gone", number: null }), 0);
assert.deepEqual(positionForPage(posEntries, pages, 1), { messageId: "c", number: 6 });
assert.deepEqual(positionForPage(posEntries, pages, 7), { messageId: "c", number: 6 });
assert.equal(positionForPage([], [], 0), null);

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}
const storage = memoryStorage();
writeReaderPosition("chat-1", { messageId: "c", number: 6 }, storage);
assert.deepEqual(readReaderPosition("chat-1", storage), { messageId: "c", number: 6 });
assert.equal(readReaderPosition("chat-2", storage), null, "positions are per chat");
storage.map.set("marinara:reading-mode:position:chat-3", "{not json");
assert.equal(readReaderPosition("chat-3", storage), null);
const throwing = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("full");
  },
};
assert.equal(readReaderPosition("chat-1", throwing), null);
assert.doesNotThrow(() => writeReaderPosition("chat-1", { messageId: "a", number: 1 }, throwing));
assert.equal(readReaderPosition("chat-1", null), null);

// ── Settings ──
assert.deepEqual(readReaderSettings(throwing), READER_DEFAULTS);
const settingsStore = memoryStorage();
writeReaderSettings({ fontSize: 99, lineWidth: 10, lineHeight: 1.66, font: "sans" }, settingsStore);
assert.deepEqual(readReaderSettings(settingsStore), {
  fontSize: READER_LIMITS.fontSize.max,
  lineWidth: READER_LIMITS.lineWidth.min,
  lineHeight: 1.7,
  font: "sans",
});
assert.equal(stepReaderSetting(READER_DEFAULTS, "fontSize", 1).fontSize, 19);
assert.equal(stepReaderSetting({ ...READER_DEFAULTS, lineHeight: 2.2 }, "lineHeight", 1).lineHeight, 2.2);
assert.equal(stepReaderSetting(READER_DEFAULTS, "lineHeight", -1).lineHeight, 1.6);

// ── Keys ──
assert.equal(readerKeyAction({ key: "ArrowRight" }), "next");
assert.equal(readerKeyAction({ key: "k" }), "previous");
assert.equal(readerKeyAction({ key: "End" }), "last");
assert.equal(readerKeyAction({ key: "b" }), "bookmarks");
assert.equal(readerKeyAction({ key: "ArrowRight", targetIsField: true }), null);
assert.equal(readerKeyAction({ key: "n", ctrlKey: true }), null);
// Arrows never reach the chat's swipe, regenerate or edit-last listeners while the reader is open.
for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
  assert.equal(readerKeyIsIsolated({ key }), true, key);
  assert.equal(readerKeyIsIsolated({ key, targetIsField: true }), false, key);
}
assert.equal(readerKeyIsIsolated({ key: "Escape" }), false);
assert.equal(readerKeyAction({ key: " " }), null, "Space keeps scrolling the page");

console.log("reading-mode regression passed");
