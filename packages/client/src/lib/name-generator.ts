// ──────────────────────────────────────────────
// Offline fantasy name generator
//
// Pure and seeded: the same seed, style and options always give the same names,
// so a list can be shared, locked slot by slot and regenerated without a server.
// Four hand-tuned syllable styles, plus a small character Markov model that can
// be trained on any list of names (a lorebook's entries, the character library).
// ──────────────────────────────────────────────

export type NameStyleId = "northern" | "elvish" | "desert" | "imperial" | "learned";
export type NameGender = "neutral" | "feminine" | "masculine";

export const NAME_STYLE_IDS: readonly NameStyleId[] = ["northern", "elvish", "desert", "imperial", "learned"];
export const NAME_GENDERS: readonly NameGender[] = ["neutral", "feminine", "masculine"];

export interface GeneratedName {
  given: string;
  surname: string | null;
  full: string;
}

export interface MarkovNameModel {
  order: number;
  /** context -> next character -> weight. "^" pads the start, "$" ends a name. */
  transitions: Record<string, Record<string, number>>;
  /** Lowercased training names, so generated output can avoid copying one verbatim. */
  known: string[];
  /** Length range seen in training, used to keep output plausible. */
  minLength: number;
  maxLength: number;
}

export interface NameGeneratorOptions {
  style: NameStyleId;
  gender?: NameGender;
  surname?: boolean;
  seed: string | number;
  /** Required for the "learned" style; ignored otherwise. */
  model?: MarkovNameModel | null;
  /** Optional separate model for surnames in the "learned" style. */
  surnameModel?: MarkovNameModel | null;
}

export type RandomSource = () => number;

// ── Seeded randomness ──

/** 32-bit FNV-1a over the seed's text, so any string or number seeds the generator. */
function hashSeed(seed: string | number): number {
  const text = String(seed);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast and good enough for names. Returns floats in [0, 1). */
export function createSeededRandom(seed: string | number): RandomSource {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh random seed for "regenerate": short, readable and easy to copy. */
export function randomNameSeed(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let seed = "";
  for (let index = 0; index < 6; index += 1) seed += alphabet[Math.floor(Math.random() * alphabet.length)];
  return seed;
}

function pick<T>(random: RandomSource, items: readonly T[]): T {
  return items[Math.floor(random() * items.length) % items.length]!;
}

function between(random: RandomSource, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

// ── Shaping helpers ──

const VOWELS = /[aeiouyàáâäãåæèéêëìíîïòóôöõøœùúûüýÿ]/i;

function isVowel(character: string | undefined): boolean {
  return Boolean(character && VOWELS.test(character));
}

function capitalize(word: string): string {
  const characters = Array.from(word);
  if (characters.length === 0) return word;
  return characters[0]!.toLocaleUpperCase() + characters.slice(1).join("").toLocaleLowerCase();
}

/** Tidy a raw syllable string: no triple letters, no unreadable consonant pile-ups. */
function smooth(raw: string): string {
  let value = raw.toLowerCase().replace(/(.)\1\1+/g, "$1$1");
  // Four or more consonants in a row reads as a typo; keep the outer two.
  value = value.replace(/[^aeiouyàáâäãåæèéêëìíîïòóôöõøœùúûüýÿ'\-\s]{4,}/gi, (run) => run.slice(0, 1) + run.slice(-1));
  // Three vowels in a row, or a doubled i/u/y, stops reading as a name.
  value = value.replace(/[aeiouy]{3,}/gi, (run) => run.slice(0, 2)).replace(/([iuy])\1/gi, "$1");
  return value;
}

/** Join a root and an ending without doubling the vowel at the seam. */
function joinEnding(root: string, ending: string): string {
  if (!ending) return root;
  const last = root.at(-1);
  const first = ending[0];
  if (isVowel(last) && isVowel(first)) return root.slice(0, -1) + ending;
  if (last && first && last === first) return root + ending.slice(1);
  return root + ending;
}

// ── Syllable styles ──

interface SyllableStyle {
  onsets: readonly string[];
  medialOnsets: readonly string[];
  nuclei: readonly string[];
  codas: readonly string[];
  codaChance: number;
  /** Root syllables before the gendered ending. */
  syllables: readonly [number, number];
  endings: Record<NameGender, readonly string[]>;
  maxLength: number;
  surname: (random: RandomSource, gender: NameGender, root: () => string) => string;
}

const NORTHERN_SURNAME_HEADS = [
  "Frost",
  "Iron",
  "Storm",
  "Wolf",
  "Raven",
  "Grim",
  "Stone",
  "Ash",
  "Bear",
  "Ice",
  "Blood",
  "Oak",
];
const NORTHERN_SURNAME_TAILS = [
  "hammer",
  "born",
  "mane",
  "helm",
  "ward",
  "fell",
  "beard",
  "shield",
  "brand",
  "tooth",
  "hide",
];
const ELVISH_SURNAME_HEADS = [
  "Silver",
  "Moon",
  "Star",
  "Dawn",
  "Leaf",
  "Mist",
  "Wind",
  "Sun",
  "Dew",
  "Willow",
  "Night",
];
const ELVISH_SURNAME_TAILS = ["whisper", "song", "bough", "light", "brook", "shade", "bloom", "veil", "glade", "thorn"];

type SyllableStyleSpec = Omit<SyllableStyle, "medialOnsets">;

const STYLE_SPECS: Record<Exclude<NameStyleId, "learned">, SyllableStyleSpec> = {
  northern: {
    onsets: [
      "b",
      "br",
      "d",
      "dr",
      "g",
      "gr",
      "h",
      "hr",
      "k",
      "kj",
      "kr",
      "sk",
      "st",
      "sv",
      "t",
      "th",
      "v",
      "r",
      "s",
      "bj",
      "ulf",
      "tor",
    ],
    nuclei: ["a", "o", "u", "e", "i", "ei", "au", "y"],
    codas: ["rn", "rd", "lf", "k", "g", "nd", "rk", "st", "r", "n", "ld", "m", "gg"],
    codaChance: 0.7,
    syllables: [1, 2],
    endings: {
      neutral: ["", "", "i", "ir", "e"],
      feminine: ["a", "hild", "run", "dis", "gerd", "ny", "rid", "ja"],
      masculine: ["ulf", "bjorn", "ar", "mund", "grim", "vald", "ir", "rik"],
    },
    maxLength: 11,
    surname: (random, gender, root) => {
      if (random() < 0.5) return `${pick(random, NORTHERN_SURNAME_HEADS)}${pick(random, NORTHERN_SURNAME_TAILS)}`;
      const parent = capitalize(root());
      return gender === "feminine" ? `${parent}sdottir` : gender === "masculine" ? `${parent}sson` : `${parent}sbur`;
    },
  },
  elvish: {
    onsets: ["l", "th", "el", "gal", "s", "ar", "n", "f", "il", "ae", "c", "m", "r", "v", "er", "sil", "tal"],
    nuclei: ["a", "e", "i", "ae", "ia", "ie", "ea", "ya", "o", "ai"],
    codas: ["l", "n", "r", "th", "s", "nd", "ll"],
    codaChance: 0.4,
    syllables: [1, 2],
    endings: {
      neutral: ["", "ae", "is", "en", "ith"],
      feminine: ["iel", "wen", "ra", "eth", "ia", "lith", "wyn", "elle", "ine"],
      masculine: ["ion", "or", "las", "dir", "ros", "ren", "dor", "ael"],
    },
    maxLength: 12,
    surname: (random, _gender, root) =>
      random() < 0.55
        ? `${pick(random, ELVISH_SURNAME_HEADS)}${pick(random, ELVISH_SURNAME_TAILS)}`
        : capitalize(joinEnding(root(), pick(random, ["dil", "ethil", "arion", "orn", "iel", "andor"]))),
  },
  desert: {
    onsets: ["z", "q", "kh", "sh", "j", "r", "az", "nas", "far", "h", "s", "m", "t", "d", "b", "y", "k", "l"],
    nuclei: ["a", "i", "u", "aa", "ai", "e", "ei"],
    codas: ["r", "m", "n", "d", "z", "h", "b", "l", "s", "f", "k"],
    codaChance: 0.55,
    syllables: [1, 2],
    endings: {
      neutral: ["", "an", "ir", "el"],
      feminine: ["a", "ia", "ra", "ima", "eh", "ira", "ya", "ah", "ena"],
      masculine: ["ir", "an", "im", "ud", "ar", "if", "am", "ub", "id"],
    },
    maxLength: 10,
    surname: (random, gender, root) => {
      const family = capitalize(joinEnding(root(), pick(random, ["i", "ani", "ari", "un", "ez", "ad"])));
      if (random() < 0.5) return `al-${family}`;
      return gender === "feminine" ? `bint ${family}` : gender === "masculine" ? `ibn ${family}` : `al-${family}`;
    },
  },
  imperial: {
    onsets: ["c", "m", "l", "v", "aur", "cl", "qu", "s", "t", "fl", "oct", "val", "luc", "g", "p", "dr", "sev", "cass"],
    nuclei: ["a", "e", "i", "o", "u", "ae", "au"],
    codas: ["r", "n", "l", "s", "t", "x", "c", "nt", "rv"],
    codaChance: 0.45,
    syllables: [1, 2],
    endings: {
      neutral: ["ian", "is", "ens", "ex", "o"],
      feminine: ["ia", "a", "ina", "illa", "essa", "ella", "ana"],
      masculine: ["us", "ius", "o", "an", "ian", "ex", "or"],
    },
    maxLength: 11,
    surname: (random, gender, root) => {
      const family = joinEnding(
        root(),
        gender === "feminine" ? "ia" : gender === "masculine" ? "ius" : pick(random, ["ian", "ius", "ia"]),
      );
      return capitalize(family);
    },
  },
};

function withMedialOnsets(spec: SyllableStyleSpec): SyllableStyle {
  return { ...spec, medialOnsets: spec.onsets.filter((onset) => !isVowel(onset[0])) };
}

const STYLES: Record<Exclude<NameStyleId, "learned">, SyllableStyle> = {
  northern: withMedialOnsets(STYLE_SPECS.northern),
  elvish: withMedialOnsets(STYLE_SPECS.elvish),
  desert: withMedialOnsets(STYLE_SPECS.desert),
  imperial: withMedialOnsets(STYLE_SPECS.imperial),
};

function syllableRoot(style: SyllableStyle, random: RandomSource, syllables: number): string {
  let root = "";
  for (let index = 0; index < syllables; index += 1) {
    // Onsets are optional after a vowel-final syllable, which keeps longer names flowing.
    const needsOnset = index === 0 ? random() < 0.85 : !isVowel(root.at(-1)) ? random() < 0.35 : true;
    // Vowel-led onsets ("el", "ar") only open a name; mid-word they pile up vowels.
    if (needsOnset) root += pick(random, index === 0 ? style.onsets : style.medialOnsets);
    root += pick(random, style.nuclei);
    if (random() < style.codaChance && index === syllables - 1) root += pick(random, style.codas);
  }
  return smooth(root);
}

function syllableName(style: SyllableStyle, random: RandomSource, gender: NameGender): string {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const root = syllableRoot(style, random, between(random, style.syllables[0], style.syllables[1]));
    const name = smooth(joinEnding(root, pick(random, style.endings[gender])));
    const letters = Array.from(name).length;
    if (letters >= 3 && letters <= style.maxLength) return capitalize(name);
  }
  return capitalize(syllableRoot(style, random, style.syllables[0]).slice(0, style.maxLength));
}

// ── Markov model ──

const TRAINING_STOPWORDS = new Set([
  "the",
  "of",
  "and",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "by",
  "with",
  "house",
  "clan",
  "order",
  "lord",
  "lady",
  "sir",
  "king",
  "queen",
  "prince",
  "princess",
  "saint",
  "st",
  "mount",
  "lake",
  "river",
  "city",
  "old",
  "new",
  "great",
  "north",
  "south",
  "east",
  "west",
  "notes",
  "note",
  "lore",
  "history",
  "chapter",
  "court",
  "kingdom",
  "empire",
  "temple",
  "guild",
  "church",
  "tower",
  "castle",
  "forest",
  "valley",
  "war",
  "age",
  "world",
  "magic",
  "rules",
  "general",
  "overview",
  "location",
  "character",
  "faction",
  "item",
]);

/**
 * Pull name-like words out of free text such as lorebook entry names: capitalized,
 * letters only, three to fourteen letters, and not a common title or filler word.
 */
export function extractTrainingNames(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const text of texts) {
    if (typeof text !== "string") continue;
    for (const token of text.split(/[\s,;:()[\]{}"/|.!?]+/)) {
      const word = token.replace(/^['-]+|['-]+$/g, "");
      if (!/^\p{Lu}[\p{L}'-]{2,13}$/u.test(word)) continue;
      const key = word.toLocaleLowerCase();
      if (TRAINING_STOPWORDS.has(key) || seen.has(key)) continue;
      seen.add(key);
      names.push(word);
    }
  }
  return names;
}

/** Train a character-level Markov model. Names are lowercased; order 2 suits short lists best. */
export function trainMarkovNameModel(names: readonly string[], order = 2): MarkovNameModel {
  const transitions: Record<string, Record<string, number>> = {};
  const known: string[] = [];
  let minLength = Number.POSITIVE_INFINITY;
  let maxLength = 0;
  for (const raw of names) {
    const name = raw.trim().toLocaleLowerCase();
    const letters = Array.from(name);
    if (letters.length < 2) continue;
    known.push(name);
    minLength = Math.min(minLength, letters.length);
    maxLength = Math.max(maxLength, letters.length);
    const padded = [...new Array<string>(order).fill("^"), ...letters, "$"];
    for (let index = order; index < padded.length; index += 1) {
      const context = padded.slice(index - order, index).join("");
      const next = padded[index]!;
      const bucket = (transitions[context] ??= {});
      bucket[next] = (bucket[next] ?? 0) + 1;
    }
  }
  return {
    order,
    transitions,
    known,
    minLength: Number.isFinite(minLength) ? Math.max(3, minLength) : 3,
    maxLength: Math.max(4, Math.min(14, maxLength || 8)),
  };
}

/** Whether a model has enough material to produce varied names. */
export function isUsableMarkovModel(model: MarkovNameModel | null | undefined): model is MarkovNameModel {
  return Boolean(model && model.known.length >= 3 && Object.keys(model.transitions).length > 0);
}

function sampleWeighted(random: RandomSource, bucket: Record<string, number>): string {
  const entries = Object.entries(bucket).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [character, weight] of entries) {
    roll -= weight;
    if (roll < 0) return character;
  }
  return entries.at(-1)![0];
}

function markovWord(model: MarkovNameModel, random: RandomSource): string | null {
  const letters: string[] = [];
  let context = "^".repeat(model.order);
  while (letters.length <= model.maxLength) {
    const bucket = model.transitions[context];
    if (!bucket) return null;
    const next = sampleWeighted(random, bucket);
    if (next === "$") break;
    letters.push(next);
    context = [...Array.from(context), next].slice(-model.order).join("");
  }
  if (letters.length < model.minLength || letters.length > model.maxLength) return null;
  return letters.join("");
}

/** Soft gender fit for learned names: endings that read feminine or masculine in most fantasy settings. */
function genderFit(name: string, gender: NameGender): boolean {
  if (gender === "neutral") return true;
  const feminine = /(a|ia|ie|ine|elle|ette|wen|iel|is|eth|ra|na|ly|lyn|yn|e)$/i.test(name);
  return gender === "feminine" ? feminine : !feminine;
}

function markovName(
  model: MarkovNameModel,
  random: RandomSource,
  gender: NameGender,
  avoid: ReadonlySet<string>,
): string {
  const known = new Set(model.known);
  let fallback: string | null = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const word = markovWord(model, random);
    if (!word) continue;
    const cleaned = smooth(word);
    if (avoid.has(cleaned)) continue;
    fallback ??= cleaned;
    // Prefer something new over a copy of a training name, and a gender fit when asked.
    if (known.has(cleaned) && attempt < 40) continue;
    if (!genderFit(cleaned, gender) && attempt < 45) continue;
    return capitalize(cleaned);
  }
  return capitalize(fallback ?? model.known[Math.floor(random() * model.known.length)] ?? "Nameless");
}

// ── Public API ──

function styleFor(style: NameStyleId): SyllableStyle {
  return STYLES[style === "learned" ? "northern" : style];
}

/** Generate one name from a random source. The learned style needs a usable model. */
export function generateNameWith(
  random: RandomSource,
  options: Omit<NameGeneratorOptions, "seed">,
  avoid: ReadonlySet<string> = new Set(),
): GeneratedName {
  const gender = options.gender ?? "neutral";
  let given: string;
  let surname: string | null = null;
  if (options.style === "learned") {
    if (!isUsableMarkovModel(options.model)) throw new Error("The learned style needs a trained name model.");
    given = markovName(options.model, random, gender, avoid);
    if (options.surname) {
      const surnameModel = isUsableMarkovModel(options.surnameModel) ? options.surnameModel : options.model;
      surname = markovName(surnameModel, random, "neutral", new Set([given.toLocaleLowerCase()]));
    }
  } else {
    const style = styleFor(options.style);
    given = syllableName(style, random, gender);
    for (let attempt = 0; attempt < 6 && avoid.has(given.toLocaleLowerCase()); attempt += 1) {
      given = syllableName(style, random, gender);
    }
    if (options.surname) {
      surname = style.surname(random, gender, () => {
        const short = syllableRoot(style, random, 1);
        return short.length >= 3 ? short : syllableRoot(style, random, 2);
      });
    }
  }
  // Style surname builders join words and endings after smoothing; tidy the seam again.
  if (surname) surname = surname.replace(/[aeiouy]{3,}/gi, (run) => run.slice(0, 2));
  return { given, surname, full: surname ? `${given} ${surname}` : given };
}

/** The name in one slot of a seeded list. Slot i depends only on the seed and i. */
export function generateNameAt(
  options: NameGeneratorOptions,
  slot: number,
  avoid?: ReadonlySet<string>,
): GeneratedName {
  return generateNameWith(createSeededRandom(`${options.seed}:${options.style}:${slot}`), options, avoid);
}

/** A list of distinct names for one seed. */
export function generateNames(options: NameGeneratorOptions, count: number): GeneratedName[] {
  const names: GeneratedName[] = [];
  const used = new Set<string>();
  for (let slot = 0; names.length < count && slot < count * 4; slot += 1) {
    const name = generateNameAt(options, slot, used);
    const key = name.given.toLocaleLowerCase();
    if (used.has(key)) continue;
    used.add(key);
    names.push(name);
  }
  return names;
}
