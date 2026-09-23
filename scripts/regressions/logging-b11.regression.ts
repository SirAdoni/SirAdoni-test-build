// Logging batch 11 v1.0 (2026-09-23): media routes. A failing backgroundremover run
// logs one classified sprite.cleanup.fallback line and repeats are counted, not
// written. Sprite, gallery and TTS routes report failures through replyWithDiagnostic
// and write the shared job.progress, job.summary, media.generate and tts.speak lines.
// Temporary data and log directories; no provider, no live server.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "marinara-logging-b11-"));
const dataDir = mkdtempSync(join(tmpdir(), "marinara-logging-b11-data-"));
process.env.LOG_DIR = logDir;
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = `${process.env.DATA_DIR}/storage`; // never the live store named in .env
process.env.LOG_FILE_LEVEL = "debug";
process.env.LOG_LEVEL = "fatal";
// node rejects "-m" as a bad option, so the "python -m backgroundremover" call exits non-zero at once.
process.env.BACKGROUNDREMOVER_PYTHON = process.execPath;
delete process.env.BACKGROUNDREMOVER_COMMAND;
delete process.env.BACKGROUNDREMOVER_DISABLED;
process.env.SPRITE_BACKGROUND_REMOVAL_ENGINE = "auto";

const root = join(import.meta.dirname, "../..");
const src = (path: string) => readFileSync(join(root, "packages/server/src", path), "utf8");

type Line = Record<string, any>;
function mainLines(): Line[] {
  return readdirSync(logDir)
    .filter((name) => /^marinara-.*\.log/.test(name))
    .flatMap((name) => readFileSync(join(logDir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

try {
  const { logger } = await import("../../packages/server/src/lib/logger.js");
  const { tryRemoveBackgroundWithBackgroundRemover } =
    await import("../../packages/server/src/services/image/background-remover.service.js");

  // 1. A failing child logs one classified fallback line; the repeat is deduplicated.
  const input = Buffer.from("not really a png");
  assert.equal(await tryRemoveBackgroundWithBackgroundRemover(input), null);
  assert.equal(await tryRemoveBackgroundWithBackgroundRemover(input), null);
  logger.flush?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const fallbacks = mainLines().filter((line) => line.event === "sprite.cleanup.fallback");
  assert.equal(fallbacks.length, 1, "a repeated backgroundremover failure is written once");
  const [fallback] = fallbacks;
  assert.equal(fallback.engine, "backgroundremover");
  assert.equal(fallback.action, "builtin");
  assert.equal(fallback.errorCode, "ME_CHILD_EXIT");
  assert.equal(fallback.timedOut, false);
  assert.equal(typeof fallback.exitCode, "number");
  assert.ok(typeof fallback.repeatKey === "string" && fallback.repeatKey.startsWith("backgroundremover:builtin:"));
  assert.equal(fallback.level >= 40, true, "fallback logs at warn");

  // 2. Source shape of the route changes.
  const sprites = src("routes/sprites.routes.ts");
  assert.doesNotMatch(sprites, /logger\.warn\((expressionErr|bgErr),/);
  assert.doesNotMatch(sprites, /logger\.error\(err, "(Animated expression generation|Sprite sheet generation|Sprite cleanup) failed"/);
  assert.match(sprites, /"job\.progress", \{ kind: "sprite"/);
  assert.match(sprites, /"job\.summary",/);
  assert.equal((sprites.match(/return replySpriteJobFailure\(reply, err,/g) ?? []).length, 2);

  const gallery = src("routes/gallery.routes.ts");
  assert.doesNotMatch(
    gallery,
    /logger\.warn\(err, "\[gallery\/[a-z-/]+\] (Image generation failed|Selfie generation failed|Scene video generation failed|Failed to build selfie|Failed to preview|Failed to compile|Failed to prepare scene video)/,
  );
  assert.ok((gallery.match(/replyWithDiagnostic\(reply, 50[02], err/g) ?? []).length >= 7);
  assert.equal((gallery.match(/fallbackUsed/g) ?? []).length >= 2, true);
  assert.match(gallery, /effectiveProvider: effectiveImageProvider/);

  const tts = src("routes/tts.routes.ts");
  const speak = tts.slice(tts.indexOf('app.post("/speak"'));
  assert.doesNotMatch(speak, /reply\.status\((400|502)\)\.send/);
  assert.match(speak, /"ME_PROVIDER_ERROR"/);
  assert.match(speak, /"ME_TIMEOUT" : "ME_NETWORK"/);
  assert.match(speak, /"tts\.speak",\s*\{ \.\.\.speakFields\(\), outcome: "ok"/);
  assert.doesNotMatch(speak, /speakFields[^;]*\btext:/, "tts.speak never logs the text");

  const remover = src("services/image/background-remover.service.ts");
  assert.match(remover, /describeChildFailure\(error/);
  assert.doesNotMatch(remover, /logger\.warn/);

  console.log("logging-b11 regression passed");
} finally {
  for (const dir of [logDir, dataDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the log file open.
    }
  }
}
