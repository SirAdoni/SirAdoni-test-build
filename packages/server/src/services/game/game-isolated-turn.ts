import { randomUUID } from "node:crypto";
import { logger } from "../../lib/logger.js";

const MAX_BEATS = 24;
const MAX_ACTORS = 12;
// The trusted catalogue is not an active cast: only validated actorRequests
// consume provider calls, which remain bounded by MAX_ACTORS.
const MAX_TRUSTED_ACTORS = 256;
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
  initiallyPresent?: boolean;
};

export type IsolatedGamePlan = {
  publicScene: Array<{
    beat: number;
    text: string;
    perceivedBy: string[];
    contextOnly?: boolean;
    arrivingActorIds?: string[];
  }>;
  actorRequests: Array<{ beat: number; actorId: string; perceivedBy: string[] }>;
  spatialDirective?: { type: "move"; destinationId: string };
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
  priorActorLines: Array<{
    beat: number;
    actorId: string;
    actorName: string;
    lines: IsolatedGameActorLine[];
  }>;
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
  resolveActorContext?: (actorId: string) => Promise<{ card: string; authorizedMemory?: string }>;
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

function spatialDestinationId(value: unknown, field: string): string {
  const id = text(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) fail(`${field} contains an invalid location ID`);
  return id;
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
    const contextOnly = row.contextOnly === undefined ? undefined : row.contextOnly;
    if (contextOnly !== undefined && typeof contextOnly !== "boolean")
      fail(`publicScene[${index}].contextOnly must be a boolean`);
    const arrivingActorIds = row.arrivingActorIds === undefined ? undefined : row.arrivingActorIds;
    if (arrivingActorIds !== undefined && !Array.isArray(arrivingActorIds))
      fail(`publicScene[${index}].arrivingActorIds must be an array`);
    const arrivalIds = arrivingActorIds?.map((id, arrivalIndex) =>
      actorId(id, `publicScene[${index}].arrivingActorIds[${arrivalIndex}]`),
    );
    if (arrivalIds && new Set(arrivalIds).size !== arrivalIds.length)
      fail(`publicScene[${index}].arrivingActorIds contains duplicates`);
    return {
      beat,
      text: validatePublicText(row.text, `publicScene[${index}].text`),
      perceivedBy,
      ...(contextOnly !== undefined ? { contextOnly } : {}),
      ...(arrivalIds !== undefined ? { arrivingActorIds: arrivalIds } : {}),
    };
  });

  // Keep legacy tolerance for an out-of-order JSON array; all boundaries use beat order.
  publicScene.sort((left, right) => left.beat - right.beat);
  const actorById = new Map<string, IsolatedGameActor>();
  for (const actor of actors) {
    const id = actorId(actor.actorId, "actor.actorId");
    if (actorById.has(id)) fail(`duplicate trusted actor ${id}`);
    actorName(actor.name, `actor ${id}.name`);
    if (actor.initiallyPresent !== undefined && typeof actor.initiallyPresent !== "boolean")
      fail(`actor ${id}.initiallyPresent must be a boolean`);
    actorById.set(id, { ...actor, actorId: id, initiallyPresent: actor.initiallyPresent !== false });
  }
  if (actorById.size > MAX_TRUSTED_ACTORS) fail("trusted actor roster is too large");

  const present = new Set(
    [...actorById.values()].filter((actor) => actor.initiallyPresent !== false).map((actor) => actor.actorId),
  );
  const arrivalsByActor = new Map<string, number>();
  for (const beat of publicScene) {
    const arrivals = beat.arrivingActorIds ?? [];
    if (arrivals.length > 0 && beat.contextOnly) fail(`publicScene[${beat.beat}] arrival cannot be context-only`);
    for (const id of arrivals) {
      if (!actorById.has(id)) fail(`publicScene[${beat.beat}] references an unknown arrival actor`);
      if (playerActorId && id === playerActorId) fail("player actor cannot arrive");
      if (present.has(id)) fail(`actor ${id} is already present`);
      present.add(id);
      arrivalsByActor.set(id, beat.beat);
    }
    for (const audience of beat.perceivedBy) {
      if (!actorById.has(audience)) fail(`publicScene[${beat.beat}] references an unknown audience actor`);
      if (!present.has(audience)) fail(`publicScene[${beat.beat}] references a nonpresent audience actor`);
    }
  }

  const actorRequests = raw.actorRequests.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`actorRequests[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    if (!Number.isInteger(row.beat) || !beats.has(Number(row.beat)))
      fail(`actorRequests[${index}] references a missing beat`);
    const id = actorId(row.actorId, `actorRequests[${index}].actorId`);
    if (!actorById.has(id)) fail(`actorRequests[${index}] references an unknown actor`);
    if (playerActorId && id === playerActorId) fail("player actor cannot be requested");
    const arrivalBeat = arrivalsByActor.get(id);
    const actorIsPresent = actorById.get(id)?.initiallyPresent !== false;
    if (!actorIsPresent && (arrivalBeat === undefined || arrivalBeat > Number(row.beat)))
      fail(`actorRequests[${index}] references an actor before arrival`);
    const sceneBeat = publicScene.find((scene) => scene.beat === Number(row.beat))!;
    const rawPerceivedBy = row.perceivedBy === undefined ? sceneBeat.perceivedBy : row.perceivedBy;
    if (!Array.isArray(rawPerceivedBy)) fail(`actorRequests[${index}].perceivedBy must be an array`);
    const perceivedBy = [
      ...new Set(
        rawPerceivedBy.map((audience, audienceIndex) =>
          actorId(audience, `actorRequests[${index}].perceivedBy[${audienceIndex}]`),
        ),
      ),
    ];
    for (const audience of perceivedBy) {
      if (!actorById.has(audience)) fail(`actorRequests[${index}] references an unknown audience actor`);
      const audienceArrivalBeat = arrivalsByActor.get(audience);
      const audiencePresent = actorById.get(audience)?.initiallyPresent !== false;
      if (!audiencePresent && (audienceArrivalBeat === undefined || audienceArrivalBeat > Number(row.beat)))
        fail(`actorRequests[${index}] references a nonpresent audience actor`);
    }
    return { beat: Number(row.beat), actorId: id, perceivedBy };
  });
  actorRequests.sort((left, right) => left.beat - right.beat);
  if (!publicScene.some((beat) => !beat.contextOnly)) fail("plan requires a player-visible scene beat");
  let spatialDirective: IsolatedGamePlan["spatialDirective"];
  if (raw.spatialDirective !== undefined && raw.spatialDirective !== null) {
    if (!raw.spatialDirective || typeof raw.spatialDirective !== "object" || Array.isArray(raw.spatialDirective))
      fail("spatialDirective must be an object");
    const directive = raw.spatialDirective as Record<string, unknown>;
    if (directive.type !== "move") fail("spatialDirective.type must be move");
    const destinationId = spatialDestinationId(directive.destinationId, "spatialDirective.destinationId");
    spatialDirective = { type: "move", destinationId };
  }
  return { publicScene, actorRequests, ...(spatialDirective ? { spatialDirective } : {}) };
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
  // No backslash escaping: the client parser only strips the outer pair of quotes.
  const trimmed = value.trim();
  const inner =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return `"${inner}"`;
}

function composeContent(
  plan: IsolatedGamePlan,
  actors: ReadonlyMap<string, IsolatedGameActor>,
  outputs: readonly (IsolatedGameActorOutput | undefined)[],
  playerActorId?: string,
  playerActorName?: string,
): string {
  const linesByBeat = new Map<number, string[]>();
  for (const [requestIndex, output] of outputs.entries()) {
    if (!output) continue;
    const actor = actors.get(output.actorId);
    if (!actor) continue;
    const request = plan.actorRequests[requestIndex];
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
    if (!beat.contextOnly) result.push(beat.text);
    const actorLines = linesByBeat.get(beat.beat);
    if (actorLines?.length) result.push(actorLines.join("\n"));
  }
  const content = result.join("\n\n").trim();
  return plan.spatialDirective
    ? `${content}${content ? "\n\n" : ""}[spatial_move: destination_id=${plan.spatialDirective.destinationId}]`
    : content;
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
  for (const actor of input.actors) {
    const id = actorId(actor.actorId, "actor.actorId");
    if (actors.has(id)) fail(`duplicate trusted actor ${id}`);
    const name = actorName(actor.name, `actor ${id}.name`);
    actors.set(id, { ...actor, actorId: id, name });
  }
  if (actors.size > MAX_TRUSTED_ACTORS) fail("trusted actor roster is too large");
  const rawPlan = await input.plan(input.gmPrompt, signal);
  signal.throwIfAborted();
  const plan = normalizePlan(rawPlan, [...actors.values()], input.playerActorId);
  const selectedNames = new Set<string>();
  const selectedActorIds = new Set<string>();
  for (const request of plan.actorRequests) {
    if (selectedActorIds.has(request.actorId)) continue;
    selectedActorIds.add(request.actorId);
    const actor = actors.get(request.actorId)!;
    const nameKey = actor.name.normalize("NFKC").trim().toLocaleLowerCase();
    if (selectedNames.has(nameKey)) fail(`duplicate selected actor name ${actor.name}`);
    selectedNames.add(nameKey);
  }
  const diagnostics: IsolatedGameTurnResult["actorDiagnostics"] = [];
  const outputs: Array<IsolatedGameActorOutput | undefined> = Array.from({ length: plan.actorRequests.length });
  const work = plan.actorRequests.map((request, index) => ({ request, index, requestId: randomUUID() }));
  const completionResolvers = work.map(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  });
  const arrivalByActor = new Map<string, number>();
  for (const beat of plan.publicScene) {
    for (const id of beat.arrivingActorIds ?? []) arrivalByActor.set(id, beat.beat);
  }
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
        await Promise.all(
          work
            .slice(0, item.index)
            .filter(
              (prior) => prior.request.actorId === actor.actorId || prior.request.perceivedBy.includes(actor.actorId),
            )
            .map((prior) => completionResolvers[prior.index]!.promise),
        );
        controller.signal.throwIfAborted();
        const context = input.resolveActorContext
          ? await input.resolveActorContext(actor.actorId)
          : { card: actor.card, authorizedMemory: actor.authorizedMemory };
        const ownCard = text(context.card, `actor ${actor.actorId}.card`, 20_000);
        if (context.authorizedMemory !== undefined) {
          if (typeof context.authorizedMemory !== "string")
            fail(`actor ${actor.actorId}.authorizedMemory must be a string`);
          if (context.authorizedMemory.length > 20_000)
            fail(`actor ${actor.actorId}.authorizedMemory exceeds 20000 characters`);
        }
        const authorizedMemory = context.authorizedMemory ?? "";
        const raw = await input.actor(
          {
            expectedActorId: actor.actorId,
            actorName: actor.name,
            ownCard,
            authorizedMemory,
            publicScene: plan.publicScene.filter((beat) => {
              const actorArrival = arrivalByActor.get(actor.actorId);
              return (
                beat.beat <= item.request.beat &&
                beat.perceivedBy.includes(actor.actorId) &&
                (actorArrival === undefined || beat.beat >= actorArrival)
              );
            }),
            priorActorLines: work
              .slice(0, item.index)
              .filter(
                (prior) => prior.request.actorId === actor.actorId || prior.request.perceivedBy.includes(actor.actorId),
              )
              .flatMap((prior) => {
                const output = outputs[prior.index];
                if (!output) return [];
                const ownLines = prior.request.actorId === actor.actorId;
                const lines = output.lines.filter((line) => {
                  const type = line.type ?? "main";
                  if (type === "thought") return ownLines;
                  if (type === "whisper") return ownLines || line.targetActorId === actor.actorId;
                  return type === "main" || type === "side" || type === "action";
                });
                return lines.length === 0
                  ? []
                  : [
                      {
                        beat: prior.request.beat,
                        actorId: prior.request.actorId,
                        actorName: actors.get(prior.request.actorId)!.name,
                        lines,
                      },
                    ];
              }),
          },
          controller.signal,
        );
        // Being eligible for an arrival does not make someone a valid whisper target yet.
        const presentAtRequest = new Map(
          [...actors].filter(
            ([id, candidate]) =>
              candidate.initiallyPresent !== false ||
              plan.publicScene.some((beat) => beat.beat <= item.request.beat && beat.arrivingActorIds?.includes(id)),
          ),
        );
        const output = normalizeActorOutput(raw, actor, presentAtRequest, input.playerActorId);
        outputs[item.index] = output;
        diagnostics[item.index] = { actorId: actor.actorId, status: "accepted", requestId: item.requestId };
      } catch (error) {
        if (signal.aborted) throw error;
        logger.warn(error, "[isolated-game] Actor output rejected for actor %s", actor.actorId);
        diagnostics[item.index] = {
          actorId: actor.actorId,
          status: "omitted",
          reason: error instanceof Error ? error.message : String(error),
          requestId: item.requestId,
        };
      } finally {
        completionResolvers[item.index]!.resolve();
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
  const acceptedDiagnostics = diagnostics.filter(
    (diagnostic): diagnostic is NonNullable<(typeof diagnostics)[number]> => diagnostic !== undefined,
  );
  return {
    content: composeContent(plan, actors, outputs, input.playerActorId, input.playerActorName),
    plan,
    actorDiagnostics: acceptedDiagnostics,
  };
}
