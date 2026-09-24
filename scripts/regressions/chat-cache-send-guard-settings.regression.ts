// Per-chat "Warn before a low-cache send" (chat.metadata.cacheSendGuard { enabled, thresholdPercent }).
// The chat settings control must show the server's defaults (on, 80%) when the key is absent and write the
// same shape the server reads, so surfacing it changes nothing until the user edits it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_CACHE_GUARD,
  readCacheGuardSettings,
} from "../../packages/server/src/services/generation/cache-send-guard.js";

assert.deepEqual(readCacheGuardSettings({}), DEFAULT_CACHE_GUARD, "absent = today's defaults");
assert.equal(DEFAULT_CACHE_GUARD.enabled, true);
assert.equal(DEFAULT_CACHE_GUARD.thresholdPercent, 80);
assert.equal(readCacheGuardSettings({ cacheSendGuard: { enabled: false } }).enabled, false);
assert.equal(readCacheGuardSettings({ cacheSendGuard: { enabled: true, thresholdPercent: 55 } }).thresholdPercent, 55);
assert.equal(readCacheGuardSettings({ cacheSendGuard: { thresholdPercent: 140 } }).thresholdPercent, 100);

const section = readFileSync(
  new URL("../../packages/client/src/features/chat-settings/sections/AdvancedParametersSection.tsx", import.meta.url),
  "utf8",
);
assert.match(section, /const cacheGuardEnabled = cacheSendGuard\.enabled !== false;/);
assert.match(section, /Math\.min\(100, Math\.max\(0, cacheSendGuard\.thresholdPercent\)\)\s+: 80;/);
assert.match(section, /onCacheSendGuardChange\(\{ \.\.\.cacheSendGuard, enabled \}\)/);
assert.match(section, /thresholdPercent: Math\.max\(0, Math\.min\(100, Math\.round\(value\)\)\)/);
const drawer = readFileSync(
  new URL("../../packages/client/src/components/chat/ChatSettingsDrawer.tsx", import.meta.url),
  "utf8",
);
assert.match(
  drawer,
  /onCacheSendGuardChange=\{\(cacheSendGuard\) => updateMeta\.mutate\(\{ id: chat\.id, cacheSendGuard \}\)\}/,
);

console.log("chat-cache-send-guard-settings regression passed");
