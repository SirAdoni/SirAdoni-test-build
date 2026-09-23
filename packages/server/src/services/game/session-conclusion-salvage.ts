// ──────────────────────────────────────────────
// Session conclusion salvage
// ──────────────────────────────────────────────
// A session conclusion is the most expensive single generation in a campaign
// (the whole session transcript in, tens of thousands of tokens out). Models
// sometimes return the right content in the wrong envelope: summary fields at
// the top level, the object nested under another key, split across several
// JSON fragments, or wrapped in prose. Recover the draft instead of discarding
// the generation, and keep a copy of every raw conclusion on disk.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDataDir } from "../../config/runtime-config.js";
import { logger } from "../../lib/logger.js";
import { parseGameJsonish, parseGameJsonishSequence } from "./jsonish.js";

const SUMMARY_TEXT_FIELDS = ["resumePoint", "partyDynamics", "partyState"] as const;
const SUMMARY_LIST_FIELDS = ["keyDiscoveries", "characterMoments", "littleDetails", "npcUpdates"] as const;
const SUMMARY_FIELDS = new Set<string>(["summary", ...SUMMARY_TEXT_FIELDS, ...SUMMARY_LIST_FIELDS, "statsSnapshot"]);
const SUMMARY_ALIASES = ["summary", "sessionSummary", "session_summary", "conclusion", "sessionConclusion"];
const MAX_SEARCH_DEPTH = 4;

export class SessionConclusionSalvageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionConclusionSalvageError";
  }
}

export type SalvagedSessionConclusion = {
  draft: Record<string, unknown>;
  repairs: string[];
};

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj => !!value && typeof value === "object" && !Array.isArray(value);

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join("\n");
  if (isObj(value)) return Object.values(value).map(toText).filter(Boolean).join(": ");
  return String(value);
}

function toList(value: unknown): string[] {
  if (Array.isArray(value))
    return value
      .map(toText)
      .map((item) => item.trim())
      .filter(Boolean);
  const text = toText(value).trim();
  return text ? [text] : [];
}

function summaryFieldCount(value: Obj): number {
  return Object.keys(value).filter((key) => SUMMARY_FIELDS.has(key) && key !== "summary").length;
}

/** Find the object that carries the conclusion, preferring an explicit summary object. */
function findConclusion(value: unknown, depth = 0): Obj | null {
  if (depth > MAX_SEARCH_DEPTH) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findConclusion(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isObj(value)) return null;
  if (isObj(value.summary) && isObj((value.summary as Obj).summary)) {
    // {summary: {summary: {...}, ...}}: one envelope too many.
    return { ...value, ...(value.summary as Obj) };
  }
  if (isObj(value.summary) || typeof value.summary === "string" || summaryFieldCount(value) >= 2) return value;
  for (const alias of SUMMARY_ALIASES) {
    if (!isObj(value[alias])) continue;
    const nested = value[alias] as Obj;
    const outer = { ...value };
    delete outer[alias];
    // The alias holds a whole conclusion (summary plus continuity fields).
    if (isObj(nested.summary)) return { ...outer, ...nested };
    // The alias holds the summary fields themselves.
    if (typeof nested.summary === "string" || summaryFieldCount(nested) >= 2) return { ...outer, summary: nested };
  }
  for (const child of Object.values(value)) {
    const found = findConclusion(child, depth + 1);
    if (found) return found;
  }
  return null;
}

const restartedCandidates = new WeakSet<object>();

function parseCandidates(raw: string): unknown[] {
  const candidates: unknown[] = [];
  try {
    candidates.push(parseGameJsonish(raw));
  } catch {
    // Fall through to restart and fragment parsing.
  }
  // A reply can hold a cut-off attempt followed by a complete one, glued together mid-string: the model abandoned
  // its first draft and wrote the conclusion again in the same response. Try each later conclusion start in order: the first one that parses is the outermost complete attempt
  // (later matches are the objects nested inside it).
  const starts = [...raw.matchAll(/\{\s*"summary"\s*:/g)].map((match) => match.index ?? 0).filter((index) => index > 0);
  for (const start of starts) {
    try {
      const restarted = parseGameJsonish(raw.slice(start));
      if (isObj(restarted)) restartedCandidates.add(restarted);
      candidates.push(restarted);
      break;
    } catch {
      // Not a complete attempt; try the next start.
    }
  }
  try {
    const fragments = parseGameJsonishSequence(raw);
    if (fragments.length > 1) {
      // Adjacent top-level objects are usually one conclusion split in pieces.
      const merged: Obj = {};
      for (const fragment of fragments) {
        if (!isObj(fragment)) continue;
        for (const [key, item] of Object.entries(fragment)) if (!(key in merged)) merged[key] = item;
      }
      candidates.push(merged, ...fragments);
    }
  } catch {
    // No usable fragments.
  }
  return candidates;
}

/**
 * Recover a session conclusion draft whose `summary` matches the factual
 * review schema. Throws SessionConclusionSalvageError when no summary text
 * exists anywhere in the output.
 */
export function salvageSessionConclusionDraft(raw: string): SalvagedSessionConclusion {
  const repairs: string[] = [];
  let conclusion: Obj | null = null;
  for (const candidate of parseCandidates(raw)) {
    conclusion = findConclusion(candidate);
    if (conclusion) {
      if (isObj(candidate) && restartedCandidates.has(candidate)) {
        repairs.push("used the last complete attempt from a reply that started the conclusion over");
      }
      if (candidate !== conclusion && !(isObj(candidate) && candidate.summary === conclusion.summary)) {
        repairs.push("located the conclusion inside a wrapper or split output");
      }
      break;
    }
  }
  if (!conclusion) {
    throw new SessionConclusionSalvageError("No session summary could be found in the generated conclusion.");
  }

  let source: Obj;
  if (isObj(conclusion.summary)) {
    source = { ...(conclusion.summary as Obj) };
    // Fields the model placed beside the summary object instead of inside it.
    for (const key of SUMMARY_FIELDS) {
      if (key !== "summary" && source[key] === undefined && conclusion[key] !== undefined) {
        source[key] = conclusion[key];
        repairs.push(`moved ${key} into the summary`);
      }
    }
  } else {
    source = {};
    for (const key of SUMMARY_FIELDS) if (conclusion[key] !== undefined) source[key] = conclusion[key];
    repairs.push("wrapped top-level summary fields into a summary object");
  }

  const summaryText = toText(source.summary).trim();
  if (!summaryText) {
    throw new SessionConclusionSalvageError("The generated conclusion has no readable summary text.");
  }
  if (typeof source.summary !== "string") repairs.push("converted summary to text");

  const summary: Obj = { ...source, summary: summaryText };
  for (const key of SUMMARY_TEXT_FIELDS) {
    if (typeof source[key] !== "string") {
      summary[key] = toText(source[key]);
      repairs.push(source[key] === undefined ? `filled missing ${key}` : `converted ${key} to text`);
    }
  }
  for (const key of SUMMARY_LIST_FIELDS) {
    const value = source[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      summary[key] = toList(value);
      repairs.push(value === undefined ? `filled missing ${key}` : `converted ${key} to a text list`);
    }
  }
  if (!isObj(source.statsSnapshot)) {
    summary.statsSnapshot = {};
    repairs.push("filled missing statsSnapshot");
  }

  const draft: Obj = { ...conclusion, summary };
  if (!isObj(conclusion.summary)) {
    for (const key of SUMMARY_FIELDS) if (key !== "summary") delete draft[key];
  }
  return { draft, repairs };
}

/** Keep every raw conclusion on disk so a failed save never loses the generation. */
export function persistRawSessionConclusion(args: {
  chatId: string;
  sessionNumber: number;
  raw: string;
  stage: string;
}): string | null {
  try {
    const dir = resolve(getDataDir(), "logs", "session-conclusions");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeChat = args.chatId.replace(/[^A-Za-z0-9_-]/g, "_");
    const file = resolve(dir, `${safeChat}-session${args.sessionNumber}-${args.stage}-${stamp}.txt`);
    writeFileSync(file, args.raw, "utf8");
    return file;
  } catch (error) {
    logger.warn(error, "[session/conclude] Could not persist raw session conclusion");
    return null;
  }
}
