import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import {
  WORLD_HISTORY_ATTRIBUTE,
  worldHistorySchema,
  isWorldHistoryDateValid,
  type CampaignMemoryEntity,
  type GameCalendarConfig,
  type WorldHistoryData,
  type WorldHistoryEntry,
} from "@marinara-engine/shared";
import { useApplyCampaignMemoryMutation, useCampaignMemoryEntities } from "../../hooks/use-campaign-memory";
import { EditorField, EditorSelect, EditorAlert, editorButton } from "./CampaignWikiCreateRecord";

export function WorldHistoryEditor({
  chatId,
  entry,
  related,
  config,
  onDone,
  onCancel,
  onDirty,
}: {
  chatId: string;
  entry: WorldHistoryEntry | null;
  related: CampaignMemoryEntity[];
  config: GameCalendarConfig | null;
  onDone: () => void;
  onCancel: () => void;
  onDirty: () => void;
}) {
  const { t } = useTranslation();
  const existing = entry?.history;
  const [title, setTitle] = useState(entry?.entity.aliases[0] ?? "");
  const [body, setBody] = useState(entry?.entity.body ?? entry?.entity.summary ?? "");
  const [era, setEra] = useState(existing?.era ?? config?.era ?? "");
  const [eraOrder, setEraOrder] = useState(String(existing?.eraOrder ?? 0));
  const [certainty, setCertainty] = useState<WorldHistoryData["certainty"]>(existing?.certainty ?? "unknown");
  const [dateLabel, setDateLabel] = useState(existing?.dateLabel ?? "");
  const [year, setYear] = useState(existing?.date ? String(existing.date.year) : "");
  const [month, setMonth] = useState(existing?.date?.month != null ? String(existing.date.month) : "");
  const [day, setDay] = useState(existing?.date?.day != null ? String(existing.date.day) : "");
  const [participants, setParticipants] = useState(existing?.participantEntityIds ?? []);
  const [location, setLocation] = useState(existing?.locationEntityId ?? null);
  const [names, setNames] = useState(() => new Map(related.map((e) => [e.entityId, e.aliases[0] ?? e.entityId])));
  const [lookup, setLookup] = useState("");
  const [lookupKind, setLookupKind] = useState<"character" | "organization" | "location">("character");
  const [lookupOffset, setLookupOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const results = useCampaignMemoryEntities(entry?.entity.originChatId ?? chatId, {
    query: lookup,
    kind: lookupKind,
    offset: lookupOffset,
    limit: 10,
  });
  const mutation = useApplyCampaignMemoryMutation(entry?.entity.originChatId ?? chatId);
  const dirty = () => {
    onDirty();
    setOperationId(crypto.randomUUID());
    setError(null);
  };
  const add = (entity: CampaignMemoryEntity) => {
    dirty();
    setNames((old) => new Map(old).set(entity.entityId, entity.aliases[0] ?? entity.entityId));
    if (entity.kind === "location") setLocation(entity.entityId);
    else setParticipants((old) => (old.includes(entity.entityId) ? old : [...old, entity.entityId]));
  };
  const save = async () => {
    const parsed = worldHistorySchema.safeParse({
      version: 1,
      era,
      eraOrder: Number(eraOrder),
      certainty,
      dateLabel,
      date:
        certainty === "unknown" || !year.trim()
          ? null
          : {
              year: Number(year),
              month: month === "" ? null : Number(month),
              day: day.trim() === "" ? null : Number(day),
            },
      participantEntityIds: participants,
      locationEntityId: location,
    });
    if (
      !title.trim() ||
      !body.trim() ||
      !eraOrder.trim() ||
      !parsed.success ||
      (certainty !== "unknown" && !year.trim() && (month !== "" || day.trim() !== "")) ||
      (parsed.success && config && !isWorldHistoryDateValid(parsed.data.date, config))
    ) {
      setError(t("ui.worldHistory.invalid"));
      return;
    }
    const attributes = { ...entry?.entity.attributes, [WORLD_HISTORY_ATTRIBUTE]: parsed.data };
    const patch = {
      aliases: [title.trim(), ...(entry?.entity.aliases.slice(1) ?? [])],
      body: body.trim(),
      attributes,
      manualLock: true,
    };
    try {
      if (entry)
        await mutation.mutateAsync({
          operationId,
          action: "update",
          recordType: "entity",
          recordId: entry.entity.entityId,
          expectedRevision: entry.entity.revision,
          reason: "Edit manually authored world history",
          patch,
        });
      else {
        const id = `world-history-${operationId}`;
        await mutation.mutateAsync({
          operationId,
          action: "create",
          recordType: "entity",
          reason: "Add manually authored world history",
          input: {
            ...patch,
            entityId: id,
            kind: "note",
            owner: { type: "registry", store: "campaign-memory", recordId: id },
            tags: ["world-history"],
            status: "active",
          },
        });
      }
      onDone();
    } catch {
      setError(t("ui.worldHistory.saveFailed"));
    }
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-sm text-muted-foreground">{t("ui.worldHistory.authoringHelp")}</p>
      <fieldset disabled={mutation.isPending} className="space-y-4 disabled:opacity-60">
        <EditorField
          label={t("ui.worldHistory.eventTitle")}
          value={title}
          onChange={(v) => {
            dirty();
            setTitle(v);
          }}
          multiline={false}
          required
          maxLength={500}
        />
        <EditorField
          label={t("ui.worldHistory.description")}
          value={body}
          onChange={(v) => {
            dirty();
            setBody(v);
          }}
          rows={5}
          required
          maxLength={20000}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <EditorField
            label={t("ui.worldHistory.era")}
            value={era}
            onChange={(v) => {
              dirty();
              setEra(v);
            }}
            multiline={false}
            maxLength={100}
          />
          <EditorField
            label={t("ui.worldHistory.eraOrder")}
            hint={t("ui.worldHistory.eraOrderHelp")}
            value={eraOrder}
            onChange={(v) => {
              dirty();
              setEraOrder(v);
            }}
            multiline={false}
          />
        </div>
        <EditorSelect
          label={t("ui.worldHistory.certainty")}
          value={certainty}
          onChange={(v) => {
            dirty();
            setCertainty(v as WorldHistoryData["certainty"]);
          }}
        >
          {["exact", "approximate", "uncertain", "unknown"].map((value) => (
            <option key={value} value={value}>
              {t(`ui.worldHistory.${value}`)}
            </option>
          ))}
        </EditorSelect>
        <EditorField
          label={t("ui.worldHistory.dateLabel")}
          hint={t("ui.worldHistory.dateHelp")}
          value={dateLabel}
          onChange={(v) => {
            dirty();
            setDateLabel(v);
          }}
          multiline={false}
          maxLength={300}
        />
        {certainty !== "unknown" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <EditorField
              label={t("ui.worldHistory.year")}
              value={year}
              onChange={(v) => {
                dirty();
                setYear(v);
              }}
              multiline={false}
            />
            {config ? (
              <EditorSelect
                label={t("ui.worldHistory.month")}
                value={month}
                onChange={(v) => {
                  dirty();
                  setMonth(v);
                  if (!v) setDay("");
                }}
              >
                <option value="">{t("ui.worldHistory.unspecified")}</option>
                {config.months.map((m, i) => (
                  <option value={String(i)} key={i}>
                    {m.name}
                  </option>
                ))}
              </EditorSelect>
            ) : (
              <p className="text-sm text-muted-foreground sm:col-span-2">{t("ui.worldHistory.calendarHelp")}</p>
            )}
            {config && (
              <EditorField
                label={t("ui.worldHistory.day")}
                value={day}
                onChange={(v) => {
                  dirty();
                  setDay(v);
                }}
                multiline={false}
                disabled={month === ""}
              />
            )}
          </div>
        )}
        <div className="border-t border-border pt-4 space-y-3">
          <p className="text-sm font-semibold">{t("ui.worldHistory.links")}</p>
          <div className="flex flex-wrap gap-2">
            {[...participants, ...(location ? [location] : [])].map((id) => (
              <button
                type="button"
                key={id}
                className={editorButton.secondary}
                onClick={() => {
                  dirty();
                  if (id === location) setLocation(null);
                  else setParticipants((old) => old.filter((x) => x !== id));
                }}
                aria-label={t("ui.worldHistory.removeLink", { name: names.get(id) ?? id })}
              >
                {names.get(id) ?? t("ui.worldHistory.missingLink")}
                <X size={14} />
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <EditorSelect
              label={t("ui.worldHistory.linkKind")}
              value={lookupKind}
              onChange={(v) => {
                setLookupKind(v as typeof lookupKind);
                setLookupOffset(0);
              }}
            >
              {["character", "organization", "location"].map((value) => (
                <option key={value} value={value}>
                  {t(`ui.game.campaignWiki.kind.${value}`)}
                </option>
              ))}
            </EditorSelect>
            <EditorField
              label={t("ui.worldHistory.findLink")}
              value={lookup}
              onChange={(v) => {
                setLookup(v);
                setLookupOffset(0);
              }}
              multiline={false}
              maxLength={100}
            />
          </div>
          {results.isError && (
            <p role="alert" className="text-sm text-destructive">
              {t("ui.worldHistory.loadFailed")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {results.data?.items
              .filter((e) => e.status === "active")
              .map((e) => (
                <button
                  type="button"
                  className={editorButton.secondary}
                  key={e.entityId}
                  disabled={
                    participants.includes(e.entityId) ||
                    location === e.entityId ||
                    (lookupKind !== "location" && participants.length >= 100)
                  }
                  onClick={() => add(e)}
                >
                  {e.aliases[0] ?? e.entityId}
                </button>
              ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className={editorButton.ghost}
              disabled={lookupOffset === 0 || results.isFetching}
              onClick={() => setLookupOffset((v) => Math.max(0, v - 10))}
            >
              {t("ui.worldHistory.previous")}
            </button>
            <button
              type="button"
              className={editorButton.ghost}
              disabled={!results.data || lookupOffset + 10 >= results.data.total || results.isFetching}
              onClick={() => setLookupOffset((v) => v + 10)}
            >
              {t("ui.worldHistory.next")}
            </button>
          </div>
        </div>
      </fieldset>
      {error && <EditorAlert>{error}</EditorAlert>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={editorButton.primary} disabled={mutation.isPending}>
          {mutation.isPending && <Loader2 size={16} className="animate-spin" />}
          {t("ui.worldHistory.save")}
        </button>
        <button type="button" className={editorButton.secondary} disabled={mutation.isPending} onClick={onCancel}>
          {t("ui.worldHistory.cancel")}
        </button>
      </div>
    </form>
  );
}
