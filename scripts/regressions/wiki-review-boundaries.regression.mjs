import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
const root = new URL("../../", import.meta.url);
const requireClient = createRequire(new URL("packages/client/package.json", root));
const { QueryClient } = requireClient("@tanstack/react-query");
const parse = (p) =>
  ts.createSourceFile(p, readFileSync(new URL(p, root), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const find = (s, predicate) => {
  let found;
  const walk = (n) => {
    if (predicate(n)) found = n;
    ts.forEachChild(n, walk);
  };
  walk(s);
  assert.ok(found);
  return found;
};
const evaluate = (code, scope) =>
  new Function(
    ...Object.keys(scope),
    ts.transpileModule("const result = " + code + ";", { compilerOptions: { target: ts.ScriptTarget.ES2022 } })
      .outputText + ";return result;",
  )(...Object.values(scope));

// Execute the real prompt time assembly even before a first scene snapshot exists.
const runtime = parse("packages/server/src/services/generation/game-gm-prompt-runtime.ts");
const timeBlock = find(
  runtime,
  (n) =>
    ts.isTryStatement(n) &&
    n.tryBlock.getText(runtime).includes("const snap = await args.selectedGameStateSnapshotPromise"),
);
const shared = await import("../../packages/shared/dist/index.js");
let calendarOn = false;
const assembleTime = evaluate(
  `async (args) => { let weatherContext; let gameTime; ${timeBlock.getText(runtime)}; return {gameTime, weatherContext}; }`,
  {
    composeGameTimeLine: shared.composeGameTimeLine,
    isCampaignSurfaceEnabled: (flag) => flag === "gameCalendar" && calendarOn,
  },
);
const metadata = { gameTime: { day: 3, hour: 12, minute: 0 } };
const withoutSnapshot = await assembleTime({
  selectedGameStateSnapshotPromise: Promise.resolve(null),
  chatMetadata: metadata,
});
assert.equal(withoutSnapshot.gameTime, shared.composeGameTimeLine(null, metadata));
assert.ok(withoutSnapshot.gameTime);
assert.equal(withoutSnapshot.weatherContext, undefined);
const savedCalendar = { ...metadata, gameCalendar: { ...shared.defaultGameCalendarState(), enabled: true } };
const unchanged = structuredClone(savedCalendar);
for (const snapshot of [null, { time: "Old time", weather: "Clear" }]) {
  for (const enabled of [false, true, false]) {
    calendarOn = enabled;
    const result = await assembleTime({
      selectedGameStateSnapshotPromise: Promise.resolve(snapshot),
      chatMetadata: savedCalendar,
    });
    const expected = shared.composeGameTimeLine(snapshot, enabled ? savedCalendar : metadata);
    assert.equal(result.gameTime, expected);
    assert.deepEqual(savedCalendar, unchanged, "OFF must preserve the saved calendar");
  }
}

// Execute the actual success handler with a real query cache after the flag changed OFF.
const calendar = parse("packages/client/src/hooks/use-game-calendar.ts");
const handler = find(calendar, (n) => ts.isFunctionDeclaration(n) && n.name?.text === "applyResponse");
const qc = new QueryClient();
let snapshot = { chatId: "chat", time: "old" };
const applyResponse = evaluate(handler.getText(calendar), {
  gameCalendarKeys: { detail: (id) => ["calendar", id] },
  chatKeys: { detail: (id) => ["chat", id] },
  isWikiFeatureEnabled: () => false,
  useGameStateStore: {
    getState: () => ({
      current: snapshot,
      setGameState: (value) => {
        snapshot = value;
      },
    }),
  },
});
qc.setQueryData(["chat", "chat"], {});
applyResponse(qc, "chat", { calendar: { events: ["saved"] }, formattedTime: "new" }, true);
assert.deepEqual(qc.getQueryData(["calendar", "chat"]).calendar.events, ["saved"]);
assert.equal(qc.getQueryState(["chat", "chat"]).isInvalidated, true);
assert.equal(snapshot.time, "new");
applyResponse(qc, "other", { calendar: {}, formattedTime: "other" }, true);
assert.equal(snapshot.time, "new", "late results cannot replace another chat clock");
qc.clear();

// A failed or pending write must retain the event draft; a successful old write must not erase newer typing.
const event = parse("packages/client/src/components/tools/GameCalendarTool.tsx");
const enabledInitializer = find(
  event,
  (n) => ts.isVariableDeclaration(n) && n.name.getText(event) === "[enabled, setEnabled]",
).initializer.getText(event);
for (const enabled of [false, true])
  assert.equal(evaluate(enabledInitializer, { calendar: { enabled }, useState: (value) => value }), enabled);
const expression = find(
  event,
  (n) => ts.isVariableDeclaration(n) && n.name.getText(event) === "addEvent",
).initializer.getText(event);
let draft = { title: "Event", kind: "note", yearly: false };
let callbacks;
let calls = 0;
const makeAdd = (pending) =>
  evaluate(expression, {
    draft,
    calendar: {},
    events: [],
    focus: {},
    newEventId: () => "id",
    fail: () => {},
    saveEvents: () => {
      throw new Error("unguarded write");
    },
    save: {
      isPending: pending,
      mutate: (_value, options) => {
        calls++;
        callbacks = options;
      },
    },
    setDraft: (update) => {
      draft = typeof update === "function" ? update(draft) : update;
    },
  });
makeAdd(true)();
assert.equal(calls, 0);
assert.equal(draft.title, "Event");
makeAdd(false)();
assert.equal(calls, 1);
assert.equal(draft.title, "Event");
callbacks.onError();
assert.equal(draft.title, "Event");
callbacks.onSuccess();
assert.equal(draft.title, "");
draft = { ...draft, title: "Older" };
makeAdd(false)();
draft = { ...draft, title: "New typing" };
callbacks.onSuccess();
assert.equal(draft.title, "New typing");

// Execute the actual focus effect through the reactive store request channel.
const editor = parse("packages/client/src/components/lorebooks/LorebookEditor.tsx");
const effect = find(
  editor,
  (n) =>
    ts.isCallExpression(n) &&
    n.expression.getText(editor) === "useEffect" &&
    n.arguments[0]?.getText(editor).includes("lorebookDetailInitialEntryId"),
);
let state = { lorebookDetailId: "book", lorebookDetailInitialEntryId: "entry" };
const focusCalls = [];
const renderFocus = (book, requestId, lorebook, entries = [], isLoading = false) => {
  const scope = {
    lorebookId: book,
    lorebookDetailInitialEntryId: requestId,
    lorebook,
    rawEntries: isLoading ? undefined : entries,
    isLoading,
    entries,
    useUIStore: {
      getState: () => state,
      setState: (patch) => {
        state = { ...state, ...patch };
      },
    },
    jumpToEntry: (id) => focusCalls.push(id),
  };
  return () => evaluate(effect.arguments[0].getText(editor), scope)();
};

// An unavailable lorebook cannot consume the request; once present, a loaded matching row can.
renderFocus("book", "entry", null, [{ id: "entry" }])();
assert.equal(state.lorebookDetailInitialEntryId, "entry");
assert.deepEqual(focusCalls, []);
renderFocus("book", "entry", { id: "book" }, [{ id: "entry" }])();
assert.equal(state.lorebookDetailInitialEntryId, null);
assert.deepEqual(focusCalls, ["entry"]);

// Loading and a missing row retain the request; a newer request beats a stale effect.
state = { lorebookDetailId: "book", lorebookDetailInitialEntryId: "old" };
renderFocus("book", "old", { id: "book" }, [], true)();
renderFocus("book", "old", { id: "book" }, [{ id: "other" }])();
assert.equal(state.lorebookDetailInitialEntryId, "old");
const staleRequest = renderFocus("book", "old", { id: "book" }, [{ id: "old" }, { id: "new" }]);
state = { ...state, lorebookDetailInitialEntryId: "new" };
staleRequest();
assert.equal(state.lorebookDetailInitialEntryId, "new");
assert.deepEqual(focusCalls, ["entry"]);
renderFocus("book", "new", { id: "book" }, [{ id: "old" }, { id: "new" }])();
assert.equal(state.lorebookDetailInitialEntryId, null);
assert.deepEqual(focusCalls, ["entry", "new"]);

// A later request for the same row remains observable after the prior one was consumed.
state = { ...state, lorebookDetailInitialEntryId: "new" };
renderFocus("book", "new", { id: "book" }, [{ id: "new" }])();
assert.deepEqual(focusCalls, ["entry", "new", "new"]);

// A stale callback for a previous lorebook cannot clear the current lorebook's target.
state = { lorebookDetailId: "book-a", lorebookDetailInitialEntryId: "entry-a" };
const staleBook = renderFocus("book-a", "entry-a", { id: "book-a" }, [{ id: "entry-a" }]);
state = { lorebookDetailId: "book-b", lorebookDetailInitialEntryId: "entry-b" };
staleBook();
assert.equal(state.lorebookDetailInitialEntryId, "entry-b");
assert.deepEqual(focusCalls, ["entry", "new", "new"]);
renderFocus("book-b", "entry-b", { id: "book-b" }, [{ id: "entry-b" }])();
assert.deepEqual(focusCalls, ["entry", "new", "new", "entry-b"]);

console.log(
  "Wiki review boundaries: calendar late-OFF synchronization, retained event drafts and asynchronous owner focus passed",
);
