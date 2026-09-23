import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Pre-send cache check. The player asked for a warning before a message goes out when most of the prompt would have
// to be cached again (a changed card high in the prompt, or an expired cache), with the choice to send anyway. The
// prediction compares the built prompt with the last one actually sent for the chat, by message, and holds the send
// before any model call when the cached share falls under the chat's threshold.
const root = mkdtempSync(join(tmpdir(), "marinara-cache-guard-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = `${process.env.DATA_DIR}/storage`; // never the live store named in .env

try {
  const guard = await import("../../packages/server/src/services/generation/cache-send-guard.js");
  const { cacheGuardWarningMessage, isCacheGuardWarning } =
    await import("../../packages/client/src/lib/cache-guard-warning.js");
  const settings = guard.readCacheGuardSettings({});
  assert.deepEqual(settings, { enabled: true, thresholdPercent: 80, ttlMinutes: 60 });
  assert.deepEqual(
    guard.readCacheGuardSettings({ cacheSendGuard: { enabled: false, thresholdPercent: 150, ttlMinutes: 0 } }),
    {
      enabled: false,
      thresholdPercent: 100,
      ttlMinutes: 1,
    },
  );
  assert.equal(guard.cacheGuardApplies("claude_subscription"), true);
  assert.equal(guard.cacheGuardApplies("openai"), false, "providers without this cache model are never held");
  assert.equal(guard.cacheGuardApplies("openai_chatgpt", [{ role: "system", content: "plain" }]), false);
  assert.equal(
    guard.cacheGuardApplies("openai_chatgpt", [
      { role: "system", content: "lore", providerMetadata: { marinaraFullLoreContext: true } },
    ]),
    true,
  );

  const anthropicScope = {
    provider: "claude_subscription",
    model: "claude-opus-5",
    connectionId: "anthropic-1",
    requestKind: "narrator" as const,
  };
  const openAiScope = {
    provider: "openai_chatgpt",
    model: "gpt-5",
    connectionId: "chatgpt-1",
    requestKind: "isolated-planner" as const,
  };

  const lore = { role: "system", content: "<lore>" + "atlas ".repeat(20_000) + "</lore>" };
  const cards = { role: "user", content: "<gm_reference_named_character>\nName: Kriva\noriginal" };
  const history = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `turn ${i} `.repeat(300),
  }));
  const now = Date.parse("2026-09-17T08:00:00Z");
  const previous = guard.fingerprintPrompt(
    [lore, cards, ...history, { role: "user", content: "old tail" }],
    now - 5 * 60_000,
    anthropicScope,
  );

  // A normal next turn: only the tail differs.
  const next = guard.fingerprintPrompt(
    [lore, cards, ...history, { role: "assistant", content: "reply" }, { role: "user", content: "new turn" }],
    now,
    anthropicScope,
  );
  const normal = guard.predictCacheHit(previous, next, settings, now)!;
  assert.ok(normal.percent >= 95, `a normal turn predicts a high hit (${normal.percent}%)`);

  // A card changed high in the prompt: everything after it is uncached, and the change is named.
  const changedCards = { ...cards, content: cards.content.replace("original", "rewritten by Game Mode") };
  const broken = guard.fingerprintPrompt(
    [lore, changedCards, ...history, { role: "user", content: "new turn" }],
    now,
    anthropicScope,
  );
  const low = guard.predictCacheHit(previous, broken, settings, now)!;
  assert.equal(low.reason, "changed");
  assert.equal(low.firstChange?.index, 1);
  assert.match(low.firstChange?.label ?? "", /gm_reference_named_character/u);
  assert.ok(low.percent < settings.thresholdPercent, `a mid-prompt change predicts a low hit (${low.percent}%)`);

  // An expired cache is 0% whatever the content.
  const expired = guard.predictCacheHit(previous, next, settings, now + 2 * 60 * 60_000)!;
  assert.equal(expired.percent, 0);
  assert.equal(expired.reason, "expired");

  // No earlier send: nothing to compare, never held.
  assert.equal(guard.predictCacheHit(null, next, settings, now), null);
  assert.equal(
    guard.predictCacheHit(
      { entries: previous.entries, labels: previous.labels, at: previous.at } as never,
      next,
      settings,
      now,
    ),
    null,
    "legacy unscoped fingerprints establish no comparison baseline",
  );

  const openPrevious = guard.fingerprintPrompt(
    [
      { role: "system", content: "stable lore", providerMetadata: { marinaraFullLoreContext: true } },
      { role: "user", content: "old" },
    ],
    now - 2 * 60 * 60_000,
    openAiScope,
  );
  const openNext = guard.fingerprintPrompt(
    [
      { role: "system", content: "stable lore", providerMetadata: { marinaraFullLoreContext: true } },
      { role: "user", content: "new" },
    ],
    now,
    openAiScope,
  );
  const openPrediction = guard.predictCacheHit(openPrevious, openNext, settings, now, "openai-prefix")!;
  assert.equal(openPrediction.mode, "openai-prefix");
  assert.equal(openPrediction.reason, "changed");
  assert.notEqual(openPrediction.percent, 0, "ChatGPT prefix estimates do not use the Anthropic expiry rule");
  assert.equal(guard.predictCacheHit(previous, openNext, settings, now), null, "route scopes never cross-compare");

  // The fingerprint survives a restart through the file copy.
  await guard.recordSentPrompt("chat-1", previous);
  const reread = await guard.readLastSentPrompt("chat-1", anthropicScope);
  assert.deepEqual(reread?.entries, previous.entries);

  // The hold carries what the client needs, and the client words it plainly.
  const hold = new guard.CacheGuardHold({ ...low, thresholdPercent: settings.thresholdPercent });
  assert.ok(isCacheGuardWarning(hold.prediction));
  const text = cacheGuardWarningMessage(hold.prediction);
  assert.match(text, new RegExp(`Only about ${low.percent}%`, "u"));
  assert.match(text, /Your message is saved/u);
  assert.match(cacheGuardWarningMessage({ ...expired, thresholdPercent: 80 }), /cache has likely expired/u);
  assert.match(
    cacheGuardWarningMessage({ ...openPrediction, thresholdPercent: 80, mode: "openai-prefix" }),
    /estimated reusable prompt prefix.*not a measured cache hit/u,
  );
  assert.match(
    cacheGuardWarningMessage({ ...openPrediction, requestKind: "isolated-planner", thresholdPercent: 80 }),
    /this planner/u,
  );
  assert.doesNotMatch(
    cacheGuardWarningMessage({ ...openPrediction, thresholdPercent: 80, mode: "openai-prefix" }),
    /expired|will be written to cache again/u,
  );
  assert.ok(!text.includes("—"), "no em dashes in user-facing text");

  console.log("cache-send-guard regression passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
