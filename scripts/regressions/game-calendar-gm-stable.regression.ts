import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Cache safety: the calendar date line and its upcoming events move with game time, so they must render in
// the runtime part of the GM prompt and never inside the stable block (providerMetadata.marinaraGmStable).
const root = mkdtempSync(join(tmpdir(), "marinara-gm-calendar-stable-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

try {
  const { injectGameGmPromptRuntime } = await import(
    "../../packages/server/src/services/generation/game-gm-prompt-runtime.js"
  );
  const { buildGmFormatReminder } = await import("../../packages/server/src/services/game/gm-prompts.js");
  const { defaultGameCalendarConfig } = await import("../../packages/shared/src/index.js");

  const calendar = {
    enabled: true,
    config: { ...defaultGameCalendarConfig(), startDate: { year: 300, month: 2, day: 1 }, era: "AR" },
    events: [
      { id: "fair", title: "Lantern Fair", kind: "event", date: { year: 300, month: 2, day: 5 }, yearly: true },
      { id: "toll", title: "Bridge toll", kind: "deadline", date: { year: 300, month: 2, day: 9 } },
    ],
  };

  const runtime = async (metadata: Record<string, unknown>) => {
    const messages: any[] = [];
    const result = await injectGameGmPromptRuntime({
      messages,
      chatId: "calendar-chat",
      chat: {},
      chatMetadata: { gamePartyCharacterIds: ["card-tamsin"], gameSetupConfig: { genre: "fantasy" }, ...metadata },
      characterIds: [],
      chars: {
        getById: async (id: string) =>
          id === "card-tamsin" ? { data: { name: "Tamsin", description: "Tamsin keeps the ferry." } } : null,
        getPersona: async () => null,
      },
      chats: { getById: async () => null, updateMetadata: async () => null },
      selectedGameStateSnapshotPromise: Promise.resolve({
        time: "Day 2, 09:00 (morning)",
        date: "early spring",
        presentCharacters: JSON.stringify([{ characterId: "card-tamsin", name: "Tamsin" }]),
      }),
      mappedMessages: [{ role: "user", content: "What day is it?" }],
      personaName: "Player",
      resolvePromptMacros: (value: string) => value,
      resolveCharacterPromptMacros: (value: string) => value,
      cacheFriendlyLayout: true,
    });
    // The Time line reaches the model through the per-turn format reminder, next to generation.
    const reminder = String(buildGmFormatReminder({ ...result.gmCtx, gameTime: result.gameTime } as any));
    const state = /<gm_only_runtime_state>[\s\S]*?<\/gm_only_runtime_state>/u.exec(reminder)?.[0] ?? "";
    return { messages, reminder, state };
  };
  const stable = (run: { messages: any[] }) => {
    const block = run.messages.find((message) => message.providerMetadata?.marinaraGmStable === true);
    assert.ok(block, "the GM prompt has a stable block");
    return String(block.content);
  };
  const hash = (run: { messages: any[] }) => createHash("sha256").update(stable(run)).digest("hex");
  const all = (run: { messages: any[] }) => run.messages.map((message) => String(message.content)).join("\n");

  const without = await runtime({ gameTime: { day: 2, hour: 9, minute: 0 } });
  const day2 = await runtime({ gameTime: { day: 2, hour: 9, minute: 0 }, gameCalendar: calendar });
  const day6 = await runtime({ gameTime: { day: 6, hour: 9, minute: 0 }, gameCalendar: calendar });
  const disabled = await runtime({
    gameTime: { day: 2, hour: 9, minute: 0 },
    gameCalendar: { ...calendar, enabled: false },
  });

  assert.equal(hash(day2), hash(without), "a calendar never changes the stable cache prefix");
  assert.equal(hash(day6), hash(day2), "moving the clock never changes the stable cache prefix");
  assert.doesNotMatch(all(day2), /Lantern Fair|300 AR/u, "the calendar line is in no injected message");
  assert.equal(all(day6), all(day2), "no injected message changes as the clock moves");

  assert.match(
    day2.state,
    /Time [A-Za-z]+, 2 March 300 AR \(upcoming: Lantern Fair in 3 days; deadline Bridge toll in 7 days\), Day 2, 09:00/u,
  );
  assert.match(day6.state, /Time [A-Za-z]+, 6 March 300 AR \(upcoming: deadline Bridge toll in 3 days\)/u);
  assert.match(without.state, /Time Day 2, 09:00 \(morning\)/u);
  const corrected = await runtime({ gameTime: { day: 4, hour: 14, minute: 0 } });
  assert.match(
    corrected.state,
    /Time Day 4, 14:00 \(afternoon\)/u,
    "the runtime clock follows metadata rather than the stale snapshot",
  );
  assert.equal(hash(corrected), hash(without), "clock corrections do not change the stable cache prefix");
  assert.equal(all(disabled), all(without), "a switched-off calendar leaves the injected prompt byte-identical");
  assert.equal(disabled.reminder, without.reminder, "and the per-turn reminder too");

  console.log("game-calendar-gm-stable regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
