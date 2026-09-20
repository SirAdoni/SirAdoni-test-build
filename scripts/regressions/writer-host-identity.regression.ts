import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistentWriterHostId } from "../../packages/server/src/db/writer-host-identity.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-host-identity-"));
try {
  const primary = join(dir, "primary", "id");
  const expected = createHash("sha256").update("marinara-writer-lease-v2\nwin32\nmachine-guid").digest("hex");
  assert.equal(
    persistentWriterHostId(primary, () => "MACHINE-GUID"),
    expected,
    "existing v2 identity is preserved",
  );
  assert.equal(
    persistentWriterHostId(primary, () => {
      throw new Error("registry unavailable");
    }),
    expected,
  );
  const fallback = join(dir, "fallback", "id");
  const localId = persistentWriterHostId(fallback, () => null);
  assert.match(localId!, /^[a-f0-9]{64}$/);
  assert.equal(
    persistentWriterHostId(fallback, () => "registry-now-available"),
    localId,
  );
  assert.notEqual(
    persistentWriterHostId(join(dir, "other", "id"), () => null),
    localId,
  );
  writeFileSync(fallback, "invalid");
  assert.equal(
    persistentWriterHostId(fallback, () => "guid"),
    null,
  );
  assert.equal(readFileSync(fallback, "utf8"), "invalid", "corrupt identity is never silently replaced");
  const raced = join(dir, "race");
  assert.equal(
    persistentWriterHostId(raced, () => {
      writeFileSync(raced, expected);
      return null;
    }),
    expected,
  );
  assert.equal(
    persistentWriterHostId(join(primary, "impossible"), () => null),
    null,
  );
  console.info(
    "Writer identity: stable ID compatibility, registry failure/recovery, separate hosts, race and fail-closed cache checks passed.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
