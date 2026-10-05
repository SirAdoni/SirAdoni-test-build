import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeIncrementalSnapshot } from "../../packages/server/src/services/backup/incremental-snapshot.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "marinara-incremental-snapshot-")));
try {
  const sourceRoot = join(root, "sources");
  await mkdir(sourceRoot);
  const liveUnchanged = join(sourceRoot, "unchanged.txt");
  const liveChanged = join(sourceRoot, "changed.txt");
  await writeFile(liveUnchanged, "stable contents");
  await writeFile(liveChanged, "old contents");

  const first = join(root, "snapshot-1");
  const initial = await writeIncrementalSnapshot({
    destination: first,
    sources: [
      { entryName: "nested/unchanged.txt", filePath: liveUnchanged, size: 15 },
      { entryName: "changed.txt", filePath: liveChanged, size: 12 },
      { entryName: "built.txt", buildData: () => Buffer.from("built") },
      { entryName: "buffer.txt", data: Buffer.from("direct") },
    ],
  });
  assert.deepEqual(initial, { copied: 4, reused: 0, bytes: 38 });

  const oldSnapshotFile = join(first, "nested", "unchanged.txt");
  const sourceInfo = await stat(oldSnapshotFile);
  await writeFile(liveUnchanged, "changed live source");
  assert.equal(await readFile(oldSnapshotFile, "utf8"), "stable contents");
  assert.notEqual((await stat(liveUnchanged)).ino, sourceInfo.ino);

  await writeFile(liveChanged, "new contents");
  const second = join(root, "snapshot-2");
  const next = await writeIncrementalSnapshot({
    destination: second,
    previous: first,
    sources: [
      { entryName: "nested/unchanged.txt", data: Buffer.from("stable contents") },
      { entryName: "changed.txt", data: Buffer.from("new contents") },
      { entryName: "new.txt", data: Buffer.from("new") },
    ],
  });
  assert.deepEqual(next, { copied: 2, reused: 1, bytes: 15 });
  assert.equal((await stat(oldSnapshotFile)).ino, (await stat(join(second, "nested", "unchanged.txt"))).ino);
  assert.equal(await readFile(join(second, "changed.txt"), "utf8"), "new contents");
  assert.equal(await readFile(join(second, "new.txt"), "utf8"), "new");
  await assert.rejects(readFile(join(second, "built.txt")), { code: "ENOENT" });

  await rm(first, { recursive: true });
  assert.equal(await readFile(join(second, "nested", "unchanged.txt"), "utf8"), "stable contents");

  const corruptedPreviousFile = join(second, "nested", "unchanged.txt");
  await chmod(corruptedPreviousFile, 0o600);
  await writeFile(corruptedPreviousFile, "corrupted contents");
  const third = join(root, "snapshot-3");
  const recovered = await writeIncrementalSnapshot({
    destination: third,
    previous: second,
    sources: [{ entryName: "nested/unchanged.txt", data: Buffer.from("stable contents") }],
  });
  assert.deepEqual(recovered, { copied: 1, reused: 0, bytes: 15 });
  assert.equal(await readFile(join(third, "nested", "unchanged.txt"), "utf8"), "stable contents");

  const priorSentinel = join(root, "prior-sentinel");
  await mkdir(priorSentinel);
  await writeFile(join(priorSentinel, "keep"), "unchanged");
  await assert.rejects(
    writeIncrementalSnapshot({
      destination: join(root, "bad-traversal"),
      previous: priorSentinel,
      sources: [{ entryName: "../escape", data: Buffer.from("x") }],
    }),
    /Unsafe snapshot entry path/u,
  );
  await assert.rejects(
    writeIncrementalSnapshot({
      destination: join(root, "bad-absolute"),
      sources: [{ entryName: "/absolute", data: Buffer.from("x") }],
    }),
    /Unsafe snapshot entry path/u,
  );
  await assert.rejects(
    writeIncrementalSnapshot({
      destination: join(root, "bad-device"),
      sources: [{ entryName: "CON.txt", data: Buffer.from("x") }],
    }),
    /Unsafe snapshot entry path/u,
  );
  await assert.rejects(
    writeIncrementalSnapshot({
      destination: join(root, "bad-duplicate"),
      sources: [
        { entryName: "same.txt", data: Buffer.from("one") },
        { entryName: "SAME.txt", data: Buffer.from("two") },
      ],
    }),
    /Duplicate snapshot entry path/u,
  );

  const symlinkSnapshot = join(root, "symlink-snapshot");
  await mkdir(symlinkSnapshot);
  await symlink(priorSentinel, join(symlinkSnapshot, "linked"), "junction");
  await assert.rejects(
    writeIncrementalSnapshot({
      destination: join(root, "bad-previous-link"),
      previous: symlinkSnapshot,
      sources: [{ entryName: "linked/keep", data: Buffer.from("unchanged") }],
    }),
    /symlink/u,
  );

  const largeData = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  const largeSource = join(sourceRoot, "large.bin");
  await writeFile(largeSource, largeData);
  const largePrevious = join(root, "large-previous");
  const largeNext = join(root, "large-next");
  await writeIncrementalSnapshot({
    destination: largePrevious,
    sources: [{ entryName: "large.bin", filePath: largeSource, size: largeData.length }],
  });
  const largeResult = await writeIncrementalSnapshot({
    destination: largeNext,
    previous: largePrevious,
    sources: [{ entryName: "large.bin", filePath: largeSource, size: largeData.length }],
    beforeCopy: async () => {
      throw new Error("simulated low scratch space");
    },
  });
  assert.deepEqual(largeResult, { copied: 0, reused: 1, bytes: 0 });
  assert.equal((await stat(join(largePrevious, "large.bin"))).ino, (await stat(join(largeNext, "large.bin"))).ino);

  const changedLargeData = Buffer.alloc(largeData.length, 0x6b);
  const changedLargeDestination = join(root, "large-changed-low-space");
  let reservedBytes = 0;
  await assert.rejects(
    writeIncrementalSnapshot({
      destination: changedLargeDestination,
      previous: largePrevious,
      sources: [{ entryName: "large.bin", data: changedLargeData }],
      beforeCopy: async (requiredBytes) => {
        reservedBytes = requiredBytes;
        throw new Error("simulated low scratch space for changed file");
      },
    }),
    /simulated low scratch space for changed file/u,
  );
  assert.equal(reservedBytes, changedLargeData.length);
  await rm(changedLargeDestination, { recursive: true, force: true });

  const previousAncestor = join(root, "previous-ancestor");
  const previousChild = join(previousAncestor, "snapshot");
  const ancestorJunction = join(root, "previous-ancestor-junction");
  await mkdir(previousAncestor);
  await mkdir(previousChild);
  await symlink(previousAncestor, ancestorJunction, "junction");
  await assert.rejects(
    writeIncrementalSnapshot({
      destination: join(root, "bad-previous-ancestor-junction"),
      previous: join(ancestorJunction, "snapshot"),
      sources: [{ entryName: "entry.txt", data: Buffer.from("entry") }],
    }),
    /must not contain a symlink or junction/u,
  );

  const sourceRaceDestination = join(root, "bad-source-change-after-hash");
  await assert.rejects(
    writeIncrementalSnapshot({
      destination: sourceRaceDestination,
      previous: priorSentinel,
      sources: [{ entryName: "changed.txt", filePath: liveChanged, size: 12 }],
      beforeCopy: async () => {
        await writeFile(liveChanged, "bad contents");
      },
    }),
    /Snapshot source changed between hashing and copying/u,
  );
  await assert.rejects(readFile(join(sourceRaceDestination, "changed.txt")), { code: "ENOENT" });
  assert.deepEqual(await readdir(sourceRaceDestination), []);
  await rm(sourceRaceDestination, { recursive: true, force: true });
  assert.equal(await readFile(join(priorSentinel, "keep"), "utf8"), "unchanged");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("backup incremental snapshot regression passed");
