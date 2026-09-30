import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const removeDirectoryLink = process.platform === "win32" ? rmdir : unlink;
// Actual ancestor-junction attack; no symlink-security assertions are skipped on Windows.
const scratch = await mkdtemp(join(tmpdir(), "marinara-lorebook-containment-"));
const data = join(scratch, "data");
const outside = join(scratch, "outside");
const directory = join(data, "lorebooks", "images", "entries");
const savedDirectory = join(data, "lorebooks", "images", "entries-original");
const alias = join(scratch, "data-alias");
const filename = "00000000-0000-0000-0000-000000000000.png";
const url = `/api/lorebooks/entry-images/${filename}`;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2jX8AAAAASUVORK5CYII=",
  "base64",
);
const previousDataDir = process.env.DATA_DIR;
let linked = false;
let aliased = false;
try {
  process.env.DATA_DIR = data;
  const { readLorebookImageDataUrl, LOREBOOK_IMAGE_MAX_BYTES } =
    await import("../../packages/server/src/services/lorebook/lorebook-images.js");
  await mkdir(directory, { recursive: true });
  await mkdir(outside);
  await writeFile(join(directory, filename), png);
  await writeFile(join(outside, filename), png);
  const expected = `data:image/png;base64,${png.toString("base64")}`;
  const budget = { remainingBytes: png.length };
  assert.equal(await readLorebookImageDataUrl(url, budget), expected, "regular images still read");
  assert.equal(budget.remainingBytes, 0, "accepted images retain export accounting");
  await assert.rejects(
    () => readLorebookImageDataUrl(url, { remainingBytes: png.length - 1 }),
    (error: unknown) =>
      typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 413,
    "export cap remains an explicit error",
  );

  await symlink(data, alias, process.platform === "win32" ? "junction" : "dir");
  aliased = true;
  process.env.DATA_DIR = alias;
  assert.equal(await readLorebookImageDataUrl(url), expected, "a configured data-root alias remains usable");
  process.env.DATA_DIR = data;

  await rename(directory, savedDirectory);
  try {
    await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
    linked = true;
    const rejectedBudget = { remainingBytes: png.length };
    assert.equal(
      await readLorebookImageDataUrl(url, rejectedBudget),
      null,
      "ancestor links cannot expose outside images",
    );
    assert.equal(rejectedBudget.remainingBytes, png.length, "rejected paths do not consume export budget");
    assert.deepEqual(await readFile(join(outside, filename)), png, "outside fixture image is untouched");
  } finally {
    if (linked) {
      await removeDirectoryLink(directory);
      linked = false;
    }
    await rename(savedDirectory, directory);
  }
  assert.equal(await readLorebookImageDataUrl(url), expected, "regular images still read after attack cleanup");

  await writeFile(join(directory, filename), Buffer.from("not an image"));
  assert.equal(await readLorebookImageDataUrl(url), null, "signature validation remains required");
  await writeFile(join(directory, filename), Buffer.concat([png, Buffer.alloc(LOREBOOK_IMAGE_MAX_BYTES)]));
  assert.equal(await readLorebookImageDataUrl(url), null, "oversized images remain rejected");
  await writeFile(join(directory, filename), png);
  assert.equal(await readLorebookImageDataUrl("https://example.com/ref.png"), null);
  assert.equal(await readLorebookImageDataUrl("/api/lorebooks/entry-images/../../outside.png"), null);
  assert.equal(
    await readLorebookImageDataUrl("/api/lorebooks/entry-images/00000000-0000-0000-0000-000000000001.png"),
    null,
  );
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (linked) await removeDirectoryLink(directory);
  if (aliased) await removeDirectoryLink(alias);
  assert.ok(
    resolve(scratch).startsWith(resolve(tmpdir()) + sep),
    "cleanup is limited to this fixture's temporary root",
  );
  await rm(scratch, { recursive: true, force: true });
}
console.log("lorebook-image-containment regression passed");
