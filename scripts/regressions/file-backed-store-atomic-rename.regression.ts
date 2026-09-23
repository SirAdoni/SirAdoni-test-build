import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameWithTransientRetry } from "../../packages/server/src/db/file-backed-store.js";

const root = await mkdtemp(join(tmpdir(), "marinara-atomic-rename-"));
try {
  const from = join(root, "tmp");
  const to = join(root, "primary");
  await writeFile(from, "new");
  await writeFile(to, "old");
  let transientFailures = 0;
  await renameWithTransientRetry(
    from,
    to,
    async (source, destination) => {
      if (transientFailures++ < 2) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
      await rename(source, destination);
    },
    "win32",
    async () => {},
  );
  assert.equal(await readFile(to, "utf8"), "new");
  assert.equal(transientFailures, 3);

  await writeFile(from, "new-again");
  await writeFile(to, "old-again");
  let persistentFailures = 0;
  await assert.rejects(
    renameWithTransientRetry(
      from,
      to,
      async () => {
        persistentFailures += 1;
        throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
      "win32",
      async () => {},
    ),
  );
  assert.equal(persistentFailures, 6);
  assert.equal(await readFile(to, "utf8"), "old-again");

  let nonTransientFailures = 0;
  await assert.rejects(
    renameWithTransientRetry(
      from,
      to,
      async () => {
        nonTransientFailures += 1;
        throw Object.assign(new Error("invalid"), { code: "EINVAL" });
      },
      "win32",
      async () => {},
    ),
  );
  assert.equal(nonTransientFailures, 1);
} finally {
  await rm(root, { recursive: true, force: true });
}
