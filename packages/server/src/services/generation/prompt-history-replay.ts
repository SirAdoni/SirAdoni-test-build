import { createHash } from "node:crypto";
import { fitMessagesToContext, type ChatMessage } from "../llm/base-provider.js";

export interface PromptHistoryReplayScope {
  provider: string;
  model: string;
  scope: string;
}

// Any change to the canonical message boundary invalidates persisted replay
// descriptors instead of risking reuse against a differently scoped prompt.
export const PROMPT_HISTORY_REPLAY_SCOPE_VERSION = 6 as const;

export interface PromptHistoryReplayDescriptor {
  descriptorVersion: 1;
  scopeVersion: typeof PROMPT_HISTORY_REPLAY_SCOPE_VERSION;
  messageFingerprints: string[];
  tailStart: number;
  currentUserFingerprint: string;
  promptSha256: string;
  canonicalCharCount: number;
  textOnly: boolean;
  hasMarkedFullLore: boolean;
  scope: PromptHistoryReplayScope;
}

export interface PromptHistoryReplayOptions {
  currentMessages: readonly ChatMessage[];
  previousPrompt: readonly ChatMessage[];
  previousDescriptor: PromptHistoryReplayDescriptor;
  scope: PromptHistoryReplayScope;
  maxContext?: number;
  maxTokens?: number;
}

export interface PromptHistoryReplayResult {
  prompt: ChatMessage[];
  appendedMessages: ChatMessage[];
  canonicalMessages: ChatMessage[];
  descriptor: PromptHistoryReplayDescriptor;
}

export const PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE =
  "The following trusted context applies to the current user turn, whether it appears before or after the user message. The newest snapshot replaces prior snapshots, including fields now absent. Prior snapshots describe only prior turns. A <marinara_replay_snapshot_ref id=...>...</marinara_replay_snapshot_ref> is identical to the earlier full <marinara_replay_snapshot id=...>...</marinara_replay_snapshot> with the matching id; references may resolve only backward to that full snapshot and never to another reference. Inside a full snapshot, ordered <marinara_replay_snapshot_chunk id=...>...</marinara_replay_snapshot_chunk> blocks contain exact consecutive text fragments; a <marinara_replay_snapshot_chunk_ref id=...></marinara_replay_snapshot_chunk_ref> stands for the identical earlier full literal chunk with the matching id. Reconstruct a snapshot by concatenating its chunks in order, resolving only to earlier full literal chunks and never through another reference. The full snapshot id identifies the exact reconstructed text and current producer metadata. Omitted snapshot sections are absent and must not be inherited. The standing instruction hierarchy remains unchanged.";

const SNAPSHOT_MARKER = "marinaraPromptHistoryReplaySnapshot";
const RUNTIME_MARKER = "marinaraRuntimeContext";
const PREAMBLE_MARKER = "marinaraPromptHistoryReplayPreamble";
const SNAPSHOT_ID = "marinaraPromptHistoryReplaySnapshotId";
const SNAPSHOT_FULL = "marinaraPromptHistoryReplaySnapshotFull";
const SNAPSHOT_REFERENCE = "marinaraPromptHistoryReplaySnapshotReference";
const SNAPSHOT_CHUNKED = "marinaraPromptHistoryReplaySnapshotChunked";
const SNAPSHOT_BEGIN = "<marinara_replay_snapshot";
const SNAPSHOT_END = "</marinara_replay_snapshot>";
const REFERENCE_BEGIN = "<marinara_replay_snapshot_ref";
const REFERENCE_END = "</marinara_replay_snapshot_ref>";
const SNAPSHOT_CHUNK_BEGIN = '<marinara_replay_snapshot_chunk id="';
const SNAPSHOT_CHUNK_END = "</marinara_replay_snapshot_chunk>";
const SNAPSHOT_CHUNK_REFERENCE_BEGIN = '<marinara_replay_snapshot_chunk_ref id="';
const SNAPSHOT_CHUNK_REFERENCE_END = "</marinara_replay_snapshot_chunk_ref>";
const MIN_SNAPSHOT_FRAGMENT_SOURCE_LENGTH = 4096;
const MIN_SNAPSHOT_FRAGMENT_LENGTH = 512;
const MAX_SNAPSHOT_FRAGMENT_LENGTH = 2048;
const MIN_SNAPSHOT_REFERENCE_CONTENT_LENGTH = 256;
const SNAPSHOT_FRAGMENT_VOLATILE_METADATA_KEYS = new Set(["marinaraCampaignMemory", "continuity"]);
const REPLAY_METADATA_KEYS = new Set([SNAPSHOT_ID, SNAPSHOT_FULL, SNAPSHOT_REFERENCE, SNAPSHOT_CHUNKED]);

interface SnapshotFragment {
  id: string;
  content: string;
}

interface DecodedSnapshot {
  original: string;
  literalFragments: SnapshotFragment[];
  parts: Array<SnapshotFragment & { literal: boolean }>;
}

function stripReplaySnapshotMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const stripped = { ...(metadata ?? {}) };
  for (const key of REPLAY_METADATA_KEYS) delete stripped[key];
  return stripped;
}

function hashSnapshotPayload(role: string, content: string, metadata: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ role, content, metadata })), "utf8")
    .digest("hex");
}

function snapshotFragmentMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const stripped = stripReplaySnapshotMetadata(metadata);
  for (const key of SNAPSHOT_FRAGMENT_VOLATILE_METADATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(stripped, key)) stripped[key] = true;
  }
  return stripped;
}

function hashSnapshotFragment(message: ChatMessage, content: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          role: message.role,
          contextKind: message.contextKind,
          content,
          metadata: snapshotFragmentMetadata(message.providerMetadata),
        }),
      ),
      "utf8",
    )
    .digest("hex");
}

function labeledSnapshotContent(message: ChatMessage): { id: string; original: string } | null {
  const id = message.providerMetadata?.[SNAPSHOT_ID];
  if (typeof id !== "string" || !message.content.startsWith(`${SNAPSHOT_BEGIN} id="${id}">\n`)) return null;
  if (!message.content.endsWith(`\n${SNAPSHOT_END}`)) return null;
  return {
    id,
    original: message.content.slice(`${SNAPSHOT_BEGIN} id="${id}">\n`.length, -`\n${SNAPSHOT_END}`.length),
  };
}

function decodeSnapshotFragments(
  message: ChatMessage,
  content: string,
  sources: ReadonlyMap<string, SnapshotFragment> = new Map(),
): DecodedSnapshot | null {
  if (message.providerMetadata?.[SNAPSHOT_CHUNKED] !== true)
    return { original: content, literalFragments: [], parts: [] };
  const available = new Map(sources);
  const literalFragments: SnapshotFragment[] = [];
  const parts: Array<SnapshotFragment & { literal: boolean }> = [];
  let original = "";
  let offset = 0;
  while (offset < content.length) {
    const isLiteral = content.startsWith(SNAPSHOT_CHUNK_BEGIN, offset);
    const isReference = content.startsWith(SNAPSHOT_CHUNK_REFERENCE_BEGIN, offset);
    if (!isLiteral && !isReference) return null;
    const prefix = isLiteral ? SNAPSHOT_CHUNK_BEGIN : SNAPSHOT_CHUNK_REFERENCE_BEGIN;
    const headerEnd = content.indexOf('">\n', offset + prefix.length);
    if (headerEnd < 0) return null;
    const id = content.slice(offset + prefix.length, headerEnd);
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    const payloadStart = headerEnd + 3;
    if (isLiteral) {
      const end = content.indexOf(SNAPSHOT_CHUNK_END, payloadStart);
      if (end < 0) return null;
      const fragmentContent = content.slice(payloadStart, end);
      if (hashSnapshotFragment(message, fragmentContent) !== id) return null;
      original += fragmentContent;
      const fragment = { id, content: fragmentContent };
      literalFragments.push(fragment);
      parts.push({ ...fragment, literal: true });
      offset = end + SNAPSHOT_CHUNK_END.length;
      continue;
    }
    if (!content.startsWith(SNAPSHOT_CHUNK_REFERENCE_END, payloadStart)) return null;
    const source = available.get(id);
    if (!source || hashSnapshotFragment(message, source.content) !== id) return null;
    original += source.content;
    parts.push({ ...source, literal: false });
    offset = payloadStart + SNAPSHOT_CHUNK_REFERENCE_END.length;
  }
  return offset > 0 ? { original, literalFragments, parts } : null;
}

function decodeFullSnapshot(
  message: ChatMessage,
  sources: ReadonlyMap<string, SnapshotFragment> = new Map(),
): DecodedSnapshot | null {
  if (
    (message.role !== "system" && message.role !== "user") ||
    message.contextKind !== "injection" ||
    message.providerMetadata?.[SNAPSHOT_MARKER] !== true ||
    message.providerMetadata?.[RUNTIME_MARKER] !== true ||
    message.providerMetadata?.[SNAPSHOT_FULL] !== true ||
    message.providerMetadata?.[SNAPSHOT_REFERENCE] === true
  )
    return null;
  const labeled = labeledSnapshotContent(message);
  if (!labeled) return null;
  // The outer full-snapshot wrapper adds one delimiter newline before its end
  // tag; keep that framing byte out of the exact fragment reconstruction.
  const fragmentBody =
    message.providerMetadata?.[SNAPSHOT_CHUNKED] === true && labeled.original.endsWith("\n")
      ? labeled.original.slice(0, -1)
      : labeled.original;
  const decoded = decodeSnapshotFragments(message, fragmentBody, sources);
  if (!decoded) return null;
  const baseMetadata = stripReplaySnapshotMetadata(message.providerMetadata);
  return labeled.id === hashSnapshotPayload(message.role, decoded.original, baseMetadata) ? decoded : null;
}

function isReplaySnapshotFull(
  message: ChatMessage,
  sources: ReadonlyMap<string, SnapshotFragment> = new Map(),
): boolean {
  return decodeFullSnapshot(message, sources) !== null;
}

function makeLabeledSnapshot(message: ChatMessage): ChatMessage {
  if (isReplaySnapshotFull(message)) return { ...message };
  // Bind producer metadata as well as text so equal-looking sections from
  // different producers cannot accidentally share an identity.
  const baseMetadata = stripReplaySnapshotMetadata(message.providerMetadata);
  const id = hashSnapshotPayload(message.role, message.content, baseMetadata);
  return {
    ...message,
    content: `${SNAPSHOT_BEGIN} id="${id}">\n${message.content}\n${SNAPSHOT_END}`,
    providerMetadata: {
      ...baseMetadata,
      [RUNTIME_MARKER]: true,
      [SNAPSHOT_MARKER]: true,
      [SNAPSHOT_ID]: id,
      [SNAPSHOT_FULL]: true,
      [SNAPSHOT_REFERENCE]: false,
    },
  };
}

function splitSnapshotLines(content: string): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset < content.length) {
    const newline = content.indexOf("\n", offset);
    const end = newline < 0 ? content.length : newline + 1;
    lines.push(content.slice(offset, end));
    offset = end;
  }
  return lines;
}

function snapshotChunks(content: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of splitSnapshotLines(content)) {
    const lineHash = createHash("sha256").update(line, "utf8").digest()[0]!;
    const stableBoundary = current.length >= MIN_SNAPSHOT_FRAGMENT_LENGTH && (lineHash & 3) === 0;
    const maximumBoundary =
      current.length >= MIN_SNAPSHOT_FRAGMENT_LENGTH && current.length + line.length > MAX_SNAPSHOT_FRAGMENT_LENGTH;
    if (current && (stableBoundary || maximumBoundary)) {
      chunks.push(current);
      current = "";
    }
    current += line;
    if (current.length >= MAX_SNAPSHOT_FRAGMENT_LENGTH) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function snapshotFragmentMarkers(): readonly string[] {
  return [SNAPSHOT_CHUNK_BEGIN, SNAPSHOT_CHUNK_END, SNAPSHOT_CHUNK_REFERENCE_BEGIN, SNAPSHOT_CHUNK_REFERENCE_END];
}

function encodeSnapshotFragments(message: ChatMessage): ChatMessage {
  const labeled = labeledSnapshotContent(message);
  if (
    !labeled ||
    message.providerMetadata?.[SNAPSHOT_CHUNKED] === true ||
    labeled.original.length < MIN_SNAPSHOT_FRAGMENT_SOURCE_LENGTH ||
    snapshotFragmentMarkers().some((marker) => labeled.original.includes(marker))
  )
    return { ...message };
  const chunks = snapshotChunks(labeled.original);
  if (chunks.length < 2) return { ...message };
  const content = chunks
    .map((chunk) => {
      const id = hashSnapshotFragment(message, chunk);
      return SNAPSHOT_CHUNK_BEGIN + id + '">\n' + chunk + SNAPSHOT_CHUNK_END;
    })
    .join("");
  const encoded: ChatMessage = {
    ...message,
    content: SNAPSHOT_BEGIN + ' id="' + labeled.id + '">\n' + content + "\n" + SNAPSHOT_END,
    providerMetadata: { ...message.providerMetadata, [SNAPSHOT_CHUNKED]: true },
  };
  return isReplaySnapshotFull(encoded) ? encoded : { ...message };
}

function makeSnapshotReference(message: ChatMessage): ChatMessage {
  const id = message.providerMetadata?.[SNAPSHOT_ID];
  if (typeof id !== "string") return { ...message };
  const baseMetadata = stripReplaySnapshotMetadata(message.providerMetadata);
  return {
    ...message,
    content: `${REFERENCE_BEGIN} id="${id}">${id}${REFERENCE_END}`,
    providerMetadata: {
      ...baseMetadata,
      [RUNTIME_MARKER]: true,
      [SNAPSHOT_MARKER]: true,
      [SNAPSHOT_ID]: id,
      [SNAPSHOT_FULL]: false,
      [SNAPSHOT_REFERENCE]: true,
    },
  };
}

function sameFullSnapshotWithSources(
  a: ChatMessage,
  b: ChatMessage,
  aSources: ReadonlyMap<string, SnapshotFragment> = new Map(),
): boolean {
  if (!isReplaySnapshotFull(a, aSources) || !isReplaySnapshotFull(b) || a.role !== b.role) return false;
  const aLabeled = labeledSnapshotContent(a);
  const bLabeled = labeledSnapshotContent(b);
  return Boolean(aLabeled && bLabeled && aLabeled.id === bLabeled.id && fingerprint(a) === fingerprint(b));
}

function renderSnapshotChunk(fragment: SnapshotFragment, literal: boolean): string {
  return literal
    ? SNAPSHOT_CHUNK_BEGIN + fragment.id + '">\n' + fragment.content + SNAPSHOT_CHUNK_END
    : SNAPSHOT_CHUNK_REFERENCE_BEGIN + fragment.id + '">\n' + SNAPSHOT_CHUNK_REFERENCE_END;
}

function compactSnapshotFragments(message: ChatMessage, sources: ReadonlyMap<string, SnapshotFragment>): ChatMessage {
  if (message.providerMetadata?.[SNAPSHOT_CHUNKED] !== true) return { ...message };
  const labeled = labeledSnapshotContent(message);
  const decoded = decodeFullSnapshot(message);
  if (!labeled || !decoded || decoded.parts.length < 2) return { ...message };
  const parts = decoded.parts.map((part) => {
    if (!part.literal) return part;
    const source = sources.get(part.id);
    if (!source || hashSnapshotFragment(message, source.content) !== part.id) return part;
    const literalText = renderSnapshotChunk(part, true);
    const referenceText = renderSnapshotChunk(part, false);
    return referenceText.length < literalText.length ? { ...part, literal: false } : part;
  });
  if (!parts.some((part, index) => part.literal !== decoded.parts[index]!.literal)) return { ...message };
  const encoded: ChatMessage = {
    ...message,
    content:
      SNAPSHOT_BEGIN +
      ' id="' +
      labeled.id +
      '">\n' +
      parts.map((part) => renderSnapshotChunk(part, part.literal)).join("") +
      "\n" +
      SNAPSHOT_END,
  };
  return isReplaySnapshotFull(encoded, sources) && wireText(encoded).length < wireText(message).length
    ? encoded
    : { ...message };
}

function previousReplaySnapshots(prompt: readonly ChatMessage[]): {
  fullSnapshots: Array<{ message: ChatMessage; sources: ReadonlyMap<string, SnapshotFragment> }>;
  fragments: Map<string, SnapshotFragment>;
} {
  const fullSnapshots: Array<{ message: ChatMessage; sources: ReadonlyMap<string, SnapshotFragment> }> = [];
  const fragments = new Map<string, SnapshotFragment>();
  for (const message of prompt) {
    const sourcesBefore = new Map(fragments);
    const decoded = decodeFullSnapshot(message, sourcesBefore);
    if (!decoded) continue;
    fullSnapshots.push({ message, sources: sourcesBefore });
    for (const fragment of decoded.literalFragments) fragments.set(fragment.id, fragment);
  }
  return { fullSnapshots, fragments };
}

// Only replace explicitly producer-owned full snapshots already retained in the
// previous request. Never deduplicate dialogue or reference a reference: the
// complete original payload must remain available to interpret the newest state.
function compactReplayTail(tail: readonly ChatMessage[], previousPrompt: readonly ChatMessage[]): ChatMessage[] {
  const previous = previousReplaySnapshots(previousPrompt);
  return tail.map((message) => {
    const decoded = decodeFullSnapshot(message);
    if (!decoded || decoded.original.length < MIN_SNAPSHOT_REFERENCE_CONTENT_LENGTH) return { ...message };
    const matchingFull = previous.fullSnapshots.find((candidate) =>
      sameFullSnapshotWithSources(candidate.message, message, candidate.sources),
    );
    if (matchingFull) {
      const reference = makeSnapshotReference(message);
      if (wireText(reference).length < wireText(message).length) return reference;
    }
    return compactSnapshotFragments(message, previous.fragments);
  });
}

function isReplayPreamble(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    message.content === PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE &&
    message.contextKind === "injection" &&
    message.providerMetadata?.[PREAMBLE_MARKER] === true &&
    message.providerMetadata?.[RUNTIME_MARKER] === true
  );
}

function isReplaySnapshotProducer(message: ChatMessage): boolean {
  return (
    (message.role === "system" || message.role === "user") &&
    message.contextKind === "injection" &&
    message.providerMetadata?.[SNAPSHOT_MARKER] === true &&
    message.providerMetadata?.[RUNTIME_MARKER] === true
  );
}

/**
 * Seed the producer-owned boundary before the first current-turn injection.
 * The marker is deliberately narrow: arbitrary system text cannot become
 * archived replay state merely by resembling a runtime snapshot.
 */
export function seedPromptHistoryReplaySnapshot(messages: readonly ChatMessage[]): ChatMessage[] {
  if (!messages.every(isTextOnly)) return [...messages];
  const currentUserIndex = lastHistoryUserIndex(messages);
  const previousAssistantIndex = previousHistoryAssistantIndex(messages, currentUserIndex);
  if (currentUserIndex < 0 || previousAssistantIndex < 0) return [...messages];
  if (
    messages.some(
      (message, index) =>
        index > previousAssistantIndex &&
        index !== currentUserIndex &&
        (!isReplayInjection(message) || !isTextOnly(message)),
    )
  )
    return [...messages];
  const labeled = messages.map((message, index) =>
    index > previousAssistantIndex && index !== currentUserIndex && isReplaySnapshotProducer(message)
      ? makeLabeledSnapshot(message)
      : message,
  );
  if (
    labeled.some(
      (message, index) =>
        index > previousAssistantIndex &&
        index !== currentUserIndex &&
        message.role === "system" &&
        !isReplayPreamble(message) &&
        !isReplaySnapshotFull(message),
    )
  )
    return [...messages];
  const firstInjection = messages.findIndex(
    (message, index) =>
      index > previousAssistantIndex && index !== currentUserIndex && message.contextKind === "injection",
  );
  if (firstInjection < 0) return [...messages];
  const chunked = labeled.map((message, index) =>
    index > previousAssistantIndex && index !== currentUserIndex && isReplaySnapshotFull(message)
      ? encodeSnapshotFragments(message)
      : message,
  );
  const preambleIndex = messages.findIndex(
    (message, index) => index > previousAssistantIndex && index !== currentUserIndex && isReplayPreamble(message),
  );
  if (preambleIndex === firstInjection) return [...chunked];
  const preamble: ChatMessage = {
    role: "system",
    content: PROMPT_HISTORY_REPLAY_TAIL_PREAMBLE,
    contextKind: "injection",
    // Keep the preamble at the same provider priority and cache boundary as
    // the snapshot it scopes; otherwise adjacent-message merging can erase it.
    providerMetadata: { [PREAMBLE_MARKER]: true, [RUNTIME_MARKER]: true },
  };
  return [...chunked.slice(0, firstInjection), preamble, ...chunked.slice(firstInjection)];
}

function isReplayInjection(message: ChatMessage): boolean {
  if (message.contextKind !== "injection" || (message.role !== "user" && message.role !== "system")) return false;
  return (
    message.role !== "system" ||
    isReplayPreamble(message) ||
    isReplaySnapshotFull(message) ||
    isReplaySnapshotProducer(message)
  );
}

function lastHistoryUserIndex(messages: readonly ChatMessage[]): number {
  let lastHistoryIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.contextKind === "history") lastHistoryIndex = index;
  }
  return lastHistoryIndex >= 0 && messages[lastHistoryIndex]?.role === "user" ? lastHistoryIndex : -1;
}

function previousHistoryAssistantIndex(messages: readonly ChatMessage[], userIndex: number): number {
  for (let index = userIndex - 1; index >= 0; index--) {
    if (messages[index]?.contextKind === "history") return messages[index]?.role === "assistant" ? index : -1;
  }
  return -1;
}

function validReplaySystemLayout(messages: readonly ChatMessage[], userIndex: number, assistantIndex: number): boolean {
  if (userIndex <= assistantIndex || assistantIndex < 0) return false;
  const tail = messages.filter((_message, index) => index > assistantIndex && index !== userIndex);
  if (!tail.length || tail.some((message) => !isReplayInjection(message))) return false;
  const firstInjection = tail.findIndex((message) => message.contextKind === "injection");
  return firstInjection >= 0 && isReplayPreamble(tail[firstInjection]!);
}

/** Retained state adds input: only opt in after a measured large partial cache hit. */
export function shouldReplayPromptHistory(input: {
  replayed?: unknown;
  promptTokens?: unknown;
  cachedTokens?: unknown;
}): boolean {
  const { promptTokens, cachedTokens } = input;
  if (
    typeof promptTokens !== "number" ||
    !Number.isFinite(promptTokens) ||
    promptTokens < 32_768 ||
    typeof cachedTokens !== "number" ||
    !Number.isFinite(cachedTokens) ||
    cachedTokens < 0 ||
    cachedTokens > promptTokens
  ) {
    return false;
  }
  // Once the chain is established, a provider-reported zero is a valid
  // observation of a cold/intermittent cache. Do not discard the chain and
  // rewrite the next prompt; zero is still ineligible as the initial signal.
  if (cachedTokens === 0) return input.replayed === true;
  // These are conservative optimization thresholds, not provider cache limits.
  // Keep an established chain when its improved hit rate crosses the entry threshold.
  return input.replayed === true || cachedTokens / promptTokens < 0.8;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function wireMessage(message: ChatMessage): Record<string, unknown> {
  // contextKind is a fitting hint, not provider wire content. In particular,
  // a saved history message may be reclassified by a later prompt assembly.
  return {
    role: message.role,
    content: message.content,
    ...(message.tool_call_id === undefined ? {} : { tool_call_id: message.tool_call_id }),
    ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
    ...(message.images === undefined ? {} : { images: message.images }),
    ...(message.files === undefined ? {} : { files: message.files }),
    ...(message.media === undefined ? {} : { media: message.media }),
    ...(message.providerMetadata === undefined ? {} : { providerMetadata: message.providerMetadata }),
  };
}

function wireText(message: ChatMessage): string {
  return JSON.stringify(canonicalize(wireMessage(message)));
}

function fingerprint(message: ChatMessage): string {
  return createHash("sha256").update(wireText(message), "utf8").digest("hex");
}

function promptSha256(prompt: readonly ChatMessage[]): string {
  const serialized = JSON.stringify(prompt.map(wireMessage).map(canonicalize));
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function canonicalCharCount(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + wireText(message).length, 0);
}

function providerVisibleCharCount(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, message) => total + message.role.length + message.content.length, 0);
}

function isTextOnly(message: ChatMessage): boolean {
  return (
    !message.tool_call_id &&
    !message.tool_calls?.length &&
    !message.images?.length &&
    !message.files?.length &&
    !message.media?.length
  );
}

function sameScope(a: PromptHistoryReplayScope, b: PromptHistoryReplayScope): boolean {
  return a.provider === b.provider && a.model === b.model && a.scope === b.scope;
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return (
    (message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "tool") &&
    typeof message.content === "string"
  );
}

/** Create the small descriptor persisted alongside an exact saved prompt. */
export function createPromptHistoryReplayDescriptor(
  messages: readonly ChatMessage[],
  prompt: readonly ChatMessage[],
  scope: PromptHistoryReplayScope,
): PromptHistoryReplayDescriptor | null {
  const currentUserIndex = lastHistoryUserIndex(messages);
  const previousAssistantIndex = previousHistoryAssistantIndex(messages, currentUserIndex);
  if (currentUserIndex < 0 || previousAssistantIndex < 0) return null;

  const tailStart = previousAssistantIndex + 1;
  if (
    tailStart >= messages.length ||
    !validReplaySystemLayout(messages, currentUserIndex, previousAssistantIndex) ||
    !messages.every(isTextOnly) ||
    !messages.some((message) => message.providerMetadata?.marinaraFullLoreContext === true)
  ) {
    return null;
  }

  return {
    descriptorVersion: 1,
    scopeVersion: PROMPT_HISTORY_REPLAY_SCOPE_VERSION,
    messageFingerprints: messages.map(fingerprint),
    tailStart,
    currentUserFingerprint: fingerprint(messages[currentUserIndex]!),
    promptSha256: promptSha256(prompt),
    canonicalCharCount: canonicalCharCount(messages),
    textOnly: messages.every(isTextOnly),
    hasMarkedFullLore: messages.some((message) => message.providerMetadata?.marinaraFullLoreContext === true),
    scope: { ...scope },
  };
}

function validDescriptor(descriptor: unknown): descriptor is PromptHistoryReplayDescriptor {
  if (!descriptor || typeof descriptor !== "object") return false;
  const candidate = descriptor as Partial<PromptHistoryReplayDescriptor>;
  const tailStart = candidate.tailStart;
  const canonicalChars = candidate.canonicalCharCount;
  const fingerprints = candidate.messageFingerprints;
  return (
    candidate.descriptorVersion === 1 &&
    candidate.scopeVersion === PROMPT_HISTORY_REPLAY_SCOPE_VERSION &&
    Array.isArray(fingerprints) &&
    fingerprints.length > 0 &&
    Number.isInteger(tailStart) &&
    typeof tailStart === "number" &&
    tailStart >= 0 &&
    tailStart < fingerprints.length &&
    typeof candidate.currentUserFingerprint === "string" &&
    typeof candidate.promptSha256 === "string" &&
    Number.isFinite(canonicalChars) &&
    typeof canonicalChars === "number" &&
    canonicalChars > 0 &&
    candidate.textOnly === true &&
    typeof candidate.hasMarkedFullLore === "boolean" &&
    !!candidate.scope &&
    typeof candidate.scope.provider === "string" &&
    typeof candidate.scope.model === "string" &&
    typeof candidate.scope.scope === "string"
  );
}

function appendableTail(messages: readonly ChatMessage[], tailStart: number): ChatMessage[] | null {
  const tail = messages.slice(tailStart + 1);
  const currentUserIndex = lastHistoryUserIndex(messages);
  const previousAssistantIndex = previousHistoryAssistantIndex(messages, currentUserIndex);
  if (currentUserIndex < 0 || previousAssistantIndex < 0) return null;
  if (
    tail.length < 2 ||
    tail.some(
      (message) =>
        message.role === "tool" ||
        (isReplaySnapshotProducer(message) && !isReplaySnapshotFull(message)) ||
        (message.role === "system" && !isReplayPreamble(message) && !isReplaySnapshotFull(message)),
    ) ||
    previousAssistantIndex <= tailStart ||
    !tail.some((message) => message.role === "assistant" && message.contextKind === "history") ||
    !validReplaySystemLayout(messages, currentUserIndex, previousAssistantIndex) ||
    !tail.some(isReplayPreamble)
  )
    return null;
  return [...tail];
}

/**
 * Reuse an exact saved prompt only when the canonical prefix and provider
 * scope still match. Returns null for any uncertain or unsafe case.
 */
export function tryReplayPromptHistory(options: PromptHistoryReplayOptions): PromptHistoryReplayResult | null {
  const { currentMessages, previousPrompt, previousDescriptor, scope, maxContext, maxTokens } = options;
  if (!Array.isArray(previousPrompt) || previousPrompt.length === 0 || !previousPrompt.every(isMessage)) return null;
  if (!validDescriptor(previousDescriptor)) return null;
  if (!sameScope(previousDescriptor.scope, scope)) return null;
  try {
    if (promptSha256(previousPrompt) !== previousDescriptor.promptSha256) return null;
  } catch {
    return null;
  }

  const currentUserIndex = lastHistoryUserIndex(currentMessages);
  if (currentUserIndex < 0) return null;
  if (!currentMessages.every(isTextOnly) || !previousDescriptor.textOnly) return null;
  if (
    !previousDescriptor.hasMarkedFullLore ||
    !currentMessages.some((message) => message.providerMetadata?.marinaraFullLoreContext === true)
  ) {
    return null;
  }
  if (currentMessages.length <= previousDescriptor.tailStart + 1) return null;

  const oldFingerprints = previousDescriptor.messageFingerprints;
  const candidatePrefix = currentMessages.slice(0, previousDescriptor.tailStart);
  if (candidatePrefix.length !== previousDescriptor.tailStart) return null;
  if (candidatePrefix.some((message, index) => fingerprint(message) !== oldFingerprints[index])) return null;
  if (fingerprint(currentMessages[previousDescriptor.tailStart]!) !== previousDescriptor.currentUserFingerprint)
    return null;

  const tail = appendableTail(currentMessages, previousDescriptor.tailStart);
  if (!tail) return null;
  const currentChars = providerVisibleCharCount(currentMessages);
  // Persist the descriptor from canonical messages while replaying the exact
  // expanded prompt separately; this keeps the next turn's prefix index valid.
  const compactedTail = compactReplayTail(tail, previousPrompt);
  const prompt = [...previousPrompt, ...compactedTail];
  const expandedChars = providerVisibleCharCount(prompt);
  const extraLimit = Math.min(500_000, Math.floor(currentChars * 0.5));
  if (expandedChars - currentChars > extraLimit) return null;

  if (maxContext !== undefined || maxTokens !== undefined) {
    try {
      const fitted = fitMessagesToContext([...prompt], { maxContext, maxTokens });
      if (fitted.trimmed) return null;
    } catch {
      return null;
    }
  }

  const descriptor = createPromptHistoryReplayDescriptor(currentMessages, prompt, scope);
  if (!descriptor) return null;
  return { prompt, appendedMessages: compactedTail, canonicalMessages: [...currentMessages], descriptor };
}
