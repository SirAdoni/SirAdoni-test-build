import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPackageSharedEntry } from "../package-shared-entry.mjs";

const fixture = await mkdtemp(join(tmpdir(), "marinara-shared-bridge-proof-"));
let bridge;
try {
  const repo = join(fixture, "agents");
  const host = join(fixture, "host");
  await mkdir(join(repo, "sources"), { recursive: true });
  await mkdir(join(host, "packages/shared/dist"), { recursive: true });
  const games = ["uno", "chess", "poker", "eightball", "tic-tac-toe", "rock-paper-scissors"];
  const source = [
    'export * from "./engine/packages/shared/dist/index.js";',
    ...games.map((game) => `export * from "./engine/packages/shared/dist/features/turn-games/${game}/types.js";`),
  ].join("\n");
  const capturedPath = join(repo, "sources/package-shared.ts");
  await writeFile(capturedPath, source);
  await assert.rejects(createPackageSharedEntry(repo, host), { code: "ENOENT" });
  await writeFile(join(host, "packages/shared/dist/index.js"), "export const CURRENT_HOST = true;\n");
  bridge = await createPackageSharedEntry(repo, host);
  const generated = await readFile(bridge.entry, "utf8");
  assert.equal((generated.match(/export \* from/g) ?? []).length, 7);
  assert.ok(generated.includes(JSON.stringify(resolve(host, "packages/shared/dist/index.js").replaceAll("\\", "/"))));
  for (const game of games) assert.ok(generated.includes(`/features/turn-games/${game}/types.ts`));
  assert.equal(await readFile(capturedPath, "utf8"), source);
  await bridge.cleanup();
  await assert.rejects(readFile(bridge.entry), { code: "ENOENT" });
  const legacy = await createPackageSharedEntry(repo);
  assert.equal(legacy.entry, capturedPath);
  await legacy.cleanup();
  await writeFile(capturedPath, 'export * from "./changed-base.js";');
  await assert.rejects(createPackageSharedEntry(repo, host), /base changed/);
  console.log(
    "Fresh host bridge preserves six game exports and immutable captured input; missing/changed bases fail closed.",
  );
} finally {
  await bridge?.cleanup();
  await rm(fixture, { recursive: true, force: true });
}
