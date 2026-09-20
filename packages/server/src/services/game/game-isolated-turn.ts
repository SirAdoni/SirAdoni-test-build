import { randomUUID } from "node:crypto";
import { logger } from "../../lib/logger.js";

const MAX_BEATS = 24;
const MAX_ACTORS = 12;
const MAX_BEAT_TEXT = 4_000;
const MAX_ACTION_CHARS = 8_000;
// A single actor may need to enumerate a bounded visible roster (for example,
// a household introduction) in one turn. Keep the cap bounded while allowing
// one line per member of a normal scene roster.
export const ISOLATED_MAX_LINES_PER_ACTOR = 24;
const MAX_LINE_TEXT = 2_000;

export type IsolatedGameActor = {
  actorId: string;
  name: string;
  card: string;
  authorizedMemory?: string;
};

export type IsolatedGamePlan = {
  publicScene: Array<{ beat: number; text: string; perceivedBy: string[] }>;
  actorRequests: Array<{ beat: number; actorId: string }>;
};

export type IsolatedGameActorLine = {
  type?: "main" | "side" | "action" | "thought" | "whisper";
  text: string;
  expression?: string;
  targetActorId?: string;
};

export type IsolatedGameActorOutput = {
  actorId: string;
  lines: IsolatedGameActorLine[];
};

export type IsolatedGameActorPrompt = {
  expectedActorId: string;
  actorName: string;
  ownCard: string;
  authorizedMemory: string;
  publicScene: readonly IsolatedGamePlan["publicScene"][number][];
};

export type IsolatedGameTurnResult = {
  content: string;
  plan: IsolatedGamePlan;
  actorDiagnostics: Array<{
    actorId: string;
    status: "accepted" | "failed" | "omitted";
    reason?: string;
    requestId: string;
  }>;
};

export type IsolatedGameTurnInput = {
  /** Passed only to the privileged planner. It is never present in actor prompts. */
  gmPrompt: string;
  playerAction?: string;
  actors: readonly IsolatedGameActor[];
  playerActorId?: string;
  playerActorName?: string;
  plan: (gmPrompt: string, signal: AbortSignal) => Promise<unknown>;
  actor: (prompt: IsolatedGameActorPrompt, signal: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  maxConcurrency?: number;
};

const partyLinePattern = /^\s*\[[^\]\r\n]+\]\s*\[(?:main|side|extra|action|thought|whisper(?::[^\]\r\n]+)?)\]/imu;
const instructionPattern =
  /<\/?(?:system|instruction|private|gm|secret|thought|internal)[^>]*>|\b(?:ignore|follow)\s+(?:all\s+)?(?:previous|above)\s+instructions?\b/imu;
const speakerPattern = /^\s*\[[^\]\r\n]+\]\s*\[[^\]\r\n]+\]\s*(?:\[[^\]\r\n]+\])?\s*:/mu;

function fail(message: string): never {
  throw new Error(`ISOLATED_TURN_INVALID: ${message}`);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  if (value.length > max) fail(`${field} exceeds ${max} characters`);
  return value.trim();
}

function actorId(value: unknown, field: string): string {
  return text(value, field, 300);
}

function actorName(value: unknown, field: string): string {
  const name = text(value, field, 300);
  if (/[\[\]\r\n:]/u.test(name)) fail(`${field} contains format delimiter characters`);
  return name;
}

function validatePublicText(value: unknown, field: string): string {
  const result = text(value, field, MAX_BEAT_TEXT);
  if (partyLinePattern.test(result) || speakerPattern.test(result)) fail(`${field} contains inline dialogue`);
  if (instructionPattern.test(result)) fail(`${field} contains private or instruction markup`);
  return result;
}

function normalizePlan(value: unknown, actors: readonly IsolatedGameActor[], playerActorId?: string): IsolatedGamePlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("plan must be an object");
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.publicScene) || !Array.isArray(raw.actorRequests)) fail("plan arrays are required");
  if (raw.publicScene.length === 0 || raw.publicScene.length > MAX_BEATS) fail("invalid publicScene count");
  if (raw.actorRequests.length > MAX_ACTORS) fail("invalid actorRequests count");

  const beats = new Set<number>();
  const publicScene = raw.publicScene.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`publicScene[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    if (!Number.isInteger(row.beat) || Number(row.beat) < 0 || Number(row.beat) >= MAX_BEATS)
      fail(`publicScene[${index}].beat is invalid`);
    const beat = Number(row.beat);
    if (beats.has(beat)) fail(`duplicate public scene beat ${beat}`);
    beats.add(beat);
    if (!Array.isArray(row.perceivedBy)) fail(`publicScene[${index}].perceivedBy must be an array`);
    const perceivedBy = row.perceivedBy.map((id, audienceIndex) =>
      actorId(id, `publicScene[${index}].perceivedBy[${audienceIndex}]`),
    );
    if (new Set(perceivedBy).size !== perceivedBy.length) fail(`publicScene[${index}].perceivedBy contains duplicates`);
    return { beat, text: validatePublicText(row.text, `publicScene[${index}].text`), perceivedBy };
  });
  publicScene.sort((left, right) => left.beat - right.beat);

  const actorById = new Map<string, IsolatedGameActor>();
  for (const actor of actors) {
    const id = actorId(actor.actorId, "actor.actorId");
    if (actorById.has(id)) fail(`duplicate trusted actor ${id}`);
    actorName(actor.name, `actor ${id}.name`);
    text(actor.card, `actor ${id}.card`, 20_000);
    if (actor.authorizedMemory !== undefined && actor.authorizedMemory.length > 20_000)
      fail(`actor ${id}.authorizedMemory exceeds 20000 characters`);
    actorById.set(id, { ...actor, actorId: id });
  }
  if (actorById.size > MAX_ACTORS) fail("trusted actor roster is too large");

  const requested = new Set<string>();
  const actorRequests = raw.actorRequests.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`actorRequests[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    if (!Number.isInteger(row.beat) || !beats.has(Number(row.beat)))
      fail(`actorRequests[${index}] references a missing beat`);
    const id = actorId(row.actorId, `actorRequests[${index}].actorId`);
    if (!actorById.has(id)) fail(`actorRequests[${index}] references an unknown actor`);
    if (playerActorId && id === playerActorId) fail("player actor cannot be requested");
    if (requested.has(id)) fail(`duplicate actor request ${id}`);
    requested.add(id);
    return { beat: Number(row.beat), actorId: id };
  });
  for (const beat of publicScene) {
    for (const audience of beat.perceivedBy) {
      if (!actorById.has(audience)) fail(`publicScene[${beat.beat}] references an unknown audience actor`);
    }
  }
  actorRequests.sort((left, right) => left.beat - right.beat || left.actorId.localeCompare(right.actorId));
  return { publicScene, actorRequests };
}

function normalizeActorOutput(
  value: unknown,
  expected: IsolatedGameActor,
  trustedActors: ReadonlyMap<string, IsolatedGameActor>,
  playerActorId?: string,
): IsolatedGameActorOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("actor output must be an object");
  const raw = value as Record<string, unknown>;
  const returnedId = actorId(raw.actorId, "actorOutput.actorId");
  if (returnedId !== expected.actorId) fail("actor output actorId does not match expected actor");
  if (playerActorId && returnedId === playerActorId) fail("actor output cannot speak for player");
  if (!Array.isArray(raw.lines) || raw.lines.length > ISOLATED_MAX_LINES_PER_ACTOR) fail("invalid actor output lines");
  const lines = raw.lines.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`actorOutput.lines[${index}] must be an object`);
    const line = item as Record<string, unknown>;
    const type = line.type === undefined ? "main" : line.type;
    if (!["main", "side", "action", "thought", "whisper"].includes(String(type))) fail("invalid actor line type");
    const content = text(line.text, `actorOutput.lines[${index}].text`, MAX_LINE_TEXT);
    if (/\r|\n/u.test(content) || partyLinePattern.test(content) || speakerPattern.test(content))
      fail("actor line contains an injected speaker line");
    if (instructionPattern.test(content)) fail("actor line contains private or instruction markup");
    const expression = line.expression === undefined ? undefined : text(line.expression, "actor line expression", 100);
    if (expression && /[\[\]\r\n:]/u.test(expression)) fail("actor line expression contains format markup");
    const requestedTargetActorId =
      line.targetActorId === undefined ? undefined : actorId(line.targetActorId, "actor line targetActorId");
    // Targeting is optional presentation metadata. Drop an untrusted target while
    // preserving the validated line text; never let a hallucinated ID erase a
    // legitimate actor response or create an external-actor reference.
    const targetActorId =
      requestedTargetActorId !== undefined &&
      (trustedActors.has(requestedTargetActorId) || requestedTargetActorId === playerActorId)
        ? requestedTargetActorId
        : undefined;
    return {
      type: type as IsolatedGameActorLine["type"],
      text: content,
      ...(expression ? { expression } : {}),
      ...(targetActorId ? { targetActorId } : {}),
    };
  });
  return { actorId: returnedId, lines };
}

function quoteDialogue(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function composeContent(
  plan: IsolatedGamePlan,
  actors: ReadonlyMap<string, IsolatedGameActor>,
  outputs: readonly IsolatedGameActorOutput[],
  playerActorId?: string,
  playerActorName?: string,
): string {
  const linesByBeat = new Map<number, string[]>();
  for (const output of outputs) {
    const actor = actors.get(output.actorId);
    if (!actor) continue;
    const request = plan.actorRequests.find((item) => item.actorId === output.actorId);
    if (!request) continue;
    const rendered = output.lines.map((line) => {
      const type = line.type ?? "main";
      const expression = line.expression ? ` [${line.expression}]` : "";
      const targetName = line.targetActorId
        ? line.targetActorId === playerActorId
          ? playerActorName
          : actors.get(line.targetActorId)?.name
        : undefined;
      const target = type === "whisper" && targetName ? `:${targetName}` : "";
      const content = type === "action" || type === "thought" ? line.text : quoteDialogue(line.text);
      return `[${actor.name}] [${type}${target}]${expression}: ${content}`;
    });
    linesByBeat.set(request.beat, [...(linesByBeat.get(request.beat) ?? []), ...rendered]);
  }
  const result: string[] = [];
  for (const beat of plan.publicScene) {
    result.push(beat.text);
    const actorLines = linesByBeat.get(beat.beat);
    if (actorLines?.length) result.push(actorLines.join("\n"));
  }
  return result.join("\n\n").trim();
}

export async function runIsolatedGameTurn(input: IsolatedGameTurnInput): Promise<IsolatedGameTurnResult> {
  const signal = input.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (
    input.maxConcurrency !== undefined &&
    (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > MAX_ACTORS)
  )
    fail("maxConcurrency must be a finite integer between 1 and 12");
  if (input.playerActorId !== undefined) actorId(input.playerActorId, "playerActorId");
  if (input.playerActorName !== undefined) actorName(input.playerActorName, "playerActorName");
  const playerAction = input.playerAction ?? "";
  if (playerAction.length > MAX_ACTION_CHARS) fail(`playerAction exceeds ${MAX_ACTION_CHARS} characters`);
  const actors = new Map<string, IsolatedGameActor>();
  const actorNames = new Set<string>();
  for (const actor of input.actors) {
    const id = actorId(actor.actorId, "actor.actorId");
    if (actors.has(id)) fail(`duplicate trusted actor ${id}`);
    const name = actorName(actor.name, `actor ${id}.name`);
    const nameKey = name.normalize("NFKC").trim().toLocaleLowerCase();
    if (actorNames.has(nameKey)) fail(`duplicate trusted actor name ${name}`);
    actorNames.add(nameKey);
    text(actor.card, `actor ${id}.card`, 20_000);
    if (actor.authorizedMemory !== undefined && actor.authorizedMemory.length > 20_000)
      fail(`actor ${id}.authorizedMemory exceeds 20000 characters`);
    actors.set(id, { ...actor, actorId: id, name });
  }
  const rawPlan = await input.plan(input.gmPrompt, signal);
  signal.throwIfAborted();
  const plan = normalizePlan(rawPlan, [...actors.values()], input.playerActorId);
  const diagnostics: IsolatedGameTurnResult["actorDiagnostics"] = [];
  const outputs: IsolatedGameActorOutput[] = [];
  const work = plan.actorRequests.map((request) => ({ request, requestId: randomUUID() }));
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  let next = 0;
  const worker = async () => {
    for (;;) {
      controller.signal.throwIfAborted();
      const item = work[next++];
      if (!item) return;
      const actor = actors.get(item.request.actorId)!;
      try {
        const raw = await input.actor(
          {
            expectedActorId: actor.actorId,
            actorName: actor.name,
            ownCard: actor.card,
            authorizedMemory: actor.authorizedMemory ?? "",
            publicScene: plan.publicScene.filter(
              (beat) => beat.beat <= item.request.beat && beat.perceivedBy.includes(actor.actorId),
            ),
          },
          controller.signal,
        );
        const output = normalizeActorOutput(raw, actor, actors, input.playerActorId);
        outputs.push(output);
        diagnostics.push({ actorId: actor.actorId, status: "accepted", requestId: item.requestId });
      } catch (error) {
        if (signal.aborted) throw error;
        logger.warn(error, "[isolated-game] Actor output rejected for actor %s", actor.actorId);
        diagnostics.push({
          actorId: actor.actorId,
          status: "omitted",
          reason: error instanceof Error ? error.message : String(error),
          requestId: item.requestId,
        });
      }
    }
  };
  try {
    const count = Math.min(Math.max(1, input.maxConcurrency ?? 2), Math.max(1, work.length));
    const settled = await Promise.allSettled(Array.from({ length: count }, () => worker()));
    const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
    if (rejected) throw rejected.reason;
  } finally {
    signal.removeEventListener("abort", abort);
  }
  signal.throwIfAborted();
  const actorOrder = new Map(plan.actorRequests.map((item, index) => [item.actorId, index]));
  outputs.sort((left, right) => (actorOrder.get(left.actorId) ?? 0) - (actorOrder.get(right.actorId) ?? 0));
  diagnostics.sort((left, right) => (actorOrder.get(left.actorId) ?? 0) - (actorOrder.get(right.actorId) ?? 0));
  return {
    content: composeContent(plan, actors, outputs, input.playerActorId, input.playerActorName),
    plan,
    actorDiagnostics: diagnostics,
  };
}
