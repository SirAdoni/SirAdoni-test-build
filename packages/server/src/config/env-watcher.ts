// ──────────────────────────────────────────────
// .env hot-reload watcher
// ──────────────────────────────────────────────
// Watches the active runtime .env file and re-applies changes to process.env
// without requiring a server restart. Most security middleware (basic-auth,
// IP allowlist, CSRF, admin secret, etc.) reads via getter functions in
// runtime-config.ts, so updates take effect on the next request.
//
// A small set of variables are bound at boot and CANNOT take effect from a
// reload — we still propagate them to process.env, but log a warning so the
// operator knows a restart is required for them.
//
// #4707: the watcher previously stat-polled the file every 2s (`watchFile`),
// making it the highest-frequency permanent timer on an idle server — a real
// cost on phone-hosted (Termux) installs. It now uses an event-driven
// `fs.watch` on the PARENT DIRECTORY, filtered to the env file's basename:
// directory-watching survives atomic-replace editors (which rename a new
// inode over the file, detaching file-level watchers) and works when the file
// does not exist yet. If the watch cannot be ESTABLISHED (setup throws or the
// watcher errors), it falls back to stat-polling at a 30s interval — env
// edits are human-timescale, so worst-case latency stays acceptable at 1/15th
// the wakeups. Note the limits of that fallback: on setups where the watch
// registers but change events never arrive (e.g. the file is edited from
// another machine across a network mount, or from the host into a container
// bind mount), nothing fails and nothing falls back — set
// `MARINARA_ENV_WATCH=poll` there to force the 30s stat-poll, which sees
// every write. `MARINARA_ENV_WATCH=0` disables the watcher entirely; manual
// reloads (`reloadNow`) keep working regardless.

import { existsSync, statSync, watch, watchFile, unwatchFile, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { logger, refreshConsoleLogLevel } from "../lib/logger.js";
import { isSecretEnvKey } from "../lib/diagnostics.js";
import { getEnvFilePath, getLogLevel, reloadRuntimeEnv, type EnvReloadResult } from "./runtime-config.js";
import { personalServerExtensionRuntime } from "../services/extensions/personal-server-extension-runtime.js";

// Keys whose values are bound at process / app startup and won't take effect
// without a full restart, even though we propagate them to process.env.
//
// CORS_ORIGINS is intentionally NOT in this list — the @fastify/cors plugin
// uses a function-based origin that re-reads getCorsConfig() per request
// (see cors-config.ts), so adding/removing origins is hot-reloadable. The
// only sub-case that still needs a restart is switching between an explicit
// origin list and "*" (the credentials response header changes), but that's
// rare enough that we don't list the var here as "always restart-required."
const RESTART_REQUIRED_KEYS = new Set<string>([
  "PORT",
  "HOST",
  "SSL_CERT",
  "SSL_KEY",
  "DATA_DIR",
  "FILE_STORAGE_DIR",
  // Read once at module load to build the lazy-table tier (#5592).
  "MARINARA_EAGER_STORAGE",
  "MARINARA_ENV_FILE",
  "ENCRYPTION_KEY",
  "TZ",
  "AUTO_OPEN_BROWSER",
  "AUTO_CREATE_DEFAULT_CONNECTION",
  "NODE_ENV",
  "IMAGE_GEN_TIMEOUT_MS",
  "VIDEO_GEN_TIMEOUT_MS",
  "VIDEO_GEN_MAX_RESPONSE_BYTES",
  "SPRITE_GENERATION_TIMEOUT_MS",
  "SPRITE_ANIMATED_FFMPEG_TIMEOUT_MS",
  "GOOGLE_VEO_VIDEO_POLL_INTERVAL_MS",
  "XAI_VIDEO_POLL_INTERVAL_MS",
  "OPENROUTER_VIDEO_POLL_INTERVAL_MS",
  "SEEDANCE_VIDEO_POLL_INTERVAL_MS",
  "COMFYUI_GEN_TIMEOUT",
  // Fastify reads the LogController configuration once at boot (app.ts), so
  // toggling this after startup has no effect until a restart.
  "LOG_DISABLE_REQUEST_LOGGING",
  "LOG_DIR",
  "LOG_FILE_LEVEL",
  "LOG_FILE_MAX_MB",
  "LOG_FILE_KEEP",
  // The watcher mode itself is decided once at startup.
  "MARINARA_ENV_WATCH",
]);

// The only keys whose values may appear in a log line. Every other key is logged
// by name with a presence marker; secret keys (isSecretEnvKey) also hide length.
const LOGGABLE_VALUE_KEYS = new Set<string>([
  "LOG_LEVEL",
  "LOG_FILE_LEVEL",
  "PORT",
  "HOST",
  "CORS_ORIGINS",
  "MARINARA_LITE",
]);

/** Debounce window for fs.watch events — editors fire several per save. */
export const ENV_WATCH_DEBOUNCE_MS = 250;

/** Stat-poll interval when fs.watch is unavailable (was 2s — see #4707). */
export const ENV_WATCH_FALLBACK_POLL_MS = 30_000;

/** `MARINARA_ENV_WATCH=0` (or false/off/no) disables the watcher; anything else keeps it on. */
export function isEnvWatchDisabled(rawValue: string | undefined): boolean {
  if (rawValue === undefined) return false;
  const normalized = rawValue.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

/**
 * `MARINARA_ENV_WATCH`: unset/anything → event-driven watch; `poll` → forced
 * 30s stat-poll (for setups where change events never arrive, e.g. remote
 * edits across network mounts); 0/false/off/no → no watching at all.
 */
export function resolveEnvWatchMode(rawValue: string | undefined): "watch" | "poll" | "off" {
  if (isEnvWatchDisabled(rawValue)) return "off";
  return rawValue?.trim().toLowerCase() === "poll" ? "poll" : "watch";
}

/** How a changed .env value appears in the log: the value only for LOGGABLE_VALUE_KEYS. */
export function maskValue(key: string, value: string | undefined): string {
  if (value === undefined) return "<unset>";
  if (value === "") return "<empty>";
  if (isSecretEnvKey(key)) return "<set>";
  if (!LOGGABLE_VALUE_KEYS.has(key)) return `<set, length=${value.length}>`;
  return value;
}

function describeKey(key: string): string {
  return `${key}=${maskValue(key, process.env[key])}`;
}

function applyLogLevel(diff: EnvReloadResult) {
  const watchedKeys = ["LOG_LEVEL", "LOG_PRESET"];
  if (
    !watchedKeys.some((key) => diff.updated.includes(key) || diff.added.includes(key) || diff.removed.includes(key))
  ) {
    return;
  }
  const next = getLogLevel();
  refreshConsoleLogLevel();
  logger.debug("[env-watcher] Applied console LOG_LEVEL=%s", next);
}

function applyExternalExtensionsGate(diff: EnvReloadResult) {
  const key = "ENABLE_EXTERNAL_EXTENSIONS";
  if (!diff.updated.includes(key) && !diff.added.includes(key) && !diff.removed.includes(key)) return;
  void personalServerExtensionRuntime.enforceExternalPolicy();
}

/**
 * One `config.reload` line per effective change. `added` and `updated` read
 * `KEY=<masked>`, `removed` lists names. The line is a warn when a changed key
 * only takes effect after a restart (`restartRequired`).
 */
export function logDiff(diff: EnvReloadResult, envPath: string = getEnvFilePath()) {
  const totalChanges = diff.added.length + diff.updated.length + diff.removed.length;
  if (totalChanges === 0) {
    logger.debug(
      { event: "config.reload", outcome: "skipped", envPath },
      "[env-watcher] .env modified, no effective changes",
    );
    return;
  }

  const restartRequired = [...diff.added, ...diff.updated, ...diff.removed].filter((key) =>
    RESTART_REQUIRED_KEYS.has(key),
  );
  logger[restartRequired.length > 0 ? "warn" : "info"](
    {
      event: "config.reload",
      outcome: "ok",
      added: diff.added.map(describeKey),
      updated: diff.updated.map(describeKey),
      removed: [...diff.removed],
      restartRequired,
      envPath,
    },
    "[env-watcher] .env changed (%d keys)",
    totalChanges,
  );
}

export interface EnvWatcherHandle {
  stop(): void;
  reloadNow(): EnvReloadResult | null;
}

export function startEnvWatcher(): EnvWatcherHandle {
  const envPath = getEnvFilePath();
  let stopped = false;

  const runReload = (): EnvReloadResult | null => {
    try {
      const diff = reloadRuntimeEnv();
      logDiff(diff, envPath);
      applyLogLevel(diff);
      applyExternalExtensionsGate(diff);
      return diff;
    } catch (err) {
      logger.error({ event: "config.reload", outcome: "failed", envPath, err }, "[env-watcher] Failed to reload .env");
      return null;
    }
  };

  const mode = resolveEnvWatchMode(process.env.MARINARA_ENV_WATCH);
  if (mode === "off") {
    logger.info("[env-watcher] Disabled via MARINARA_ENV_WATCH; .env changes require a restart or manual reload");
    return {
      stop() {
        stopped = true;
      },
      reloadNow: runReload,
    };
  }

  if (!existsSync(envPath)) {
    logger.info(`[env-watcher] No .env file at ${envPath}; watcher will start once the file is created`);
  } else {
    logger.info(`[env-watcher] Watching ${envPath} for changes (changes propagate without restart)`);
  }

  // Track the last seen mtime/size to ignore events where nothing actually
  // changed (both watch backends can fire on attribute touches too).
  let lastMtimeMs = existsSync(envPath) ? statSync(envPath).mtimeMs : 0;
  let lastSize = existsSync(envPath) ? statSync(envPath).size : -1;

  const processStats = (curr: { mtimeMs: number; size: number }, prev: { mtimeMs: number }) => {
    if (stopped) return;
    if (curr.mtimeMs === 0 && prev.mtimeMs !== 0) {
      logger.warn(`[env-watcher] .env disappeared at ${envPath}; clearing previously loaded keys`);
    }
    if (curr.mtimeMs === lastMtimeMs && curr.size === lastSize) return;
    lastMtimeMs = curr.mtimeMs;
    lastSize = curr.size;
    runReload();
  };

  const statAndProcess = () => {
    const prevMtimeMs = lastMtimeMs;
    let curr = { mtimeMs: 0, size: -1 };
    try {
      const stats = statSync(envPath);
      curr = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      /* file missing — curr stays zeroed, matching watchFile's disappeared shape */
    }
    processStats(curr, { mtimeMs: prevMtimeMs });
  };

  // Stat-polling path, at a human-timescale interval instead of the old 2s
  // (#4707). Used when directory watching cannot be established, or always
  // when the operator forces it with MARINARA_ENV_WATCH=poll (the remedy for
  // setups where watch events never arrive, e.g. remote edits over a mount).
  const startPolling = () => {
    watchFile(envPath, { interval: ENV_WATCH_FALLBACK_POLL_MS, persistent: false }, processStats);
  };
  const startPollingFallback = (reason: unknown) => {
    if (stopped) return;
    logger.warn(
      { err: reason instanceof Error ? reason : undefined },
      `[env-watcher] Directory watch unavailable; falling back to ${ENV_WATCH_FALLBACK_POLL_MS / 1000}s stat-polling`,
    );
    startPolling();
  };

  // Primary: event-driven watch on the parent directory, filtered to the env
  // file's basename. Zero idle wakeups; survives atomic replaces and the file
  // not existing yet. Events are debounced because editors fire several per
  // save, and every burst funnels through the mtime/size dedupe above.
  const envBasename = basename(envPath);
  let dirWatcher: FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let usingFallback = false;

  // The debounce resets on every event, so a continuously-busy directory
  // (platforms that omit the filename report every neighbor's churn) could
  // starve the stat indefinitely. Bound the deferral: after 4 debounce
  // windows of uninterrupted events, stat anyway.
  let firstEventAt = 0;
  const scheduleProcess = () => {
    if (stopped) return;
    const now = Date.now();
    if (firstEventAt === 0) firstEventAt = now;
    if (now - firstEventAt >= ENV_WATCH_DEBOUNCE_MS * 4) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
      firstEventAt = 0;
      statAndProcess();
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      firstEventAt = 0;
      statAndProcess();
    }, ENV_WATCH_DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  if (mode === "poll") {
    usingFallback = true;
    logger.info(
      `[env-watcher] MARINARA_ENV_WATCH=poll — stat-polling every ${ENV_WATCH_FALLBACK_POLL_MS / 1000}s instead of watching for change events`,
    );
    startPolling();
  } else {
    try {
      dirWatcher = watch(dirname(envPath), { persistent: false }, (_eventType, filename) => {
        // Some platforms omit the filename; treat those events conservatively
        // as potentially ours — the debounce + stat dedupe keeps them cheap.
        if (filename && filename !== envBasename) return;
        scheduleProcess();
      });
      dirWatcher.on("error", (err) => {
        dirWatcher?.close();
        dirWatcher = null;
        if (!usingFallback) {
          usingFallback = true;
          startPollingFallback(err);
        }
      });
      // Some platforms tear the watch down with a bare 'close' and no
      // 'error'. Our own stop()/error paths are excluded by the guards.
      dirWatcher.on("close", () => {
        if (stopped || usingFallback) return;
        dirWatcher = null;
        usingFallback = true;
        startPollingFallback(new Error("directory watcher closed unexpectedly"));
      });
    } catch (err) {
      usingFallback = true;
      startPollingFallback(err);
    }
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      dirWatcher?.close();
      dirWatcher = null;
      if (usingFallback) unwatchFile(envPath, processStats);
    },
    reloadNow: runReload,
  };
}
