import type { ComponentProps } from "react";
import { useWikiFeatureEnabled } from "../../hooks/use-feature-settings";

export function WorldHistoryModal(props: ComponentProps<typeof WorldHistoryModalContent>) {
  return useWikiFeatureEnabled("worldHistory") ? <WorldHistoryModalContent {...props} /> : null;
}

import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Archive, ArrowLeft, BookOpen, Loader2, Plus, RotateCcw } from "lucide-react";
import { type WorldHistoryEntry } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { useWorldHistory } from "../../hooks/use-world-history";
import { useGameCalendar } from "../../hooks/use-game-calendar";
import { useCampaignLeafMutation } from "../../hooks/use-campaign-leaf";
import { EditorField, EditorSelect, EditorAlert, editorButton } from "../game/CampaignWikiCreateRecord";
import { WorldHistoryEditor } from "../game/WorldHistoryEditor";
import { CampaignWikiOwnerLink } from "../game/CampaignWikiOwnerLink";

const CampaignWiki = lazy(() => import("../game/CampaignWiki").then((m) => ({ default: m.CampaignWiki })));

/** Each projected entry keeps the calendar of the session that owns its numeric date. */
function HistoricalDate({ entry, chatId }: { entry: WorldHistoryEntry; chatId: string }) {
  const { t } = useTranslation();
  const calendarEnabled = useWikiFeatureEnabled("gameCalendar");
  const calendar = useGameCalendar(entry.entity.originChatId ?? chatId);
  const config = calendarEnabled ? calendar.data?.calendar.config : undefined;
  const date = entry.history.date;
  const parts = date
    ? [
        date.day,
        date.month != null
          ? (config?.months[date.month]?.name ?? t("ui.worldHistory.monthNumber", { number: date.month + 1 }))
          : null,
        date.year,
      ].filter((part) => part !== null && part !== undefined)
    : [];
  return (
    <>
      <p>{parts.join(" ") || entry.history.dateLabel || t("ui.worldHistory.unknown")}</p>
      {parts.length > 0 && entry.history.dateLabel && <p>{entry.history.dateLabel}</p>}
    </>
  );
}

function WorldHistoryModalContent({ open, onClose, chatId }: { open: boolean; onClose: () => void; chatId: string }) {
  const { t } = useTranslation();
  const calendarEnabled = useWikiFeatureEnabled("gameCalendar");
  const wikiEnabled = useWikiFeatureEnabled("campaignWiki");
  const [query, setQuery] = useState("");
  const [era, setEra] = useState("all");
  const [offset, setOffset] = useState(0);
  const [archived, setArchived] = useState(false);
  const [editor, setEditor] = useState<WorldHistoryEntry | "new" | null>(null);
  const [dirty, setDirty] = useState(false);
  const [wiki, setWiki] = useState<string | null>(null);
  const [action, setAction] = useState<WorldHistoryEntry | null>(null);
  const [error, setError] = useState(false);
  const history = useWorldHistory(chatId, {
    q: query,
    era: era === "all" ? undefined : era.slice(4),
    offset,
    archived,
  });
  const calendar = useGameCalendar(editor && editor !== "new" ? (editor.entity.originChatId ?? chatId) : chatId);
  const config = calendarEnabled && calendar.data?.calendar.enabled ? calendar.data.calendar.config : null;
  const mutation = useCampaignLeafMutation(action?.entity.originChatId ?? chatId, "worldHistory");
  const leave = () => !dirty || window.confirm(t("ui.worldHistory.discard"));
  const close = () => {
    if (leave()) onClose();
  };
  const done = () => {
    setEditor(null);
    setDirty(false);
  };
  const archive = async () => {
    if (!action) return;
    try {
      await mutation.mutateAsync({
        operationId: crypto.randomUUID(),
        action: "update",
        recordType: "entity",
        recordId: action.entity.entityId,
        expectedRevision: action.entity.revision,
        reason: "Change world history archive status",
        patch: { status: action.entity.status === "active" ? "archived" : "active" },
      });
      setAction(null);
      setOffset(0);
      setError(false);
    } catch {
      setError(true);
    }
  };
  return (
    <Modal open={open} onClose={close} title={t("ui.worldHistory.title")} width="max-w-5xl">
      {wiki && wikiEnabled ? (
        <>
          <button
            type="button"
            className={editorButton.secondary}
            onClick={() => {
              if (leave()) {
                setWiki(null);
                setDirty(false);
              }
            }}
          >
            <ArrowLeft size={16} />
            {t("ui.worldHistory.back")}
          </button>
          <Suspense fallback={<Loader2 className="animate-spin" />}>
            <CampaignWiki
              chatId={chatId}
              selectedEntityId={wiki}
              onSelectedEntityChange={setWiki}
              onDirtyChange={setDirty}
            />
          </Suspense>
        </>
      ) : editor && calendarEnabled && calendar.isPending ? (
        <p role="status">{t("ui.worldHistory.loading")}</p>
      ) : editor && calendarEnabled && calendar.isError ? (
        <EditorAlert
          action={
            <button type="button" className={editorButton.secondary} onClick={() => void calendar.refetch()}>
              {t("ui.worldHistory.retry")}
            </button>
          }
        >
          {t("ui.worldHistory.loadFailed")}
        </EditorAlert>
      ) : editor ? (
        <WorldHistoryEditor
          key={editor === "new" ? "new" : editor.entity.entityId}
          chatId={chatId}
          entry={editor === "new" ? null : editor}
          related={history.data?.relatedEntities ?? []}
          config={config}
          onDone={done}
          onCancel={() => {
            if (leave()) done();
          }}
          onDirty={() => setDirty(true)}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-prose text-sm leading-6 text-muted-foreground">{t("ui.worldHistory.help")}</p>
            <button type="button" className={editorButton.primary} onClick={() => setEditor("new")}>
              <Plus size={16} />
              {t("ui.worldHistory.add")}
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <EditorField
              label={t("ui.worldHistory.search")}
              value={query}
              onChange={(v) => {
                setQuery(v);
                setOffset(0);
              }}
              multiline={false}
              maxLength={100}
            />
            <EditorSelect
              label={t("ui.worldHistory.era")}
              value={era}
              onChange={(v) => {
                setEra(v);
                setOffset(0);
              }}
            >
              <option value="all">{t("ui.worldHistory.allEras")}</option>
              {history.data?.eras.map((value) => (
                <option value={`era:${value}`} key={value}>
                  {value || t("ui.worldHistory.noEra")}
                </option>
              ))}
            </EditorSelect>
          </div>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => {
                setArchived(e.target.checked);
                setOffset(0);
              }}
            />
            {t("ui.worldHistory.showArchived")}
          </label>
          {history.isPending && (
            <p role="status" className="flex gap-2 text-sm">
              <Loader2 size={16} className="animate-spin" />
              {t("ui.worldHistory.loading")}
            </p>
          )}
          {history.isError && (
            <EditorAlert
              action={
                <button type="button" className={editorButton.secondary} onClick={() => void history.refetch()}>
                  {t("ui.worldHistory.retry")}
                </button>
              }
            >
              {t("ui.worldHistory.loadFailed")}
            </EditorAlert>
          )}
          {history.data && (
            <>
              <p role="status" className="text-sm text-muted-foreground">
                {t("ui.worldHistory.count", { count: history.data.total })}
              </p>
              {history.data.total === 0 && (
                <p className="py-6 text-sm text-muted-foreground">{t("ui.worldHistory.empty")}</p>
              )}
              <ol className="divide-y divide-border">
                {history.data.items.map((entry) => {
                  const { entity, history: event } = entry;
                  const location = history.data.relatedEntities.find((e) => e.entityId === event.locationEntityId);
                  return (
                    <li key={entity.entityId} className="py-5 first:pt-0">
                      <div className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
                        <div className="min-w-0 space-y-1 break-words text-sm text-muted-foreground">
                          <p className="font-semibold text-foreground">{event.era || t("ui.worldHistory.noEra")}</p>
                          <HistoricalDate entry={entry} chatId={chatId} />
                          <p>{t(`ui.worldHistory.${event.certainty}`)}</p>
                          {entity.status === "archived" && <p>{t("ui.worldHistory.archived")}</p>}
                        </div>
                        <div className="min-w-0 space-y-2">
                          <button
                            type="button"
                            className="max-w-full break-words text-left text-base font-semibold text-foreground hover:underline focus-visible:outline-primary"
                            onClick={() => setEditor(entry)}
                          >
                            {entity.aliases[0] ?? t("ui.worldHistory.eventTitle")}
                          </button>
                          <p className="max-w-prose whitespace-pre-wrap break-words text-sm leading-6">
                            {entity.body ?? entity.summary}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {[
                              ...event.participantEntityIds,
                              ...(event.locationEntityId ? [event.locationEntityId] : []),
                            ].map((id) => {
                              const target = history.data.relatedEntities.find((e) => e.entityId === id);
                              return target ? (
                                <button
                                  key={id}
                                  type="button"
                                  className={editorButton.ghost}
                                  disabled={!wikiEnabled}
                                  onClick={() => {
                                    if (wikiEnabled) setWiki(id);
                                  }}
                                >
                                  {target.aliases[0] ?? id}
                                </button>
                              ) : (
                                <span className="text-xs text-muted-foreground" key={id}>
                                  {t("ui.worldHistory.missingLink")}
                                </span>
                              );
                            })}
                          </div>
                          {location && (
                            <CampaignWikiOwnerLink
                              owner={location.owner}
                              fallbackName={location.aliases[0] ?? ""}
                              chatId={chatId}
                            />
                          )}
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              className={editorButton.ghost}
                              disabled={!wikiEnabled}
                              onClick={() => {
                                if (wikiEnabled) setWiki(entity.entityId);
                              }}
                            >
                              <BookOpen size={14} />
                              {t("ui.worldHistory.openWiki")}
                            </button>
                            <button
                              type="button"
                              className={editorButton.ghost}
                              onClick={() => {
                                setAction(entry);
                                setError(false);
                              }}
                            >
                              {entity.status === "active" ? <Archive size={14} /> : <RotateCcw size={14} />}
                              {t(entity.status === "active" ? "ui.worldHistory.archive" : "ui.worldHistory.restore")}
                            </button>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="flex justify-between gap-2">
                <button
                  type="button"
                  className={editorButton.secondary}
                  disabled={offset === 0 || history.isFetching}
                  onClick={() => setOffset((v) => Math.max(0, v - 25))}
                >
                  {t("ui.worldHistory.previous")}
                </button>
                <button
                  type="button"
                  className={editorButton.secondary}
                  disabled={offset + history.data.items.length >= history.data.total || history.isFetching}
                  onClick={() => setOffset((v) => v + 25)}
                >
                  {t("ui.worldHistory.next")}
                </button>
              </div>
            </>
          )}
          {action && (
            <EditorAlert
              tone="warning"
              action={
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={editorButton.secondary}
                    disabled={mutation.isPending}
                    onClick={() => void archive()}
                  >
                    {t("ui.worldHistory.confirm")}
                  </button>
                  <button
                    type="button"
                    className={editorButton.ghost}
                    disabled={mutation.isPending}
                    onClick={() => setAction(null)}
                  >
                    {t("ui.worldHistory.cancel")}
                  </button>
                </div>
              }
            >
              {t("ui.worldHistory.archiveHelp", { name: action.entity.aliases[0] })}
            </EditorAlert>
          )}
          {error && <EditorAlert>{t("ui.worldHistory.saveFailed")}</EditorAlert>}
        </div>
      )}
    </Modal>
  );
}
