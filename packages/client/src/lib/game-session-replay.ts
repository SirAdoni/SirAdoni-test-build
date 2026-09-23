import type { DirectionCommand, Message, SceneSegmentEffect } from "@marinara-engine/shared";
import { api } from "./api-client";
import { parseGmTags } from "./game-tag-parser";
import { normalizeChoiceText } from "./game-choice-utils";
import { parsePartyDialogue } from "./party-dialogue-parser";

export { findReplayStoryboardKeyframe } from "./game-storyboard-keyframes";

export interface GameReplayChoice {
  label: string;
  value: string;
  selected: boolean;
}

export interface GameReplayPresentationCue {
  background: string | null;
  music: string | null;
  ambient: string | null;
  sfx: string[];
  directions: DirectionCommand[];
  segmentEffects: SceneSegmentEffect[];
}

export interface GameSessionReplayTurn {
  message: Message;
  playerMessage: Message | null;
  partyDialogue: ReturnType<typeof parsePartyDialogue>;
  partyChatMessageId: string | null;
  choices: GameReplayChoice[];
  recordedChoice: GameReplayChoice | null;
  presentation: GameReplayPresentationCue;
}

type ReplayCueRecord = Partial<GameReplayPresentationCue>;

const SYNTHETIC_GAME_START_RE = /^\s*\[start(?:\s+the)?\s+game\]\s*$/i;
const SESSION_CONCLUSION_RE = /^\s*\*\*Session\s+\d+\s+Concluded\*\*/i;
const PARTY_CHAT_RE = /^\s*\[party-chat\]\s*/i;
const RECORDED_CHOICE_RE = /^\s*\[choice:\s*([\s\S]*?)\]\s*$/i;

function messageExtra(message: Message): Record<string, unknown> {
  const raw = message.extra as unknown;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function recordedChoiceText(content: string): string | null {
  const match = content.match(RECORDED_CHOICE_RE);
  if (!match) return null;
  const value = match[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
  return value || null;
}

function replayChoices(message: Message): Array<Omit<GameReplayChoice, "selected">> {
  const inlineChoices = parseGmTags(message.content || "").choices;
  if (inlineChoices?.length) {
    return inlineChoices.map((choice) => ({ label: choice, value: choice }));
  }

  const rawChoices = messageExtra(message).cyoaChoices;
  if (!Array.isArray(rawChoices)) return [];

  return rawChoices.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const value = typeof record.text === "string" ? record.text.trim() : "";
    if (!value) return [];
    const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : `Choice ${index + 1}`;
    return [{ label, value }];
  });
}

function replayCue(message: Message): GameReplayPresentationCue {
  const inline = parseGmTags(message.content || "");
  const rawStoredCue = messageExtra(message).gameReplayCue;
  const stored =
    rawStoredCue && typeof rawStoredCue === "object" && !Array.isArray(rawStoredCue)
      ? (rawStoredCue as ReplayCueRecord)
      : {};

  return {
    background: typeof stored.background === "string" ? stored.background : inline.background,
    music: typeof stored.music === "string" ? stored.music : inline.music,
    ambient: typeof stored.ambient === "string" ? stored.ambient : inline.ambient,
    sfx: Array.isArray(stored.sfx)
      ? stored.sfx.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : inline.sfx,
    directions: Array.isArray(stored.directions) ? stored.directions : inline.directions,
    segmentEffects: Array.isArray(stored.segmentEffects) ? stored.segmentEffects : [],
  };
}

function isReplayAssistantMessage(message: Message): boolean {
  if (message.role !== "assistant" && message.role !== "narrator") return false;
  const content = message.content || "";
  return !!content.trim() && !PARTY_CHAT_RE.test(content) && !SESSION_CONCLUSION_RE.test(content);
}

function replayPlayerMessage(message: Message | undefined): Message | null {
  if (!message || message.role !== "user" || !message.content?.trim()) return null;
  if (SYNTHETIC_GAME_START_RE.test(message.content)) return null;
  const choice = recordedChoiceText(message.content);
  return choice ? { ...message, content: choice } : message;
}

export function buildGameSessionReplayTurns(messages: readonly Message[]): GameSessionReplayTurn[] {
  const assistantIndexes = messages.flatMap((message, index) => (isReplayAssistantMessage(message) ? [index] : []));

  return assistantIndexes.map((messageIndex, turnIndex) => {
    const message = messages[messageIndex]!;
    const previousAssistantIndex = assistantIndexes[turnIndex - 1] ?? -1;
    const nextAssistantIndex = assistantIndexes[turnIndex + 1] ?? messages.length;
    const betweenPreviousAndCurrent = messages.slice(previousAssistantIndex + 1, messageIndex);
    const betweenCurrentAndNext = messages.slice(messageIndex + 1, nextAssistantIndex);
    const playerSource = [...betweenPreviousAndCurrent].reverse().find((candidate) => candidate.role === "user");
    const recordedResponse = betweenCurrentAndNext.find(
      (candidate) =>
        candidate.role === "user" && !!candidate.content?.trim() && !SYNTHETIC_GAME_START_RE.test(candidate.content),
    );
    const recordedText = recordedResponse
      ? (recordedChoiceText(recordedResponse.content) ?? recordedResponse.content.trim())
      : null;
    const choices = replayChoices(message).map((choice) => ({
      ...choice,
      selected:
        recordedText != null &&
        (normalizeChoiceText(choice.value) === normalizeChoiceText(recordedText) ||
          normalizeChoiceText(choice.label) === normalizeChoiceText(recordedText)),
    }));
    const partyMessage = betweenCurrentAndNext.find(
      (candidate) =>
        (candidate.role === "assistant" || candidate.role === "narrator") &&
        PARTY_CHAT_RE.test(candidate.content || ""),
    );

    return {
      message,
      playerMessage: replayPlayerMessage(playerSource),
      partyDialogue: partyMessage ? parsePartyDialogue(partyMessage.content.replace(PARTY_CHAT_RE, "")) : [],
      partyChatMessageId: partyMessage?.id ?? null,
      choices,
      recordedChoice: choices.find((choice) => choice.selected) ?? null,
      presentation: replayCue(message),
    };
  });
}

/** Store scene-analysis presentation output on its source message for deterministic replay. */
export function persistGameReplayPresentationCue(
  chatId: string,
  message: { id: string; content?: string | null },
  cue: GameReplayPresentationCue,
): void {
  void api
    .patch(`/chats/${chatId}/messages/${message.id}/extra`, {
      gameReplayCue: cue,
    })
    .catch((error) => console.warn("[game-replay] Failed to persist presentation cues", error));
}
