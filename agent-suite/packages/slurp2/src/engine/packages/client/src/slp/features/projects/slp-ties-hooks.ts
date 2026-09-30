import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../lib/api-client";
import { slpKeys } from "../../base/state/slp-query-keys";

/** Collabs, rivalries, brand deals and couples, as Studio shows them. Mirrors the server's `/slurp/ties`. */
export type SlurpTiesCreator = {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  /** A page this persona runs. */
  own: boolean;
  /** Slurp writes this Creator's posts. */
  automatic: boolean;
  /** A couple's shared page, not a Creator of its own. */
  couplePage?: boolean;
};
export type SlurpTiesCollab = {
  id: string;
  hostId: string;
  partnerId: string;
  idea: string;
  hostShare: number;
  status: "asked" | "agreed" | "planned" | "posted" | "declined" | "blocked";
  origin: "world" | "player" | "rivalry" | "dm";
  askedAt: string;
  answeredAt: string | null;
  postId: string | null;
  decline: "busy" | "offBrand" | "noCollabs" | "noAnswer" | "player" | null;
  /** Announced (U): the joint post drops at `dropAt`. */
  announcedAt?: string | null;
  dropAt?: string | null;
  /** Planned in their DMs as a spicy shoot together. */
  shoot?: boolean;
  /** Fans who came across once it was up. */
  crossover?: { host: number; partner: number };
};
export type SlurpTiesRivalry = {
  id: string;
  fromId: string;
  toId: string;
  cause: string;
  stage: "shade" | "feud" | "cooling" | "over";
  stageAt: string;
  ending: "made_up" | "fizzled" | "calmed" | null;
};
export type SlurpTiesDeal = {
  id: string;
  brand: string;
  product: string;
  copy: string;
  creatorId: string;
  fee: number;
  status: "offered" | "accepted" | "planned" | "done" | "declined";
  decline: "offBrand" | "noAds" | "notNow" | "noAnswer" | "player" | null;
  offeredAt: string;
  answeredAt: string | null;
  /** The sponsored post; none when the player took the deal for their own page. */
  postId: string | null;
  /** The player's own page took it and has not posted it yet (Studio reminds them). */
  owesPost?: boolean;
  /** The player marked the owed post as posted. */
  markedAt?: string | null;
  /** An open offer: the brand's ad banner (Q), or its feed picture for an older ad. */
  bannerUrl?: string | null;
  /** The brand's logo (R). */
  logoUrl?: string | null;
};
export type SlurpTiesCoupleStage = "sparks" | "dating" | "together" | "rocky" | "split";
export type SlurpTiesCouple = {
  id: string;
  aId: string;
  bId: string;
  /** Polyamory (0.3.5): more partners. */
  moreIds?: string[];
  origin: "card" | "world" | "player" | "storyline";
  stage: SlurpTiesCoupleStage;
  ending: "breakup" | "fizzled" | null;
  startedAt: string;
  stageAt: string;
  togetherAt: string | null;
  reunions: number;
  moments: { id: string; kind: string; at: string; detail: string; withId?: string; fromId?: string }[];
  page: { accountId: string; openedAt: string; closedAt: string | null } | null;
  /** Set up by the player against a card: whose card, and what it says. */
  forced?: { misfit: "taken" | "notInto" | "noDating" | "orientation"; byId: string };
};
export type SlurpCoupleSteer = "date" | "drama" | "patchUp" | "breakUp" | "reunite";

export type SlurpTiesView = {
  creators: SlurpTiesCreator[];
  collabs: SlurpTiesCollab[];
  rivalries: SlurpTiesRivalry[];
  deals: SlurpTiesDeal[];
  blocked: string[];
  couples: SlurpTiesCouple[];
};

const key = (personaId: string) => [...slpKeys.noodlerRoot(), "ties", personaId] as const;
const base = "/slurp2/slurp/ties";

export function useSlurpTies(personaId: string | null) {
  return useQuery({
    queryKey: key(personaId ?? "none"),
    enabled: Boolean(personaId),
    queryFn: () => api.get<SlurpTiesView>(`${base}?personaId=${encodeURIComponent(personaId!)}`),
  });
}

/** Every change answers with the whole view, which replaces the cached copy. */
export function useSlurpTiesMutations(personaId: string) {
  const qc = useQueryClient();
  const store = (view: SlurpTiesView) => qc.setQueryData(key(personaId), view);
  const post = (path: string, body: Record<string, unknown> = {}) =>
    api.post<SlurpTiesView>(`${base}${path}`, { personaId, ...body });
  return {
    push: useMutation({
      mutationFn: (id: string) => post(`/collabs/${encodeURIComponent(id)}/push`),
      onSuccess: store,
    }),
    decline: useMutation({
      mutationFn: (id: string) => post(`/collabs/${encodeURIComponent(id)}/decline`),
      onSuccess: store,
    }),
    block: useMutation({
      mutationFn: (id: string) => post(`/collabs/${encodeURIComponent(id)}/block`),
      onSuccess: store,
    }),
    unblock: useMutation({ mutationFn: (pair: string) => post("/unblock", { key: pair }), onSuccess: store }),
    suggest: useMutation({
      mutationFn: (pair: { aId: string; bId: string }) => post("/collabs", pair),
      onSuccess: store,
    }),
    cool: useMutation({
      mutationFn: (id: string) => post(`/rivalries/${encodeURIComponent(id)}/cool`),
      onSuccess: store,
    }),
    setUp: useMutation({
      mutationFn: (pair: { aId: string; bId: string }) => post("/couples", pair),
      onSuccess: store,
    }),
    steerCouple: useMutation({
      mutationFn: (input: { id: string; steer: SlurpCoupleSteer }) =>
        post(`/couples/${encodeURIComponent(input.id)}/steer`, { steer: input.steer }),
      onSuccess: store,
    }),
    couplePage: useMutation({
      mutationFn: (input: { id: string; open: boolean }) =>
        post(`/couples/${encodeURIComponent(input.id)}/page`, { open: input.open }),
      onSuccess: (view) => {
        store(view);
        // A new page is a new Creator everywhere: Discover, the feed, profiles.
        void qc.invalidateQueries({ queryKey: slpKeys.noodlerRoot() });
      },
    }),
    markPosted: useMutation({
      mutationFn: (id: string) => post(`/deals/${encodeURIComponent(id)}/posted`),
      onSuccess: store,
    }),
    answerDeal: useMutation({
      mutationFn: (answer: { id: string; accept: boolean }) =>
        post(`/deals/${encodeURIComponent(answer.id)}/answer`, { accept: answer.accept }),
      onSuccess: (view) => {
        store(view);
        // A yes pays into the Creator's earnings: the Studio and Wallet cards read them.
        void qc.invalidateQueries({ queryKey: [...slpKeys.noodlerRoot(), "studio"] });
      },
    }),
  };
}

/** A couple's shared page that closed: nothing new goes up there, so there is nothing to join. */
export function useSlurpCouplePageClosed(personaId: string | null, accountId: string): boolean {
  const { data } = useSlurpTies(personaId);
  return Boolean(slurpCoupleForAccount(data, accountId)?.page?.page?.closedAt);
}

/** The couple this account is in (or the shared page it is), for the profile's couple line. */
export function slurpCoupleForAccount(view: SlurpTiesView | undefined, accountId: string) {
  if (!view) return null;
  const couple =
    view.couples.find(
      (entry) =>
        entry.stage !== "split" &&
        (entry.aId === accountId || entry.bId === accountId || Boolean(entry.moreIds?.includes(accountId))),
    ) ?? null;
  const page = view.couples.find((entry) => entry.page?.accountId === accountId) ?? null;
  return couple || page ? { couple, page } : null;
}
