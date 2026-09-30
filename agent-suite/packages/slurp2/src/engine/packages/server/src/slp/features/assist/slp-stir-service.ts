/**
 * Stir (W): plans, plays and the Stir tab, over the one action layer.
 *
 * - `planSlpStir`: plain words → one model call (the AI budget's "Plans" row) → steps, each checked
 *   against the action schemas and previewed. Nothing runs.
 * - `playSlpStir`: runs exactly the steps the player saw, in order, and keeps them in the plays ledger
 *   with what one Undo needs. Plays are free (a sandbox); only an action that calls the AI costs a call.
 * - `undoSlpStirPlay`, `readSlpStirView`.
 */
import type { DB } from "../../../db/connection.js";
import { logger } from "../../../lib/logger.js";
import { resolveBaseUrl } from "../../../services/generation/connection-base-url.js";
import { createLLMProvider } from "../../../services/llm/provider-registry.js";
import { createConnectionsStorage } from "../../../services/storage/connections.storage.js";
import { newId } from "../../../utils/id-generator.js";
import { resolveSlurpTextConnection } from "../../base/identity/slp-connection.js";
import { claimSlurpModelBudget, slurpModelWorkerAllows } from "../../base/model/slp-model-worker.js";
import { slpWithProviderRetry } from "../../base/model/slp-provider-retry.js";
import { createSlurpStorage } from "../../data/slp-storage.js";
import { readSlurpCreatorSteering } from "../../data/creators/slp-steering-storage.js";
import {
  mutateSlurpStirPlays,
  readSlurpStirDismissed,
  readSlurpStirPlays,
  type SlurpStoredStirPlay,
} from "../../data/assist/slp-stir-plays-storage.js";
import { slurpCoupleActive, slurpCoupleMatches } from "../../modules/projects/slp-creator-couples.js";
import { slurpPairKey } from "../../modules/projects/slp-creator-ties.js";
import { readSlurpCreatorTiesDocument } from "../../data/projects/slp-creator-ties-storage.js";
import { slurpDealOwesPost } from "../../modules/economy/slp-brand-deals.js";
import { buildSlpStirPlanMessages, readSlpStirPlanAnswer } from "../../modules/assist/slp-stir-plan.js";
import { slpStirLive, slpStirSuggestions } from "../../modules/assist/slp-stir-live.js";
import { SLP_STIR_CANT_INVALID, slpRunStirSteps, slpSortStirSteps } from "../../modules/assist/slp-stir-play.js";
import {
  listSlurpBrandCatalog,
  loadSlurpTieCreators,
  slurpIsCouplePage,
  slurpRunsItself,
} from "../projects/slp-projects-contract.js";
import { previewSlpAction } from "./slp-action-preview.js";
import { runSlpActionWithUndo } from "./slp-action-runner.js";
import { readSlpStirWorld, undoSlpAction, type SlpActionUndo } from "./slp-stir-levers.js";
import type { SlpAssistOutcome } from "./slp-assist-service.js";
import type {
  SlpActionPreview,
  SlpStirOrigin,
  SlpStirPlan,
  SlpStirPlanRequest,
  SlpStirPlay,
  SlpStirStep,
  SlpStirView,
} from "../../../../../shared/src/slp/slp-stir.js";

type Account = {
  id: string;
  displayName: string;
  handle: string;
  avatarUrl?: string | null;
  kind: string;
  sourceKind?: string | null;
  sourceEntityId?: string | null;
  settings?: { profile?: { stagePersonality?: string; bio?: string; tags?: string[] } };
};

/** One public line per Creator for the planner, so "someone who would hate him" can be picked. */
const slpStirCardLine = (account: Account) => {
  const profile = account.settings?.profile;
  const about = (profile?.stagePersonality || profile?.bio || "").trim();
  const tags = (profile?.tags ?? []).slice(0, 4).join(", ");
  return [about, tags && `tags: ${tags}`].filter(Boolean).join("; ") || undefined;
};

/** The Creator ids a step names, whatever the action calls them. */
const slpStirStepPeople = (input: Record<string, unknown>) =>
  ["accountId", "aId", "bId", "fromId", "toId"].flatMap((key) =>
    typeof input[key] === "string" ? [input[key] as string] : [],
  );

/** What a step made or touched, from its result: the ids a ledger row can link to. */
const slpStirStepRef = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const post = record.post as { id?: unknown } | undefined;
  const ref = Object.fromEntries(
    [
      ...["collabId", "rivalryId", "coupleId", "occurrenceId", "projectId", "dealId"].map(
        (key) => [key, record[key]] as const,
      ),
      ["postId", post?.id] as const,
    ].filter((entry): entry is readonly [string, string] => typeof entry[1] === "string"),
  );
  return Object.keys(ref).length ? ref : undefined;
};

/**
 * Preview a list of steps (a plan, a card, a Support proposal). A step the layer does not know, or
 * with input its schema refuses, comes back in `cant` in plain words, never as a silent drop.
 */
export async function previewSlpStirSteps(
  db: DB,
  steps: readonly SlpStirStep[],
): Promise<{ cards: SlpActionPreview[]; cant: string[] }> {
  const { plays, cant } = slpSortStirSteps(steps);
  const cards: SlpActionPreview[] = [];
  for (const play of plays) {
    const preview = await previewSlpAction(db, play.action, play.input);
    if (preview.ok) cards.push(preview.value);
    else cant.push(SLP_STIR_CANT_INVALID);
  }
  return { cards, cant };
}

/**
 * Plain words → a previewed plan. One model call; nothing in the world changes. The player's own
 * request never spends the AI budget (0.3.6); a Creator's DM proposal (`world`) is on the "Plans" row.
 */
export async function planSlpStir(
  db: DB,
  request: Omit<SlpStirPlanRequest, "personaId">,
  /** The pages the playing persona runs; without one, every page the player runs is theirs. */
  own?: (account: Account) => boolean,
  origin: "player" | "world" = "world",
): Promise<SlpAssistOutcome<SlpStirPlan>> {
  const storage = createSlurpStorage(db);
  const settings = await storage.getSettings();
  if (origin === "world" && !slurpModelWorkerAllows(settings.modelBudget, "present"))
    return { ok: false, status: 409, error: "Plans need your AI connection. The cards still work." };
  const connection = await resolveSlurpTextConnection(
    createConnectionsStorage(db),
    settings.modelBudget.connectionId ?? settings.generationConnectionId,
  );
  if (!connection) return { ok: false, status: 409, error: "Select a text generation connection first." };
  const accounts = (await storage.listNoodlerAccounts()) as Account[];
  const about = request.creatorId ? accounts.find((account) => account.id === request.creatorId) : null;
  const post = request.postId ? await storage.getPostById(request.postId) : null;
  const [world, catalog, plays] = await Promise.all([
    readSlpStirWorld(db),
    listSlurpBrandCatalog(db),
    readSlurpStirPlays(db),
  ]);
  if (origin === "world" && !(await claimSlurpModelBudget(db, settings.modelBudget, "plan")))
    return { ok: false, status: 429, error: "Today's AI budget for plans is used up. The cards still work." };
  const provider = slpWithProviderRetry(
    createLLMProvider(
      connection.provider,
      resolveBaseUrl(connection),
      connection.apiKey,
      connection.maxContext,
      connection.openrouterProvider,
      connection.maxTokensOverride,
      connection.claudeFastMode === "true",
      connection.treatAsLocalEndpoint === "true",
      connection.defaultParameters,
    ),
  );
  const result = await provider.chatComplete(
    buildSlpStirPlanMessages({
      text: request.text,
      creators: accounts
        .filter((account) => !slurpIsCouplePage(account))
        .map((account) => ({
          id: account.id,
          name: account.displayName,
          handle: account.handle,
          automatic: slurpRunsItself(account),
          own: own ? own(account) : undefined,
          card: slpStirCardLine(account),
        })),
      world,
      brands: catalog.brands,
      about: about ? { id: about.id, name: about.displayName } : null,
      post: post ? { id: post.id, caption: String((post as { content?: unknown }).content ?? "") } : null,
      recent: plays.slice(0, 5).map((play) => ({
        action: play.steps.map((step) => step.action).join(" + "),
        who: [...new Set(play.steps.flatMap((step) => slpStirStepPeople(step.input)))],
        undone: play.undone,
      })),
      followUp: request.followUp ?? null,
    }),
    // Reasoning headroom, like the writing help: a plan is short, the thinking may not be.
    { model: connection.model, temperature: 0.3, maxTokens: 3072 },
  );
  const answer = readSlpStirPlanAnswer(result.content);
  if (!answer) return { ok: false, status: 502, error: "That plan came back garbled. Try again, or play a card." };
  const { cards, cant } = await previewSlpStirSteps(db, answer.steps);
  return { ok: true, value: { cards, question: answer.question, cant: [...answer.cant, ...cant] } };
}

/**
 * Do it: run exactly these steps, in order, and keep the play. A step that fails does not stop the
 * others (each is its own beat); the answer says which ran. Undo is offered when anything that ran
 * can be taken back.
 */
export async function playSlpStir(
  db: DB,
  input: { steps: readonly SlpStirStep[]; origin: SlpStirOrigin },
  at = new Date(),
): Promise<{ play: SlpStirPlay; results: { ok: boolean; value: unknown; error: string | null }[] }> {
  const { steps, results, undo } = await slpRunStirSteps<SlpActionUndo>(input.steps, (action, stepInput) =>
    runSlpActionWithUndo(db, action, stepInput),
  );
  const play = {
    id: newId(),
    at: at.toISOString(),
    origin: input.origin,
    steps: steps.map((step, index) => {
      const ref = results[index]?.ok ? slpStirStepRef(results[index]!.value) : undefined;
      return ref ? { ...step, ref } : step;
    }),
    undoable: undo.length > 0,
    undone: false,
    undo,
  };
  await mutateSlurpStirPlays(db, (plays) => ({ plays: [play, ...plays], result: null }));
  const { undo: _undo, ...visible } = play;
  return { play: visible, results };
}

/**
 * One Undo for everything reversible in that play, newest step first. The play is marked taken back
 * before anything runs, so a second tap cannot run it twice. `kept` counts the steps the world has
 * moved past (a partner with someone new, an idea already posted): those stay as they are.
 */
export async function undoSlpStirPlay(
  db: DB,
  id: string,
): Promise<SlpAssistOutcome<{ play: SlpStirPlay; kept: number }>> {
  const claimed = await mutateSlurpStirPlays<SlurpStoredStirPlay | "gone" | "cant">(db, (plays) => {
    const play = plays.find((entry) => entry.id === id);
    if (!play) return { plays, result: "gone" as const };
    if (play.undone || !play.undoable) return { plays, result: "cant" as const };
    return {
      plays: plays.map((entry) => (entry.id === id ? { ...entry, undone: true, undo: [] } : entry)),
      result: play,
    };
  });
  if (claimed === "gone") return { ok: false, status: 404, error: "That play is gone." };
  if (claimed === "cant") return { ok: false, status: 409, error: "That one cannot be taken back." };
  let kept = 0;
  for (const entry of [...claimed.undo].reverse()) {
    const done = await undoSlpAction(db, entry as SlpActionUndo).catch((error: unknown) => {
      logger.warn(error, "[slurp] A Stir undo step failed");
      return false;
    });
    if (!done) kept += 1;
  }
  const { undo: _undo, ...visible } = claimed;
  if (kept && kept === claimed.undo.length) {
    // Nothing could go back: the play is not "taken back" in the ledger or to the planner.
    await mutateSlurpStirPlays(db, (plays) => ({
      plays: plays.map((entry) => (entry.id === id ? { ...entry, undone: false, undoable: false } : entry)),
      result: null,
    }));
    return { ok: false, status: 409, error: "Too much has happened since to take that back." };
  }
  return { ok: true, value: { play: { ...visible, undone: true }, kept } };
}

/** Everything the Stir tab shows, in one read. `own` marks the pages this persona runs. */
export async function readSlpStirView(
  db: DB,
  own: (account: Account) => boolean,
  at = new Date(),
): Promise<SlpStirView> {
  const storage = createSlurpStorage(db);
  const [accounts, world, document, plays, occurrences, dismissed, tieCreators] = await Promise.all([
    storage.listNoodlerAccounts() as Promise<Account[]>,
    readSlpStirWorld(db, at),
    readSlurpCreatorTiesDocument(db),
    readSlurpStirPlays(db),
    storage.listStoryOccurrences(),
    readSlurpStirDismissed(db, at),
    // ponytail: every Creator's fit text on each Stir visit, for "they would click"; cache it if a big cast feels slow.
    loadSlurpTieCreators(db, at),
  ]);
  const rivals = new Set(world.rivalries.map((rivalry) => slurpPairKey(rivalry.fromId, rivalry.toId)));
  const matches = slurpCoupleMatches(
    tieCreators,
    new Set(
      document.couples
        .filter(slurpCoupleActive)
        .flatMap((couple) => [couple.aId, couple.bId, ...(couple.moreIds ?? [])]),
    ),
    (a, b) => rivals.has(slurpPairKey(a, b)),
  )
    .sort((left, right) => right.fit.chemistry - left.fit.chemistry)
    .map(({ a, b }) => ({ aId: a.id, bId: b.id }));
  const creators = await Promise.all(
    accounts.map(async (account) => {
      const automatic = slurpRunsItself(account);
      const [steering, latest] = await Promise.all([
        readSlurpCreatorSteering(db, account.id),
        automatic ? storage.getNoodlerLatestPublishedPost(account.id) : Promise.resolve(null),
      ]);
      return {
        id: account.id,
        name: account.displayName,
        handle: account.handle,
        avatarUrl: account.avatarUrl ?? null,
        automatic,
        own: own(account),
        couplePage: slurpIsCouplePage(account),
        lastPostAt: (latest as { createdAt?: string } | null)?.createdAt ?? null,
        pace: steering.pace,
        ideas: steering.nudges.length,
      };
    }),
  );
  const endsAt = new Map<string, string>(
    occurrences
      .filter(
        (occurrence: { status: string; endsAt: string }) =>
          occurrence.status === "active" && occurrence.endsAt > at.toISOString(),
      )
      .map((occurrence: { blueprintId: string; endsAt: string }) => [occurrence.blueprintId, occurrence.endsAt]),
  );
  const ownIds = new Set(creators.filter((creator) => creator.own).map((creator) => creator.id));
  const liveInput = {
    at,
    creators,
    couples: document.couples,
    collabs: document.ties.collabs.filter((collab) => world.collabs.some((open) => open.id === collab.id)),
    rivalries: world.rivalries,
    events: world.events.map((event) => ({ ...event, endsAt: endsAt.get(event.id) ?? null })),
    owed: document.deals
      .filter((deal) => ownIds.has(deal.creatorId) && slurpDealOwesPost(deal, at))
      .map((deal) => ({ id: deal.id, creatorId: deal.creatorId, brand: deal.brand })),
    firstVisit: plays.length === 0,
    matches,
    dismissed,
  };
  return {
    live: slpStirLive(liveInput),
    suggestions: slpStirSuggestions(liveInput),
    plays: plays.slice(0, 12).map(({ undo: _undo, ...play }) => play),
    creators: creators.map(({ lastPostAt: _last, pace: _pace, ideas: _ideas, ...creator }) => creator),
    events: world.events,
    couples: world.couples,
    collabs: world.collabs,
    rivalries: world.rivalries,
    storylines: world.storylines,
  };
}
