/**
 * What a Creator knows about their own love life, as plain sentences for the briefs and the DMs:
 * a crush before dating, the partner while together, an ex after a breakup (U).
 */
import { slurpCoupleActive, slurpCoupleFor, slurpCoupleOf, type SlurpCouple } from "./slp-creator-couples.js";
import { slurpForcedCoupleLine } from "./slp-couple-words.js";
import { slurpCouplePartners, slurpNameList } from "./slp-couple-group.js";

/** An ex stays on a Creator's mind (and in their posts and chats) this long after the breakup. */
export const SLURP_EX_DAYS = 30;

/**
 * What a Creator knows about their own love life, in one plain sentence, or "". In a chat with the
 * partner (or the ex) it says who they are to each other; anywhere else it is part of their life,
 * and for a while after a breakup the ex is too (U: exes show up in posts and DMs).
 */
export function slurpRelationshipLine(
  couples: readonly SlurpCouple[],
  creatorId: string,
  names: ReadonlyMap<string, string>,
  options: { withId?: string | null; at?: Date } = {},
): string {
  const line = oneRelationshipLine(couples, creatorId, names, options);
  // Polyamory (0.3.5): one person in several couples hears about all of them.
  const main = options.withId ? slurpCoupleOf(couples, creatorId, options.withId) : slurpCoupleFor(couples, creatorId);
  const more = couples
    .filter((couple) => couple !== main && slurpCoupleActive(couple))
    .flatMap((couple) => {
      const who = slurpNameList(
        slurpCouplePartners(couple, creatorId).flatMap((id) => (names.has(id) ? [names.get(id)!] : [])),
      );
      if (!who) return [];
      return [
        couple.stage === "sparks"
          ? `flirting with ${who}`
          : couple.stage === "dating"
            ? `dating ${who}`
            : `with ${who}`,
      ];
    });
  return more.length ? `${line} You are polyamorous, and you are also ${more.join(", and ")}.`.trim() : line;
}

function oneRelationshipLine(
  couples: readonly SlurpCouple[],
  creatorId: string,
  names: ReadonlyMap<string, string>,
  options: { withId?: string | null; at?: Date },
): string {
  const at = options.at ?? new Date();
  const withThem = options.withId ? slurpCoupleOf(couples, creatorId, options.withId) : null;
  const couple = withThem ?? slurpCoupleFor(couples, creatorId) ?? slurpRecentEx(couples, creatorId, at);
  if (!couple) return "";
  // Polyamory (0.3.5): a couple of three or four names every partner; "they" for more than one.
  const partnerIds = slurpCouplePartners(couple, creatorId);
  const partner = slurpNameList(partnerIds.flatMap((id) => (names.has(id) ? [names.get(id)!] : [])));
  if (!partner) return "";
  if (partnerIds.length > 1) return slurpGroupLine(couple, partner, Boolean(withThem));
  const days = Math.max(0, Math.round((at.getTime() - Date.parse(couple.stageAt)) / 86_400_000));
  const trouble = [...couple.moments].reverse().find((moment) => moment.kind === "fight" || moment.kind === "jealous");
  // A couple the player forced against a card: the card colors how it feels (slice I).
  const tone = slurpCoupleActive(couple) ? slurpForcedCoupleLine(couple, creatorId, partner) : "";
  const colored = (line: string) => (tone ? `${line} ${tone}` : line);
  if (withThem) {
    if (couple.stage === "sparks")
      return colored(`You and ${partner} have been flirting on Slurp lately. Nothing is official.`);
    if (couple.stage === "dating")
      return colored(`You and ${partner} are dating. It is new, and not official in public yet.`);
    if (couple.stage === "together")
      return colored(`${partner} is your partner: you two are together, and your fans know.`);
    if (couple.stage === "rocky")
      return colored(
        `${partner} is your partner, but things are rocky between you right now${trouble?.detail ? ` (${trouble.detail})` : ""}.`,
      );
    return couple.ending === "fizzled"
      ? `You and ${partner} flirted for a while, and it went nowhere.`
      : `${partner} is your ex. You broke up ${days <= 1 ? "just now" : `${days} days ago`}.`;
  }
  if (couple.stage === "sparks")
    return colored(`You have a crush on ${partner}, another Creator on Slurp. Nothing is official.`);
  if (couple.stage === "split")
    return `${partner} is your ex: you broke up ${days <= 1 ? "just now" : `${days} days ago`}. It still comes up now and then, and fans may ask. Say as much or as little as you would.`;
  const what =
    couple.stage === "dating"
      ? `You are dating ${partner}, another Creator on Slurp; it is still new.`
      : `You are with ${partner}, another Creator on Slurp.`;
  const rocky = couple.stage === "rocky" ? " Things are rocky between you two right now." : "";
  return colored(`${what}${rocky}`) + " They are part of your life, not the topic of everything you write.";
}

/** The newest breakup of this Creator in the last `SLURP_EX_DAYS` days, or null. */
function slurpRecentEx(couples: readonly SlurpCouple[], creatorId: string, at: Date): SlurpCouple | null {
  return (
    [...couples]
      .reverse()
      .find(
        (couple) =>
          couple.ending === "breakup" &&
          !slurpCoupleActive(couple) &&
          slurpCouplePartners(couple, creatorId).length > 0 &&
          at.getTime() - Date.parse(couple.stageAt) >= 0 &&
          at.getTime() - Date.parse(couple.stageAt) < SLURP_EX_DAYS * 86_400_000,
      ) ?? null
  );
}

/** A couple of three or four, from one member's side. */
function slurpGroupLine(couple: SlurpCouple, partners: string, inChat: boolean): string {
  if (couple.stage === "split")
    return `${partners} are your exes: the relationship you had together is over. It still comes up now and then.`;
  const rocky = couple.stage === "rocky" ? " Things are rocky between you right now." : "";
  const what =
    couple.stage === "together"
      ? `You are in a polyamorous relationship with ${partners}, and your fans know.`
      : `You are dating ${partners} together, a polyamorous relationship that is still new.`;
  return inChat
    ? `${what}${rocky}`
    : `${what}${rocky} They are part of your life, not the topic of everything you write.`;
}
