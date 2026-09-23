import { createHash } from "node:crypto";

export type LorebookKeeperSourceMessage = {
  id: string;
  role: string;
  content: string;
};

export type LorebookKeeperSourceRef = {
  messageId: string;
  /** Code-point offsets into the edited source message; splitting never bisects a surrogate pair. */
  start: number;
  end: number;
};

export type LorebookKeeperBatch = {
  transcriptText: string;
  sourceRefs: LorebookKeeperSourceRef[];
};

export async function processLorebookKeeperBatches<T>(args: {
  messages: LorebookKeeperSourceMessage[];
  maxChars?: number;
  batches?: LorebookKeeperBatch[];
  complete: (batch: LorebookKeeperBatch, index: number, total: number) => Promise<T>;
  onProgress?: (progress: {
    completedBatches: number;
    totalBatches: number;
    processedMessages: number;
    totalMessages: number;
  }) => void | Promise<void>;
}): Promise<{ outputs: T[]; batches: LorebookKeeperBatch[] }> {
  const batches = args.batches ?? batchLorebookKeeperTranscript(args.messages, args.maxChars);
  const outputs: T[] = [];
  const completed = new Set<string>();
  const expected = new Map<string, number>();
  for (const batch of batches)
    for (const ref of batch.sourceRefs) expected.set(ref.messageId, (expected.get(ref.messageId) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]!;
    outputs.push(await args.complete(batch, index, batches.length));
    for (const ref of batch.sourceRefs) {
      const count = (seen.get(ref.messageId) ?? 0) + 1;
      seen.set(ref.messageId, count);
      if (count === expected.get(ref.messageId)) completed.add(ref.messageId);
    }
    await args.onProgress?.({
      completedBatches: index + 1,
      totalBatches: batches.length,
      processedMessages: completed.size,
      totalMessages: args.messages.length,
    });
  }
  return { outputs, batches };
}

const DEFAULT_BATCH_CHARS = 16_000;

export function planLorebookKeeperBatches(
  messages: LorebookKeeperSourceMessage[],
  fits: (batch: LorebookKeeperBatch) => boolean,
  initialChars = DEFAULT_BATCH_CHARS,
): LorebookKeeperBatch[] {
  for (let maxChars = initialChars; maxChars >= 256; maxChars = Math.max(256, Math.floor(maxChars / 2))) {
    const batches = batchLorebookKeeperTranscript(messages, maxChars);
    if (batches.every(fits)) return batches;
    if (maxChars === 256) break;
  }
  throw new Error(
    "KEEPER_CONTEXT_OVERFLOW: fixed prompt overhead cannot fit even the smallest complete transcript batch.",
  );
}

export function hashLorebookKeeperSource(messages: LorebookKeeperSourceMessage[]): string {
  return createHash("sha256")
    .update(JSON.stringify(messages.map(({ id, role, content }) => ({ id, role, content }))))
    .digest("hex");
}

export function batchLorebookKeeperTranscript(
  messages: LorebookKeeperSourceMessage[],
  maxChars = DEFAULT_BATCH_CHARS,
): LorebookKeeperBatch[] {
  if (!Number.isInteger(maxChars) || maxChars < 256) throw new Error("Invalid Keeper batch size.");
  const batches: LorebookKeeperBatch[] = [];
  let lines: string[] = [];
  let refs: LorebookKeeperSourceRef[] = [];
  let length = 0;

  const flush = () => {
    if (lines.length === 0) return;
    batches.push({ transcriptText: lines.join("\n\n"), sourceRefs: refs });
    lines = [];
    refs = [];
    length = 0;
  };

  for (const message of messages) {
    const label = `[${message.role}] `;
    const content = Array.from(message.content);
    const available = Math.max(1, maxChars - label.length);
    let offset = 0;
    while (offset < content.length) {
      let take = 0;
      let units = 0;
      while (offset + take < content.length && units + content[offset + take]!.length <= available) {
        units += content[offset + take]!.length;
        take += 1;
      }
      if (take === 0) throw new Error("Keeper role label leaves no room for source text.");
      const piece = `${label}${content.slice(offset, offset + take).join("")}`;
      const separator = lines.length > 0 ? 2 : 0;
      if (length + separator + piece.length > maxChars && lines.length > 0) flush();
      const start = offset;
      offset += take;
      lines.push(piece);
      refs.push({ messageId: message.id, start, end: offset });
      length += (lines.length > 1 ? 2 : 0) + piece.length;
    }
    if (content.length === 0) {
      const piece = label.trimEnd();
      if (length + (lines.length > 0 ? 2 : 0) + piece.length > maxChars && lines.length > 0) flush();
      lines.push(piece);
      refs.push({ messageId: message.id, start: 0, end: 0 });
      length += (lines.length > 1 ? 2 : 0) + piece.length;
    }
  }
  flush();
  return batches;
}
