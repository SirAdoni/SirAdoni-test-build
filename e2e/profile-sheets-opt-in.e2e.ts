import { test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("saved profiles are optional while ordinary sheets and scene identity remain intact", async ({ baseURL }) => {
  test.setTimeout(180_000);
  await promisify(execFile)(process.execPath, ["scripts/regressions/game-character-profile-sheet.browser.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, GAME_PROFILE_SHEET_BASE_URL: baseURL },
    timeout: 170_000,
  });
});
