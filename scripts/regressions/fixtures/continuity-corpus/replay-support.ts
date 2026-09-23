import { createHash } from "node:crypto";
import type { DB } from "../../../../packages/server/src/db/connection.js";
import { createChatsStorage } from "../../../../packages/server/src/services/storage/chats.storage.js";
import { createConnectionsStorage } from "../../../../packages/server/src/services/storage/connections.storage.js";
import { createGameContinuityRuntime } from "../../../../packages/server/src/services/game/continuity-runtime.js";
import {
  planContinuityTurnBatches,
  prepareContinuitySources,
} from "../../../../packages/server/src/services/game/continuity-sources.js";
import type { GameContinuityReceipt } from "@marinara-engine/shared";

export const CORPUS_CHAT_ID = "synthetic-continuity-corpus-chat";

type RawMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  activeSwipeIndex: number;
};

export type CorpusCase = {
  factId: string;
  sourceIds: string[];
  actor: string;
  recipientTerms: string[];
  conditionKeywords: string[];
};

export type CorpusCohort = {
  cohort: string;
  chatId: string;
  messages: RawMessage[];
  acceptedAssistantIds: string[];
  sources: Array<{ messageId: string }>;
  cases: CorpusCase[];
  responses: Record<string, { stage: string; response: unknown }>;
  connectionId?: string;
};

const initialMessages: RawMessage[] = [
  {
    id: "synthetic-user-turn",
    role: "user",
    content: "Scout asked Archivist to deliver the map after the gate opens.",
    activeSwipeIndex: 0,
  },
  {
    id: "synthetic-assistant-turn",
    role: "assistant",
    content: "Scout delivered the map to Archivist after the gate opened.",
    activeSwipeIndex: 0,
  },
  {
    id: "synthetic-follow-up",
    role: "user",
    content: "The party records the completed delivery.",
    activeSwipeIndex: 0,
  },
];

export function loadCohorts(): CorpusCohort[] {
  return [
    {
      cohort: "synthetic-generic-delivery",
      chatId: CORPUS_CHAT_ID,
      messages: initialMessages.map((message) => ({ ...message })),
      acceptedAssistantIds: ["synthetic-assistant-turn"],
      sources: [
        { messageId: "synthetic-user-turn" },
        { messageId: "synthetic-assistant-turn" },
      ],
      cases: [
        {
          factId: "synthetic-map-delivery",
          sourceIds: ["synthetic-user-turn", "synthetic-assistant-turn"],
          actor: "scout",
          recipientTerms: ["archivist"],
          conditionKeywords: ["gate"],
        },
      ],
      responses: {},
    },
  ];
}

export function chatMetadata(cohort: CorpusCohort): Record<string, unknown> {
  return {
    gameContinuity: {
      mode: "active",
      activationMessageId: cohort.messages[0]?.id,
      extractorConnectionId: cohort.connectionId ?? "synthetic-connection",
      verifierConnectionId: cohort.connectionId ?? "synthetic-connection",
    },
  };
}

export function corpusMessages(cohort: CorpusCohort): RawMessage[] {
  return cohort.messages;
}

export function sourceIdsOf(receipt: Pick<GameContinuityReceipt, "sources">): string[] {
  return [...new Set(receipt.sources.map((source) => source.messageId))];
}

export function requestKey(stage: string, receipt: Pick<GameContinuityReceipt, "sources" | "context">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        stage,
        sources: receipt.sources.map(({ messageId, start, end, content }) => ({ messageId, start, end, content })),
        context: receipt.context.map(({ messageId, start, end, content }) => ({ messageId, start, end, content })),
      }),
    )
    .digest("hex");
}

function recordedExtraction(receipt: Pick<GameContinuityReceipt, "sources">) {
  const sourceIds = sourceIdsOf(receipt);
  return {
    records: sourceIds.map((messageId) => {
      const source = receipt.sources.find((candidate) => candidate.messageId === messageId)!;
      return {
        id: "temporary",
        kind: source.role.startsWith("user") ? "decision" : "event",
        text: source.content,
        subjects: ["Scout", "Archivist", "map"],
        conditions: ["gate opened"],
        status: source.role.startsWith("user") ? "proposed" : "completed",
        knowledge: { scope: "world", holders: [] },
        evidence: [{ messageId, quote: source.content.slice(0, Math.min(24, source.content.length)) }],
        keys: ["scout", "archivist", "gate"],
      };
    }),
    dispositions: sourceIds.map((messageId) => ({
      messageId,
      status: "covered",
      reason: "The synthetic source records the delivery and its gate condition.",
    })),
  };
}

function recordedReview(receipt: Pick<GameContinuityReceipt, "sources">) {
  return {
    findings: [],
    dispositions: sourceIdsOf(receipt).map((messageId) => ({
      messageId,
      status: "covered",
      reason: "The extracted event is supported by the synthetic source.",
    })),
  };
}

function recordExpectedResponses(
  cohort: CorpusCohort,
  batches: Array<{ sources: GameContinuityReceipt["sources"]; context: GameContinuityReceipt["context"] }>,
): void {
  for (const batch of batches) {
    const expected = { sources: batch.sources, context: batch.context };
    cohort.responses[requestKey("extract", expected)] = {
      stage: "extract",
      response: recordedExtraction(expected),
    };
    cohort.responses[requestKey("review", expected)] = {
      stage: "review",
      response: recordedReview(expected),
    };
  }
}

export async function seedCohortChat(db: DB, cohort: CorpusCohort): Promise<void> {
  const connections = createConnectionsStorage(db);
  const connection = await connections.create({
    name: "Synthetic continuity recording",
    provider: "openai",
    baseUrl: "http://synthetic.invalid",
    apiKey: "synthetic-test-key",
    model: "synthetic-recorded-model",
  });
  cohort.connectionId = connection.id;
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: cohort.cohort, mode: "game", characterIds: [], connectionId: connection.id });
  if (!chat) throw new Error("synthetic cohort chat was not created");
  cohort.chatId = chat.id;
  const createdIds = await chats.createMessagesBatch(
    chat.id,
    cohort.messages.map(({ role, content }) => ({ role, content, characterId: null })),
  );
  const originalIds = cohort.messages.map((message) => message.id);
  const stored = await chats.listMessages(chat.id);
  cohort.messages = cohort.messages.map((message, index) => ({
    ...message,
    id: createdIds[index]!,
    ...(stored[index]?.createdAt ? { createdAt: stored[index]!.createdAt } : {}),
  }));
  const acceptedId = cohort.messages[1]!.id;
  cohort.acceptedAssistantIds = [acceptedId];
  cohort.sources = cohort.messages.slice(0, 2).map((message) => ({ messageId: message.id }));
  const idMap = new Map(originalIds.map((id, index) => [id, cohort.messages[index]!.id]));
  cohort.cases = cohort.cases.map((item) => ({
    ...item,
    sourceIds: item.sourceIds.map((id) => idMap.get(id) ?? id),
  }));
  await chats.updateMetadata(chat.id, chatMetadata(cohort));
}

export async function replayCohort(
  db: DB,
  cohort: CorpusCohort,
  complete: (args: { stage: string; receipt: GameContinuityReceipt }) => Promise<unknown>,
): Promise<GameContinuityReceipt[]> {
  const prepared = prepareContinuitySources(corpusMessages(cohort), chatMetadata(cohort));
  const planned = cohort.acceptedAssistantIds.flatMap((id) => planContinuityTurnBatches(prepared, id, 8000));
  recordExpectedResponses(cohort, planned);
  const runtime = createGameContinuityRuntime(db, {
    maxConcurrent: 1,
    backfillConcurrency: 1,
    complete: async ({ stage, receipt }) => complete({ stage, receipt }),
  });
  await runtime.enqueueHistoricalRange({
    chatId: cohort.chatId,
    backfillId: `synthetic-${cohort.cohort}`,
    fromMessageId: cohort.messages[0]!.id,
    toMessageId: cohort.acceptedAssistantIds[0]!,
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const receipts = await runtime.list(cohort.chatId);
    if (receipts.length > 0 && receipts.every((receipt) => ["verified", "published", "failed", "unresolved"].includes(receipt.status))) {
      await runtime.stop();
      return receipts;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await runtime.stop();
  throw new Error("synthetic continuity cohort did not reach a terminal receipt state");
}
