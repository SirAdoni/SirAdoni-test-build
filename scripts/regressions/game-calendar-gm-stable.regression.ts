import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// This exercises the frozen generation prompt caller and calendar-aware runtime time line.
const root = mkdtempSync(join(tmpdir(), "marinara-gm-calendar-stable-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.NODE_ENV = "test";

try {
  const { applyFeatureSettingsValue } = await import("../../packages/server/src/services/features/feature-settings.js");
  applyFeatureSettingsValue(JSON.stringify({ gameCalendar: true }));
  const { injectGameGmPromptRuntime } =
    await import("../../packages/server/src/services/generation/game-gm-prompt-runtime.js");
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
    const state = /<current_state>[\s\S]*?<\/current_state>/u.exec(reminder)?.[0] ?? "";
    return { messages, reminder, state };
  };
  const without = await runtime({ gameTime: { day: 2, hour: 9, minute: 0 } });
  const day2 = await runtime({ gameTime: { day: 2, hour: 9, minute: 0 }, gameCalendar: calendar });
  const day6 = await runtime({ gameTime: { day: 6, hour: 9, minute: 0 }, gameCalendar: calendar });
  const disabled = await runtime({
    gameTime: { day: 2, hour: 9, minute: 0 },
    gameCalendar: { ...calendar, enabled: false },
  });

  assert.match(
    day2.state,
    /Time [A-Za-z]+, 2 March 300 AR \(upcoming: Lantern Fair in 3 days; deadline Bridge toll in 7 days\), Day 2, 09:00/u,
  );
  assert.match(day6.state, /Time [A-Za-z]+, 6 March 300 AR \(upcoming: deadline Bridge toll in 3 days\)/u);
  assert.match(without.state, /Time Day 2, 09:00 \(morning\)/u);
  assert.equal(disabled.state, without.state, "a switched-off calendar leaves the per-turn time line unchanged");

  const corrected = await runtime({ gameTime: { day: 4, hour: 14, minute: 0 } });
  assert.match(
    corrected.state,
    /Time Day 4, 14:00 \(afternoon\)/u,
    "the runtime clock follows metadata rather than the stale snapshot",
  );

  applyFeatureSettingsValue(null);
  assert.equal(
    (await runtime({ gameTime: { day: 2, hour: 9, minute: 0 }, gameCalendar: calendar })).state,
    without.state,
    "app-level OFF preserves the baseline time line with saved calendar data",
  );
  console.log("game calendar GM runtime regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
