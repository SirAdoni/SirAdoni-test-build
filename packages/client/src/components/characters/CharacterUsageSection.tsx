// ──────────────────────────────────────────────
// Character editor: where this character is used
// Collapsed to one line ("In 4 chats, 2 games, last played 3d ago"); expands to
// the chats and games with roles, last activity and, on request, message counts.
// ──────────────────────────────────────────────
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Gamepad2, Hash, Loader2, MessageCircle, Theater } from "lucide-react";
import { cn } from "../../lib/utils";
import { formatRelativeContact } from "../../lib/relative-time";
import { openChatFromPalette } from "../command-palette/palette-navigation";
import { useCharacterUsage, type CharacterChatUsage, type CharacterUsageRole } from "../../hooks/use-character-usage";

const ROLE_KEYS: Record<CharacterUsageRole, string> = {
  member: "characters.usage.roleMember",
  persona: "characters.usage.rolePersona",
  party: "characters.usage.roleParty",
  npc: "characters.usage.roleNpc",
  gm: "characters.usage.roleGm",
};

const MODE_ICONS = { conversation: MessageCircle, roleplay: Theater, game: Gamepad2 } as const;

function ChatRow({ usage, count }: { usage: CharacterChatUsage; count: number | undefined }) {
  const { t } = useTranslation();
  const Icon = MODE_ICONS[usage.mode] ?? MessageCircle;
  return (
    <li>
      <button
        type="button"
        onClick={() => void openChatFromPalette(usage.chatId)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--accent)]"
        title={t("characters.usage.openChat")}
      >
        <Icon size="0.8125rem" className="shrink-0 text-[var(--muted-foreground)]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-[var(--foreground)]">{usage.chatName}</span>
          <span className="block truncate text-[0.625rem] pointer-coarse:text-[0.6875rem] text-[var(--muted-foreground)]">
            {usage.roles.map((role) => t(ROLE_KEYS[role])).join(", ")}
            {" · "}
            {formatRelativeContact(usage.lastActivityAt) ?? ""}
          </span>
        </span>
        {count !== undefined && (
          <span
            className="shrink-0 text-[0.625rem] pointer-coarse:text-[0.6875rem] tabular-nums text-[var(--muted-foreground)]"
            title={t("characters.usage.messages", { count })}
          >
            {count}
          </span>
        )}
      </button>
    </li>
  );
}

export function CharacterUsageSection({ characterId }: { characterId: string | null }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [withCounts, setWithCounts] = useState(false);
  const base = useCharacterUsage(characterId);
  const counted = useCharacterUsage(withCounts ? characterId : null, { counts: true });
  const data = counted.data ?? base.data;

  if (!characterId) return null;

  const chatCount = data?.chats.length ?? 0;
  const gameCount = data?.games.length ?? 0;
  const summary = !data
    ? null
    : chatCount === 0
      ? t("characters.usage.neverUsed")
      : [
          t("characters.usage.chatCount", { count: chatCount }),
          gameCount > 0 ? t("characters.usage.gameCount", { count: gameCount }) : null,
          data.lastActivityAt
            ? t("characters.usage.lastPlayed", { when: formatRelativeContact(data.lastActivityAt) ?? "" })
            : null,
        ]
          .filter(Boolean)
          .join(", ");

  return (
    <div className="mt-5 rounded-xl border border-[var(--border)]" data-component="CharacterUsageSection">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        disabled={chatCount === 0}
        className="flex w-full items-center gap-2 px-3 py-2 text-left disabled:cursor-default"
      >
        <span className="text-[0.625rem] pointer-coarse:text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
          {t("characters.usage.title")}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--foreground)]">
          {base.isLoading ? (
            <Loader2 size="0.75rem" className="animate-spin" />
          ) : base.isError ? (
            t("characters.usage.failed")
          ) : (
            summary
          )}
        </span>
        {chatCount > 0 && (
          <ChevronDown
            size="0.875rem"
            className={cn("shrink-0 text-[var(--muted-foreground)] transition-transform", open && "rotate-180")}
          />
        )}
      </button>

      {open && data && chatCount > 0 && (
        <div className="space-y-3 border-t border-[var(--border)] px-2 pb-2 pt-2">
          {data.games.length > 0 && (
            <div>
              <p className="px-2 pb-1 text-[0.625rem] pointer-coarse:text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("characters.usage.games")}
              </p>
              <ul>
                {data.games.map((game) => {
                  const newest = data.chats.find((usage) => usage.gameId === game.gameId);
                  return (
                    <li key={game.gameId}>
                      <button
                        type="button"
                        onClick={() => newest && void openChatFromPalette(newest.chatId)}
                        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--accent)]"
                        title={t("characters.usage.openLatestSession")}
                      >
                        <Gamepad2 size="0.8125rem" className="shrink-0 text-[var(--muted-foreground)]" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-[var(--foreground)]">{game.gameName}</span>
                          <span className="block truncate text-[0.625rem] pointer-coarse:text-[0.6875rem] text-[var(--muted-foreground)]">
                            {game.roles.map((role) => t(ROLE_KEYS[role])).join(", ")}
                            {" · "}
                            {t("characters.usage.sessions", { count: game.sessions })}
                            {" · "}
                            {formatRelativeContact(game.lastActivityAt) ?? ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between gap-2 px-2 pb-1">
              <p className="text-[0.625rem] pointer-coarse:text-[0.6875rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
                {t("characters.usage.chats")}
              </p>
              {!withCounts || counted.isFetching ? (
                <button
                  type="button"
                  onClick={() => setWithCounts(true)}
                  disabled={counted.isFetching}
                  className="mari-chrome-control mari-chrome-control--compact"
                  title={t("characters.usage.countMessagesHint")}
                >
                  {counted.isFetching ? <Loader2 size="0.625rem" className="animate-spin" /> : <Hash size="0.625rem" />}
                  {t("characters.usage.countMessages")}
                </button>
              ) : data.messageCountsTruncated ? (
                <span className="text-[0.625rem] pointer-coarse:text-[0.6875rem] text-[var(--muted-foreground)]">
                  {t("characters.usage.countsTruncated")}
                </span>
              ) : null}
            </div>
            <ul className="max-h-72 overflow-y-auto">
              {data.chats.map((usage) => (
                <ChatRow key={usage.chatId} usage={usage} count={data.messageCounts?.[usage.chatId]} />
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
