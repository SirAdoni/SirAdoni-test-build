// ──────────────────────────────────────────────
// Kaomoji catalog — curated Japanese emoticons for the composer picker.
// Each entry pairs the kaomoji with lowercase search keywords so a fuzzy
// query like "table man angry throw" surfaces the table-flip.
// ──────────────────────────────────────────────

export interface KaomojiEntry {
  value: string;
  keywords: string;
}

export interface KaomojiCategory {
  /** Stable id used for the localization key (`chat.kaomoji.category.<id>`). */
  id: string;
  /** English fallback label. */
  label: string;
  items: KaomojiEntry[];
}

export const KAOMOJI_CATEGORIES: KaomojiCategory[] = [
  {
    id: "happy",
    label: "Happy",
    items: [
      { value: "(◕‿◕)", keywords: "happy smile cute content" },
      { value: "(｡◕‿◕｡)", keywords: "happy smile cute big eyes" },
      { value: "(＾▽＾)", keywords: "happy smile joy grin" },
      { value: "(≧◡≦)", keywords: "happy smile squint joy" },
      { value: "(*^▽^*)", keywords: "happy cheerful smile blush" },
      { value: "ヽ(´▽`)/", keywords: "happy cheer excited yay arms" },
      { value: "(๑˃ᴗ˂)ﻭ", keywords: "happy determined excited fight" },
      { value: "(´｡• ᵕ •｡`)", keywords: "happy soft content sweet" },
      { value: "(☆▽☆)", keywords: "happy excited sparkle star eyes" },
      { value: "( ˶ˆ꒳ˆ˵ )", keywords: "happy smug content pleased" },
      { value: "(•‿•)", keywords: "happy simple smile" },
      { value: "ヽ(・∀・)ﾉ", keywords: "happy cheer excited yay" },
    ],
  },
  {
    id: "love",
    label: "Love",
    items: [
      { value: "(♡°▽°♡)", keywords: "love heart eyes adore" },
      { value: "(*♡∀♡)", keywords: "love heart eyes crush" },
      { value: "(♥ω♥*)", keywords: "love heart blush adore" },
      { value: "(づ｡◕‿‿◕｡)づ", keywords: "love hug hugs cuddle come here" },
      { value: "(っ˘̩╭╮˘̩)っ", keywords: "love hug want hug comfort" },
      { value: "( ˘ ³˘)♥", keywords: "love kiss heart" },
      { value: "(◍•ᴗ•◍)❤", keywords: "love heart cute happy" },
      { value: "(♡´౪`♡)", keywords: "love heart happy playful" },
      { value: "ヽ(♡‿♡)ノ", keywords: "love heart eyes excited" },
      { value: "(´♡‿♡`)", keywords: "love heart soft adore" },
    ],
  },
  {
    id: "sad",
    label: "Sad",
    items: [
      { value: "(╥﹏╥)", keywords: "sad cry crying tears" },
      { value: "(｡•́︿•̀｡)", keywords: "sad upset disappointed frown" },
      { value: "(ಥ﹏ಥ)", keywords: "sad cry sobbing tears" },
      { value: "(っ˘̩╭╮˘̩)っ", keywords: "sad cry comfort hug" },
      { value: "(T_T)", keywords: "sad cry crying tears" },
      { value: "(ᵕ̣̣̣̣̣̣﹏ᵕ̣̣̣̣̣̣)", keywords: "sad cry devastated tears" },
      { value: "( ˃̣̣̥⌓˂̣̣̥ )", keywords: "sad cry sniff upset" },
      { value: "(｡╯︵╰｡)", keywords: "sad cry disappointed" },
      { value: "( ; ω ; )", keywords: "sad cry tears touched" },
      { value: "(◞‸◟)", keywords: "sad gloomy down" },
    ],
  },
  {
    id: "angry",
    label: "Angry",
    items: [
      { value: "(╬ Ò﹏Ó)", keywords: "angry mad furious rage" },
      { value: "(ノಠ益ಠ)ノ", keywords: "angry rage table man throw flip" },
      { value: "(¬､¬)", keywords: "angry annoyed side eye suspicious" },
      { value: "(≖､≖)", keywords: "angry annoyed unamused stare" },
      { value: "ヽ(`Д´)ﾉ", keywords: "angry mad shout yell" },
      { value: "(눈_눈)", keywords: "angry unamused done tired" },
      { value: "(ｏﾟΔﾟ)ｏ", keywords: "angry frustrated shout" },
      { value: "(＃`Д´)", keywords: "angry mad furious" },
      { value: "ヽ(ｏ`皿′ｏ)ﾉ", keywords: "angry rage furious shout" },
      { value: "(◣_◢)", keywords: "angry serious menacing" },
    ],
  },
  {
    id: "surprised",
    label: "Surprised",
    items: [
      { value: "(⊙_⊙)", keywords: "surprised shocked wide eyes" },
      { value: "(°o°)", keywords: "surprised shocked gasp" },
      { value: "Σ(°ロ°)", keywords: "surprised shocked startled" },
      { value: "(ﾟﾛﾟ)", keywords: "surprised shocked stunned" },
      { value: "(⊙o⊙)", keywords: "surprised shocked amazed" },
      { value: "(ʘ‿ʘ)", keywords: "surprised staring wide creepy" },
      { value: "(ﾟﾟ)", keywords: "surprised blank staring" },
      { value: "Σ(っ °Д °;)っ", keywords: "surprised shocked panic startled" },
    ],
  },
  {
    id: "shrug",
    label: "Shrug & Flip",
    items: [
      { value: "¯\\_(ツ)_/¯", keywords: "shrug whatever dunno idk meh" },
      { value: "¯\\_(⊙_ʖ⊙)_/¯", keywords: "shrug confused whatever idk" },
      { value: "┐(´～`)┌", keywords: "shrug whatever meh dunno" },
      { value: "╮(╯▽╰)╭", keywords: "shrug whatever helpless" },
      { value: "(╯°□°）╯︵ ┻━┻", keywords: "table flip angry rage throw man" },
      { value: "(ノಠ益ಠ)ノ彡┻━┻", keywords: "table flip angry rage throw man furious" },
      { value: "┬─┬ ノ( ゜-゜ノ)", keywords: "table put back calm restore fix" },
      { value: "(ﾉ≧∇≦)ﾉ ﾐ ┻━┻", keywords: "table flip excited throw" },
      { value: "┻━┻ ︵ヽ(`Д´)ﾉ︵ ┻━┻", keywords: "table flip double rage furious" },
    ],
  },
  {
    id: "cute",
    label: "Cute & Misc",
    items: [
      { value: "(=^･ω･^=)", keywords: "cat kitty cute animal meow" },
      { value: "(=^‥^=)", keywords: "cat kitty cute animal" },
      { value: "ʕ•ᴥ•ʔ", keywords: "bear cute animal" },
      { value: "(・(ェ)・)", keywords: "bear animal cute" },
      { value: "(´･ω･`)", keywords: "cute meek shy uncertain" },
      { value: "(ᵔᴥᵔ)", keywords: "dog puppy happy cute animal" },
      { value: "(＾• ω •＾)", keywords: "cat cute happy animal" },
      { value: "(ᗒᗨᗕ)", keywords: "excited laughing cute" },
      { value: "(ง •̀_•́)ง", keywords: "fight determined ready lets go" },
      { value: "( •_•)>⌐■-■", keywords: "sunglasses deal with it cool" },
      { value: "(⌐■_■)", keywords: "sunglasses cool deal with it" },
      { value: "(￢‿￢)", keywords: "smug sly plotting mischief" },
      { value: "(¬‿¬)", keywords: "smug sly playful mischief" },
      { value: "(￣ε￣＠)", keywords: "kiss pucker" },
      { value: "(ᴗ_ᴗ)", keywords: "bow sorry please thanks" },
      { value: "m(_ _)m", keywords: "bow sorry apologize please thanks" },
      { value: "(-_-)zzz", keywords: "sleep tired sleepy zzz" },
      { value: "(＠_＠)", keywords: "dizzy confused dazed" },
      { value: "(¬_¬)", keywords: "unamused annoyed side eye" },
      { value: "(•_•)", keywords: "blank stare neutral" },
    ],
  },
];

/**
 * Flat list of every kaomoji for global search, deduplicated by value. A
 * kaomoji that fits more than one category (e.g. a hug in Love and Sad) appears
 * once with its keywords merged, so search never returns duplicate entries.
 */
export const KAOMOJI_ALL: KaomojiEntry[] = (() => {
  const byValue = new Map<string, KaomojiEntry>();
  for (const category of KAOMOJI_CATEGORIES) {
    for (const item of category.items) {
      const existing = byValue.get(item.value);
      if (existing) {
        const merged = new Set([...existing.keywords.split(/\s+/u), ...item.keywords.split(/\s+/u)].filter(Boolean));
        existing.keywords = [...merged].join(" ");
      } else {
        byValue.set(item.value, { value: item.value, keywords: item.keywords });
      }
    }
  }
  return [...byValue.values()];
})();

/**
 * Rank kaomoji against a query. Space-separated tokens must all match somewhere
 * in the entry's keywords (or the kaomoji itself), so "table man angry throw"
 * surfaces the flip. Results are ordered by how many tokens hit as a whole word.
 */
export function searchKaomoji(query: string): KaomojiEntry[] {
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return KAOMOJI_ALL;
  const scored: Array<{ entry: KaomojiEntry; score: number }> = [];
  for (const entry of KAOMOJI_ALL) {
    const haystack = `${entry.keywords} ${entry.value}`.toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      if (!haystack.includes(token)) {
        matchedAll = false;
        break;
      }
      score += new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(haystack) ? 2 : 1;
    }
    if (matchedAll) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((item) => item.entry);
}
