/**
 * Couples in the running world: their shared page, the storylines that start one, and what a
 * Creator knows about their own relationship when they write a post or a message.
 *
 * No model calls. The rules live in `modules/projects/slp-creator-couples.ts`; couples share the
 * ties document (`slurp2.creator-ties`) and its clock with collabs and rivalries.
 */
import type { DB } from "../../../db/connection.js";
import { logger } from "../../../lib/logger.js";
import { newId, now } from "../../../utils/id-generator.js";
import { slpAccounts } from "../../../db/schema/slurp.js";
import { createSlurpStorage } from "../../data/slp-storage.js";
import { mutateSlurpCreatorTies, readSlurpCreatorTiesDocument } from "../../data/projects/slp-creator-ties-storage.js";
import { emptySlpAccountSettings, normalizeHandle } from "../../modules/records/slp-storage-model.js";
import { hash } from "../../modules/projects/slp-project.js";
import {
  slurpCoupleFor,
  slurpCoupleOf,
  slurpCoupleTaken,
  slurpCouplePageOpenable,
  slurpCloseCouplePage,
  slurpOpenCouplePage,
  SLURP_COUPLE_PAGE_SOURCE,
  slurpClosedCouplePageIds,
  type SlurpCouple,
} from "../../modules/projects/slp-creator-couples.js";
import type { SlurpTieCreator } from "../../modules/projects/slp-creator-ties.js";
import { slurpDmViewerPage, type SlurpDmParty } from "../../modules/messages/slp-dm-roles.js";
import { readSlurpRelationshipLine } from "../../data/creators/slp-flavour-source.js";

/** A storyline about two Creators getting together: a live crossover whose words are romance. */
const ROMANCE =
  /\b(romance|romantic|crush\w*|dat(e|es|ing)|falling for|love story|first kiss|in love|flirt\w*|verliebt)\b/iu;

/** Pairs in a live romance storyline, for the couple rules. */
export async function slurpCouplesWorldInput(
  db: DB,
  creators: readonly SlurpTieCreator[],
): Promise<(readonly [string, string])[]> {
  const storage = createSlurpStorage(db);
  const pairs: (readonly [string, string])[] = [];
  for (const creator of creators) {
    const projects = await storage.listActiveProjects(creator.id).catch(() => []);
    for (const project of projects) {
      const ids = project.creatorIds;
      if (ids.length !== 2 || ids[0] !== creator.id) continue;
      if (ROMANCE.test([project.title, project.direction, ...project.chapters].join("\n")))
        pairs.push([ids[0]!, ids[1]!]);
    }
  }
  return pairs;
}

const BIOS = [
  "{a} and {b}, together. Dates, dumb fights, making up.",
  "Two pages, one couch. {a} & {b}.",
  "{a} + {b}. The couple account nobody asked for.",
  "Us, mostly unfiltered. {a} & {b}.",
  "{a} and {b} share a page now. Be nice.",
] as const;

const first = (name: string) => name.trim().split(/\s+/u)[0] ?? name;

/**
 * Open the couple's shared page: their old page again when they had one, else a new Slurp page with
 * no card behind it (nothing posts there on its own; both of them post there from their own turns).
 */
export async function openSlurpCouplePage(db: DB, coupleId: string): Promise<SlurpCouple | "notFound" | "notOpen"> {
  const { couples } = await readSlurpCreatorTiesDocument(db);
  const couple = couples.find((entry) => entry.id === coupleId);
  if (!couple) return "notFound";
  if (!slurpCouplePageOpenable(couple)) return "notOpen";
  const storage = createSlurpStorage(db);
  const [a, b] = await Promise.all([
    storage.getNoodlerAccountById(couple.aId),
    storage.getNoodlerAccountById(couple.bId),
  ]);
  if (!a || !b) return "notFound";
  // Polyamory (0.3.5): a group's page carries every name.
  const more = (await Promise.all((couple.moreIds ?? []).map((id) => storage.getNoodlerAccountById(id)))).filter(
    (account): account is NonNullable<typeof account> => Boolean(account),
  );
  const existing = couple.page ? await storage.getNoodlerAccountById(couple.page.accountId) : null;
  const accountId = existing?.id ?? (await createCouplePage(db, couple, a, b, more));
  const opened = await mutateSlurpCreatorTies(db, (document) => {
    const current = document.couples.find((entry) => entry.id === coupleId);
    if (!current || !slurpCouplePageOpenable(current)) return null;
    const next = slurpOpenCouplePage(current, accountId, new Date());
    return {
      document: { ...document, couples: document.couples.map((entry) => (entry.id === coupleId ? next : entry)) },
      result: next,
    };
  });
  return opened ?? "notOpen";
}

async function createCouplePage(
  db: DB,
  couple: SlurpCouple,
  a: { displayName: string; settings: { profile: { tags?: string[] } } },
  b: { displayName: string; settings: { profile: { tags?: string[] } } },
  more: readonly { displayName: string }[] = [],
): Promise<string> {
  const storage = createSlurpStorage(db);
  const accounts: { handle: string }[] = await storage.listNoodlerAccounts();
  const taken = new Set(accounts.map((account) => account.handle));
  const base = normalizeHandle(`${first(a.displayName)}and${first(b.displayName)}`, "couple");
  let handle = base;
  for (let n = 2; taken.has(handle); n += 1) handle = `${base.slice(0, 32)}_${n}`;
  const names = { a: first(a.displayName), b: first(b.displayName) };
  const bio = BIOS[hash(couple.id) % BIOS.length]!.replace("{a}", names.a).replace("{b}", names.b);
  const settings = emptySlpAccountSettings();
  const id = newId();
  const timestamp = now();
  const source = `${SLURP_COUPLE_PAGE_SOURCE}${couple.id}`;
  await db.insert(slpAccounts).values({
    id,
    kind: "character",
    entityId: source,
    handle,
    displayName: more.length
      ? `${[names.a, ...more.map((member) => first(member.displayName))].join(", ")} & ${names.b}`
      : `${names.a} & ${names.b}`,
    bio,
    avatarUrl: null,
    invited: "false",
    settings: JSON.stringify({
      ...settings,
      profile: {
        ...settings.profile,
        gender: null,
        tags: [...new Set([...(a.settings.profile.tags ?? []), ...(b.settings.profile.tags ?? [])])].slice(0, 8),
      },
      // Never picked for a slot of its own: its posts come from the two of them.
      scheduler: { autoPosting: { enabled: false, imagesEnabled: false } },
      privacy: {
        identityDisclosure: "open",
        stagePersonality: `${a.displayName} and ${b.displayName} share this page as a couple.`,
        access: { hiddenFromAccountIds: [] },
      },
    }),
    platform: "slurp",
    sourceKind: "character",
    sourceEntityId: source,
    slurpSourceAccountId: null,
    visibility: "private",
    publicAccountId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return id;
}

/** Shared pages that closed: they take no new subscribers, tips or unlocks (a reopened page is open again). */
export async function readSlurpClosedCouplePageIds(db: DB): Promise<Set<string>> {
  return slurpClosedCouplePageIds((await readSlurpCreatorTiesDocument(db)).couples);
}

/** Close the couple's shared page now (the player asked): a goodbye post, and no more renewals. */
export async function closeSlurpCouplePage(db: DB, coupleId: string): Promise<SlurpCouple | "notFound" | "notOpen"> {
  const before = (await readSlurpCreatorTiesDocument(db)).couples;
  const closed = await mutateSlurpCreatorTies(db, (document) => {
    const current = document.couples.find((entry) => entry.id === coupleId);
    if (!current?.page || current.page.closedAt) return null;
    const next = slurpCloseCouplePage(current, new Date());
    return {
      document: { ...document, couples: document.couples.map((entry) => (entry.id === coupleId ? next : entry)) },
      result: next,
    };
  });
  if (!closed) return before.some((entry) => entry.id === coupleId) ? "notOpen" : "notFound";
  await closeSlurpCouplePages(db, before, [closed]);
  return closed;
}

/**
 * Pages that closed between two reads of the couples: their subscriptions stop renewing (what was
 * paid runs out as usual). The page and its posts stay, with the goodbye post on top.
 */
export async function closeSlurpCouplePages(
  db: DB,
  before: readonly SlurpCouple[],
  after: readonly SlurpCouple[],
): Promise<void> {
  const storage = createSlurpStorage(db);
  for (const couple of after) {
    const was = before.find((entry) => entry.id === couple.id);
    if (!couple.page?.closedAt || (was?.page?.closedAt && was.page.accountId === couple.page.accountId)) continue;
    try {
      for (const subscription of await storage.listSubscriptionsForCreator(couple.page.accountId))
        await storage.unsubscribe(subscription.viewerAccountId, couple.page.accountId);
    } catch (error) {
      logger.warn(error, "[slurp-couples] Could not stop the renewals of a closed couple page");
    }
  }
}

/**
 * The Creator page writing in a DM, for the role header (`slurpDmViewerPage`), with who they are to
 * the Creator when the two are (or were) a couple: the header then says so in one plain sentence.
 */
export async function slurpCoupleDmPage(
  db: DB,
  page: Parameters<typeof slurpDmViewerPage>[0],
  creatorId: string,
  viewerId: string,
): Promise<SlurpDmParty | null> {
  const party = slurpDmViewerPage(page, creatorId, viewerId);
  if (!party || !page) return party;
  const relationship = await readSlurpRelationshipLine(db, creatorId, { withId: page.id });
  const { couples } = await readSlurpCreatorTiesDocument(db).catch(() => ({ couples: [] as SlurpCouple[] }));
  const couple = slurpCoupleOf(couples, creatorId, page.id);
  return {
    ...party,
    ...(relationship ? { relationship } : {}),
    ...(couple && slurpCoupleTaken(couple) ? { partner: true } : {}),
  };
}

/** The couple partner for a partner scene, or null; `inCouple` says whether they are taken at all. */
export async function readSlurpCouplePartner(
  db: DB,
  creatorId: string,
): Promise<{ inCouple: boolean; partnerId: string | null }> {
  const { couples } = await readSlurpCreatorTiesDocument(db);
  const couple = slurpCoupleFor(couples, creatorId);
  if (!couple || couple.stage === "sparks") return { inCouple: false, partnerId: null };
  return { inCouple: true, partnerId: couple.aId === creatorId ? couple.bId : couple.aId };
}
