// ──────────────────────────────────────────────
// Build integrity: is the running dist the build of this src?
// ──────────────────────────────────────────────
// A stale tsbuildinfo, a partial copy or an edit after `pnpm build` leaves dist
// without modules that src has, or older than src. That fails much later as a
// confusing "Cannot find module" or as behaviour that ignores a fix. The build
// writes a source inventory into dist/config/build-meta.json; this compares it
// with dist and, when src is present, with src.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getBuildMeta, parseBuildMeta, type BuildMeta } from "../config/build-info.js";
import { logger } from "./logger.js";

export interface BuildIntegrity {
  runtime: "dist" | "tsx";
  stale: boolean;
  outcome: "ok" | "failed" | "skipped";
  commit: string | null;
  builtAt: string | null;
  /** srcFiles entries whose dist/<path>.js is missing (first 10). */
  missingInDist: string[];
  missingCount: number;
  /** src .ts files modified after builtAt (first 10). */
  newerFiles: string[];
  newerCount: number;
  /** src .ts files the build did not know about (first 10). */
  unknownSrc: string[];
  unknownCount: number;
}

const LIST_LIMIT = 10;
const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function listSourceFiles(srcDir: string): Array<{ rel: string; mtimeMs: number }> {
  const out: Array<{ rel: string; mtimeMs: number }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) walk(fullPath);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
        out.push({ rel: relative(srcDir, fullPath).split(sep).join("/"), mtimeMs: stat.mtimeMs });
    }
  };
  walk(srcDir);
  return out;
}

function emptyResult(runtime: "dist" | "tsx", outcome: BuildIntegrity["outcome"], meta?: BuildMeta | null) {
  return {
    runtime,
    stale: false,
    outcome,
    commit: meta?.commit ?? null,
    builtAt: meta?.builtAt ?? null,
    missingInDist: [],
    missingCount: 0,
    newerFiles: [],
    newerCount: 0,
    unknownSrc: [],
    unknownCount: 0,
  } satisfies BuildIntegrity;
}

function compare(serverRoot: string, meta: BuildMeta | null): BuildIntegrity {
  if (!meta || !Array.isArray(meta.srcFiles)) return emptyResult("dist", "skipped", meta);
  const distDir = join(serverRoot, "dist");
  const srcDir = join(serverRoot, "src");
  const missing = meta.srcFiles.filter((rel) => !existsSync(join(distDir, rel.replace(/\.ts$/, ".js"))));
  let newer: string[] = [];
  let unknown: string[] = [];
  if (existsSync(srcDir)) {
    const known = new Set(meta.srcFiles);
    const builtAtMs = meta.builtAt ? Date.parse(meta.builtAt) : NaN;
    const sources = listSourceFiles(srcDir);
    if (Number.isFinite(builtAtMs)) newer = sources.filter((file) => file.mtimeMs > builtAtMs).map((file) => file.rel);
    unknown = sources.filter((file) => !known.has(file.rel)).map((file) => file.rel);
  }
  const stale = missing.length > 0 || newer.length > 0 || unknown.length > 0;
  return {
    runtime: "dist",
    stale,
    outcome: stale ? "failed" : "ok",
    commit: meta.commit ?? null,
    builtAt: meta.builtAt ?? null,
    missingInDist: missing.slice(0, LIST_LIMIT),
    missingCount: missing.length,
    newerFiles: newer.sort().slice(0, LIST_LIMIT),
    newerCount: newer.length,
    unknownSrc: unknown.sort().slice(0, LIST_LIMIT),
    unknownCount: unknown.length,
  };
}

/**
 * Checks the running build once at startup. Under tsx it returns outcome
 * "skipped". Under dist, any finding logs one warn `startup.build_check` with
 * errorCode ME_BUILD_STALE; a clean build logs at debug.
 */
export function checkBuildIntegrity(): BuildIntegrity {
  const runtime = import.meta.url.includes("/dist/") ? "dist" : "tsx";
  if (runtime === "tsx") {
    logger.debug(
      { event: "startup.build_check", outcome: "skipped", runtime },
      "[startup] Build check skipped under tsx",
    );
    return emptyResult("tsx", "skipped");
  }
  const meta = getBuildMeta();
  const result = compare(SERVER_ROOT, meta);
  if (result.stale) {
    logger.warn(
      { event: "startup.build_check", errorCode: "ME_BUILD_STALE", ...result },
      "Running dist is older than src or missing modules; rebuild before trusting this run",
    );
  } else {
    logger.debug(
      {
        event: "startup.build_check",
        outcome: result.outcome,
        commit: result.commit,
        builtAt: result.builtAt,
        srcFileCount: meta?.srcFileCount,
      },
      "[startup] Build check passed",
    );
  }
  return result;
}

/**
 * Compares a server tree's dist with its build-meta.json, for the updater. It
 * does not log. `commitMatches` is true when no target commit is given or the
 * built commit starts with it (either side may be abbreviated).
 */
export function verifyDistAgainstMeta(
  serverRoot: string,
  targetCommit?: string,
): BuildIntegrity & { commitMatches: boolean } {
  const metaPath = join(serverRoot, "dist", "config", "build-meta.json");
  let meta: BuildMeta | null = null;
  try {
    meta = existsSync(metaPath) ? parseBuildMeta(readFileSync(metaPath, "utf8")) : null;
  } catch {
    meta = null;
  }
  const result = meta ? compare(serverRoot, meta) : { ...emptyResult("dist", "failed"), stale: true };
  const built = meta?.commit?.trim() ?? "";
  const target = targetCommit?.trim() ?? "";
  const commitMatches = !target || (!!built && (built.startsWith(target) || target.startsWith(built)));
  return { ...result, commitMatches };
}
