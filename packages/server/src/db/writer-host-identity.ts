import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { logSuppressed } from "../lib/best-effort.js";

/** Keep identity outside synced campaign storage, stable across registry failures. */
export function persistentWriterHostId(cachePath: string, readMachineId: () => string | null): string | null {
  const readCached = () => {
    const value = readFileSync(cachePath, "utf8").trim();
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  };
  try {
    return readCached();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
  }
  const machineId = readMachineId();
  const identity = createHash("sha256")
    .update(machineId ? `marinara-writer-lease-v2\nwin32\n${machineId.toLowerCase()}` : randomUUID())
    .digest("hex");
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    // Never replace another launch's identity or a corrupt/unreadable cache.
    writeFileSync(cachePath, identity, { flag: "wx", mode: 0o600 });
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      try {
        return readCached();
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * How far apart two estimates of the same boot may drift (clock sync,
 * rounding) and still count as one boot. With a working clock two different
 * boots cannot be this close, since the earlier one lasted at least as long
 * as its uptime. A clock reset between boots (dead CMOS battery, start before
 * time sync) could in principle make them collide; the lease then misses its
 * boot-mismatch shortcut and falls back to the same-host PID checks, which
 * refuse rather than wrongly reclaim.
 */
export const BOOT_ID_CACHE_TOLERANCE_MS = 10_000;

type BootIdCacheRecord = { version: 1; approxBootMs: number; bootId: string };

function readBootIdCache(cachePath: string): BootIdCacheRecord | null {
  try {
    const value = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<BootIdCacheRecord> | null;
    if (
      value &&
      value.version === 1 &&
      typeof value.approxBootMs === "number" &&
      Number.isFinite(value.approxBootMs) &&
      typeof value.bootId === "string" &&
      value.bootId.length > 0 &&
      value.bootId.length <= 256
    ) {
      return value as BootIdCacheRecord;
    }
  } catch (error) {
    // Missing or unreadable: probe again.
    logSuppressed(error, { event: "storage.writerIdentity", stage: "readCache", level: "debug" });
  }
  return null;
}

/**
 * Boot identity for the writer lease without paying the slow probe on every
 * start. On Windows the exact value comes from a PowerShell CIM query that
 * takes about 1.5 to 2 seconds (and returns null when it hits its 2 second
 * timeout), run synchronously while the server module loads. The probe's
 * exact string is cached together with a cheap boot-time estimate
 * (now minus OS uptime); a later start whose estimate lands within
 * BOOT_ID_CACHE_TOLERANCE_MS reuses the cached string, which is byte-identical
 * to what the probe would print for this boot, so leases stay comparable with
 * builds that still probe. Any mismatch, corrupt cache or write failure falls
 * back to the probe, and a null probe result is never cached.
 */
export function cachedBootId(
  cachePath: string,
  approxBootMs: number,
  probe: () => string | null,
  toleranceMs = BOOT_ID_CACHE_TOLERANCE_MS,
): string | null {
  if (Number.isFinite(approxBootMs)) {
    const cached = readBootIdCache(cachePath);
    if (cached && Math.abs(cached.approxBootMs - approxBootMs) <= toleranceMs) return cached.bootId;
  }
  const bootId = probe();
  if (!bootId || !Number.isFinite(approxBootMs)) return bootId;
  const tmpPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const record: BootIdCacheRecord = { version: 1, approxBootMs, bootId };
    writeFileSync(tmpPath, JSON.stringify(record), { mode: 0o600 });
    renameSync(tmpPath, cachePath);
  } catch {
    // Caching is an optimisation only; the probe result is still correct.
    try {
      rmSync(tmpPath, { force: true });
    } catch (error) {
      logSuppressed(error, { event: "storage.writerIdentity", stage: "cleanupTmp", level: "debug" });
    }
  }
  return bootId;
}
