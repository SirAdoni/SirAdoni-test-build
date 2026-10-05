import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, link, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

type StoredZipEntrySource =
  | { entryName: string; data: Buffer; mtime?: Date }
  | { entryName: string; buildData: () => Buffer; mtime?: Date }
  | {
      entryName: string;
      filePath: string;
      size: number;
      mtime?: Date;
      tolerateSourceChanges?: boolean;
      allowLargeStoredEntry?: boolean;
    };

export type IncrementalSnapshotResult = { copied: number; reused: number; bytes: number };

type IncrementalSnapshotOptions = {
  sources: StoredZipEntrySource[];
  destination: string;
  previous?: string;
  beforeCopy?: (requiredBytes: number) => Promise<void>;
};

function safeEntryParts(entryName: string): string[] {
  if (
    !entryName ||
    entryName.includes("\0") ||
    entryName.includes("\\") ||
    entryName.startsWith("/") ||
    isAbsolute(entryName) ||
    /^[a-zA-Z]:/u.test(entryName)
  ) {
    throw new Error(`Unsafe snapshot entry path: ${entryName}`);
  }
  const parts = entryName.split("/");
  if (
    parts.some((part) => {
      const deviceName = (part.split(".")[0] ?? "").replace(/[ .]+$/u, "").toUpperCase();
      return (
        !part ||
        part === "." ||
        part === ".." ||
        /[<>:"|?*]/u.test(part) ||
        /[ .]$/u.test(part) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(deviceName)
      );
    })
  ) {
    throw new Error(`Unsafe snapshot entry path: ${entryName}`);
  }
  return parts;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertRegularPreviousFile(root: string, parts: string[]): Promise<string> {
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Previous snapshot contains a symlink: ${current}`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Previous snapshot path is not a directory: ${current}`);
    }
    if (index === parts.length - 1 && !info.isFile()) {
      throw new Error(`Previous snapshot entry is not a regular file: ${current}`);
    }
    const resolvedCurrent = await realpath(current);
    if (!isWithin(root, resolvedCurrent)) throw new Error(`Previous snapshot path escapes its root: ${current}`);
  }
  return current;
}

function sourceBuffer(source: StoredZipEntrySource): Buffer | null {
  if ("data" in source) return source.data;
  if ("buildData" in source) return source.buildData();
  return null;
}

async function hashSource(source: StoredZipEntrySource, data: Buffer | null): Promise<string> {
  if (data !== null) return createHash("sha256").update(data).digest("hex");

  const fileSource = source as Extract<StoredZipEntrySource, { filePath: string }>;
  const before = await stat(fileSource.filePath);
  if (!before.isFile() || before.size !== fileSource.size) {
    throw new Error(`Snapshot source changed before it could be read: ${source.entryName}`);
  }
  const hash = await hashFile(fileSource.filePath);
  const after = await stat(fileSource.filePath);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) {
    throw new Error(`Snapshot source changed while it was being read: ${source.entryName}`);
  }
  return hash;
}

async function copySource(
  source: StoredZipEntrySource,
  temporaryPath: string,
  data: Buffer | null,
): Promise<{ hash: string; bytes: number }> {
  if (data !== null) {
    await writeFile(temporaryPath, data, { flag: "wx", mode: 0o600 });
    return { hash: createHash("sha256").update(data).digest("hex"), bytes: data.length };
  }

  const fileSource = source as Extract<StoredZipEntrySource, { filePath: string }>;
  const before = await stat(fileSource.filePath);
  if (!before.isFile() || before.size !== fileSource.size) {
    throw new Error(`Snapshot source changed before it could be copied: ${source.entryName}`);
  }
  let bytes = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(fileSource.filePath), hashing, createWriteStreamExclusive(temporaryPath));
  const after = await stat(fileSource.filePath);
  if (
    bytes !== fileSource.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ino !== before.ino
  ) {
    throw new Error(`Snapshot source changed while it was being copied: ${source.entryName}`);
  }
  return { hash: await hashFile(temporaryPath), bytes };
}

function createWriteStreamExclusive(path: string) {
  // Opening with wx prevents a concurrent or pre-existing path from being overwritten.
  return createWriteStream(path, { flags: "wx", mode: 0o600 });
}

/** Write a self-contained directory snapshot. The caller owns publication and failed-destination cleanup. */
export async function writeIncrementalSnapshot({
  sources,
  destination,
  previous,
  beforeCopy,
}: IncrementalSnapshotOptions): Promise<IncrementalSnapshotResult> {
  const destinationPath = resolve(destination);
  const destinationParent = dirname(destinationPath);
  const parentInfo = await stat(destinationParent);
  if (!parentInfo.isDirectory())
    throw new Error(`Snapshot destination parent is not a directory: ${destinationParent}`);
  if ((await realpath(destinationParent)) !== destinationParent) {
    throw new Error(`Snapshot destination parent must not contain a symlink or junction: ${destinationParent}`);
  }
  await mkdir(destinationPath, { recursive: false, mode: 0o700 });

  let previousRoot: string | undefined;
  if (previous !== undefined) {
    const previousPath = resolve(previous);
    const previousStat = await lstat(previous);
    if (!previousStat.isDirectory() || previousStat.isSymbolicLink()) {
      throw new Error(`Previous snapshot must be a real directory: ${previous}`);
    }
    previousRoot = await realpath(previousPath);
    if (previousRoot !== previousPath) {
      throw new Error(`Previous snapshot path must not contain a symlink or junction: ${previous}`);
    }
  }

  const names = new Set<string>();
  const entries = sources.map((source) => ({ source, parts: safeEntryParts(source.entryName) }));
  for (const { source } of entries) {
    const normalizedName = source.entryName.toLocaleLowerCase("en-US");
    if (names.has(normalizedName)) throw new Error(`Duplicate snapshot entry path: ${source.entryName}`);
    names.add(normalizedName);
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join("/").toLocaleLowerCase("en-US"))) {
        throw new Error(`Conflicting snapshot file and directory paths: ${name}`);
      }
    }
  }

  let copied = 0;
  let reused = 0;
  let bytes = 0;
  for (const { source, parts } of entries) {
    const outputPath = join(destinationPath, ...parts);
    if (!isWithin(destinationPath, resolve(outputPath)))
      throw new Error(`Snapshot destination path escapes its root: ${source.entryName}`);
    await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
    const tempPath = `${outputPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      const data = sourceBuffer(source);
      const requiredBytes = "filePath" in source ? source.size : data!.length;
      const sourceHash = await hashSource(source, data);
      let previousPath: string | undefined;
      if (previousRoot !== undefined) {
        try {
          previousPath = await assertRegularPreviousFile(previousRoot, parts);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (previousPath !== undefined && (await hashFile(previousPath)) === sourceHash) {
        try {
          await link(previousPath, outputPath);
        } catch (error) {
          throw new Error(
            `Cannot reuse unchanged snapshot entry '${source.entryName}' because hard links are unavailable; ` +
              "place snapshots on the same filesystem or use a filesystem that supports hard links.",
            { cause: error },
          );
        }
        reused++;
      } else {
        await beforeCopy?.(requiredBytes);
        const copiedEntry = await copySource(source, tempPath, data);
        if (copiedEntry.hash !== sourceHash) {
          throw new Error(`Snapshot source changed between hashing and copying: ${source.entryName}`);
        }
        await chmod(tempPath, 0o400);
        await rename(tempPath, outputPath);
        copied++;
        bytes += copiedEntry.bytes;
      }
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  return { copied, reused, bytes };
}
