import type { ComponentProps } from "react";
import { useWikiFeatureEnabled } from "../../hooks/use-feature-settings";

export function CampaignFactionWeb(props: ComponentProps<typeof CampaignFactionWebContent>) {
  return useWikiFeatureEnabled("factionWeb") ? <CampaignFactionWebContent {...props} /> : null;
}

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CampaignMemoryRelationship, CampaignMemoryRelationshipStatus } from "@marinara-engine/shared";
import {
  useCampaignLeafEntities,
  useCampaignLeafMutation,
  type CampaignLeafEntity,
} from "../../hooks/use-campaign-leaf";
import { useFactionWeb, useFactionHistory } from "../../hooks/use-faction-web";
import { EditorField, EditorSelect, editorButton } from "./CampaignWikiCreateRecord";
import { recordWriteChatId, WikiChip } from "./campaign-wiki-ui";

const TYPES = ["allied-with", "rival-faction-of", "subordinate-to", "neutral-faction-toward"] as const;
const INVERSE = {
  "allied-with": "allied-with",
  "rival-faction-of": "rival-faction-of",
  "subordinate-to": "has-subordinate",
  "neutral-faction-toward": "neutral-faction-from",
};
const name = (entity: CampaignLeafEntity) => entity.aliases[0] || entity.entityId;
const key = (value: string) =>
  `ui.game.factions.${value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())}`;

function OrganizationPicker({
  chatId,
  value,
  onChange,
  label,
}: {
  chatId: string;
  value: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const result = useCampaignLeafEntities(chatId, "factionWeb", { kind: "organization", query, offset, limit: 20 });
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-semibold">{label}</legend>
      <EditorField
        label={t(key("search"))}
        value={query}
        onChange={(text) => {
          setQuery(text);
          setOffset(0);
        }}
        multiline={false}
      />
      {result.isLoading && <p role="status">{t(key("loading"))}</p>}
      {result.isError && (
        <button type="button" className={editorButton.secondary} onClick={() => void result.refetch()}>
          {t(key("retry"))}
        </button>
      )}
      <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
        {result.data?.items.map((entity) => (
          <button
            type="button"
            key={entity.entityId}
            aria-pressed={value === entity.entityId}
            className={`${editorButton.secondary} max-w-full break-words ${value === entity.entityId ? "ring-2 ring-primary" : ""}`}
            onClick={() => onChange(entity.entityId)}
          >
            {name(entity)}
          </button>
        ))}
      </div>
      {result.data?.total === 0 && <p className="text-sm text-muted-foreground">{t(key("empty"))}</p>}
      {result.data && result.data.total > 20 && (
        <Pager offset={offset} limit={20} total={result.data.total} onChange={setOffset} />
      )}
    </fieldset>
  );
}

function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        className={editorButton.secondary}
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        {t(key("previous"))}
      </button>
      <span>{t(key("page"), { start: total ? offset + 1 : 0, end: Math.min(offset + limit, total), total })}</span>
      <button
        type="button"
        className={editorButton.secondary}
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        {t(key("next"))}
      </button>
    </div>
  );
}

function RelationshipEditor({
  chatId,
  sourceId,
  relation,
  onClose,
  onDirtyChange,
  onSaved,
}: {
  chatId: string;
  sourceId: string;
  relation: CampaignMemoryRelationship | null;
  onClose: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState(relation?.targetEntityId ?? "");
  const [type, setType] = useState(relation?.type ?? "allied-with");
  const [status, setStatus] = useState<CampaignMemoryRelationshipStatus>(relation?.status ?? "proposed");
  const [notes, setNotes] = useState(relation?.notes ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState(false);
  const writeChatId = relation ? recordWriteChatId(relation, chatId) : chatId;
  const mutation = useCampaignLeafMutation(writeChatId, "factionWeb");
  const dirty =
    target !== (relation?.targetEntityId ?? "") ||
    type !== (relation?.type ?? "allied-with") ||
    status !== (relation?.status ?? "proposed") ||
    notes !== (relation?.notes ?? "") ||
    reason !== "";
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const save = async () => {
    setError(false);
    const fields = {
      type,
      inverseLabel: INVERSE[type as keyof typeof INVERSE] ?? relation?.inverseLabel ?? type,
      status,
      notes,
      manualLock: true,
    };
    try {
      await mutation.mutateAsync(
        relation
          ? {
              action: "update",
              recordType: "relationship",
              recordId: relation.relationshipId,
              expectedRevision: relation.revision,
              operationId: crypto.randomUUID(),
              reason,
              patch: fields,
            }
          : {
              action: "create",
              recordType: "relationship",
              operationId: crypto.randomUUID(),
              reason,
              input: { ...fields, sourceEntityId: sourceId, targetEntityId: target, evidence: [], manualLock: true },
            },
      );
      onDirtyChange(false);
      onSaved();
      onClose();
    } catch {
      setError(true);
    }
  };
  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="text-lg font-semibold">{t(key(relation ? "edit" : "add"))}</h3>
      <p className="text-sm text-muted-foreground">{t(key("authoringHint"))}</p>
      {!relation && <OrganizationPicker chatId={chatId} value={target} onChange={setTarget} label={t(key("target"))} />}
      <EditorSelect label={t(key("type"))} value={type} onChange={setType} disabled={mutation.isPending}>
        {!TYPES.includes(type as (typeof TYPES)[number]) && <option value={type}>{type}</option>}
        {TYPES.map((value) => (
          <option key={value} value={value}>
            {t(key(value))}
          </option>
        ))}
      </EditorSelect>
      <EditorSelect
        label={t(key("status"))}
        value={status}
        onChange={(value) => setStatus(value as CampaignMemoryRelationshipStatus)}
        disabled={mutation.isPending}
      >
        {(["proposed", "active", "held", "ended"] as const).map((value) => (
          <option value={value} key={value}>
            {t(key(value))}
          </option>
        ))}
      </EditorSelect>
      <EditorField
        label={t(key("notes"))}
        value={notes}
        onChange={setNotes}
        maxLength={20000}
        rows={3}
        disabled={mutation.isPending}
      />
      <EditorField
        label={t(key("reason"))}
        value={reason}
        onChange={setReason}
        maxLength={2000}
        required
        disabled={mutation.isPending}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(key("saveError"))}
        </p>
      )}
      <div className="flex gap-2">
        <button
          className={editorButton.primary}
          type="submit"
          disabled={mutation.isPending || !reason.trim() || !target || (!relation && sourceId === target)}
        >
          {t(key("save"))}
        </button>
        <button
          className={editorButton.secondary}
          type="button"
          disabled={mutation.isPending}
          onClick={() => {
            if (!dirty || window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm"))) onClose();
          }}
        >
          {t(key("cancel"))}
        </button>
      </div>
    </form>
  );
}

function History({ chatId, relation }: { chatId: string; relation: CampaignMemoryRelationship }) {
  const { t } = useTranslation();
  const [offset, setOffset] = useState(0);
  const history = useFactionHistory(recordWriteChatId(relation, chatId), relation.relationshipId, offset);
  return (
    <section className="space-y-2" aria-label={t(key("history"))}>
      {history.isLoading && <p role="status">{t(key("loading"))}</p>}
      {history.isError && (
        <button className={editorButton.secondary} onClick={() => void history.refetch()}>
          {t(key("retry"))}
        </button>
      )}
      {history.data?.items.map((item) => (
        <div key={item.journalId} className="border-b border-border py-2 text-sm">
          <p>
            {new Date(item.createdAt).toLocaleString()} · {item.actor}
          </p>
          <p className="whitespace-pre-wrap break-words">{item.reason}</p>
          <details>
            <summary className="cursor-pointer py-2">{t(key("changes"))}</summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify({ before: item.before, after: item.after }, null, 2)}
            </pre>
          </details>
        </div>
      ))}
      {history.data?.total === 0 && <p>{t(key("noHistory"))}</p>}
      {history.data && history.data.total > 10 && (
        <Pager offset={offset} limit={10} total={history.data.total} onChange={setOffset} />
      )}
    </section>
  );
}

function CampaignFactionWebContent({
  chatId,
  onSelect,
  onDirtyChange,
}: {
  chatId: string;
  onSelect: (id: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const wikiEnabled = useWikiFeatureEnabled("campaignWiki");
  const marker = useId().replace(/:/g, "");
  const container = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(680);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.min(680, entry!.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [focus, setFocus] = useState("");
  const [offset, setOffset] = useState(0);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [editor, setEditor] = useState<CampaignMemoryRelationship | "new" | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const graph = useFactionWeb(chatId, focus, offset, includeEnded);
  const entities = graph.data?.entities ?? [];
  const links = graph.data?.relationships.items ?? [];
  const neighbors = entities.filter((entity) => entity.entityId !== focus);
  const compact = width < 560;
  const nodeWidth = compact ? Math.min(230, width - 90) : 190;
  const height = compact ? Math.max(160, neighbors.length * 80 + 110) : Math.max(220, neighbors.length * 76 + 40);
  const positions = new Map(
    entities.map((entity) => [
      entity.entityId,
      entity.entityId === focus
        ? { x: compact ? width / 2 + 15 : 115, y: compact ? 45 : height / 2 }
        : {
            x: compact ? width / 2 + 15 : width - 115,
            y:
              (compact ? 145 : 56) +
              neighbors.findIndex((item) => item.entityId === entity.entityId) * (compact ? 80 : 76),
          },
    ]),
  );
  const names = new Map(entities.map((entity) => [entity.entityId, name(entity)]));
  const focusOn = (id: string) => {
    setFocus(id);
    setOffset(0);
    setHistoryId(null);
  };
  return (
    <section ref={container} className="mx-auto w-full max-w-[60rem] space-y-4 pb-8" data-faction-web>
      <h2 className="text-2xl font-bold">{t(key("title"))}</h2>
      <p className="text-sm text-muted-foreground">{t(key("description"))}</p>
      {!editor && <OrganizationPicker chatId={chatId} value={focus} onChange={focusOn} label={t(key("focus"))} />}
      {focus && !editor && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            disabled={!wikiEnabled}
            className={editorButton.secondary}
            onClick={() => {
              if (wikiEnabled) onSelect(focus);
            }}
          >
            {t(key("open"))}
          </button>
          <button className={editorButton.primary} onClick={() => setEditor("new")}>
            {t(key("add"))}
          </button>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeEnded}
              onChange={(event) => {
                setIncludeEnded(event.target.checked);
                setOffset(0);
              }}
            />
            {t(key("includeEnded"))}
          </label>
        </div>
      )}
      {editor && (
        <RelationshipEditor
          key={editor === "new" ? focus : editor.relationshipId}
          chatId={chatId}
          sourceId={focus}
          relation={editor === "new" ? null : editor}
          onClose={() => setEditor(null)}
          onDirtyChange={onDirtyChange}
          onSaved={() => setOffset(0)}
        />
      )}
      {graph.isLoading && focus && <p role="status">{t(key("loading"))}</p>}
      {graph.isError && (
        <button className={editorButton.secondary} onClick={() => void graph.refetch()}>
          {t(key("retry"))}
        </button>
      )}
      {graph.data && !editor && (
        <>
          <p className="text-xs text-muted-foreground">{t(key("legend"))}</p>
          <div
            className="overflow-x-auto rounded-lg border border-border bg-secondary/20"
            tabIndex={0}
            role="region"
            aria-label={t(key("graph"))}
          >
            <svg width={width} height={height} className="mx-auto block" aria-label={t(key("graph"))}>
              <defs>
                <marker
                  id={marker}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {links.map((link, index) => {
                const from = positions.get(link.sourceEntityId)!;
                const to = positions.get(link.targetEntityId)!;
                const bend = ((index % 3) - 1) * 18;
                return (
                  <path
                    key={link.relationshipId}
                    d={
                      compact
                        ? `M ${from.x - nodeWidth / 2} ${from.y} Q ${10 + index * 4} ${(from.y + to.y) / 2} ${to.x - nodeWidth / 2 - 5} ${to.y}`
                        : `M ${from.x + (from.x < to.x ? nodeWidth / 2 : -nodeWidth / 2)} ${from.y} Q ${width / 2} ${(from.y + to.y) / 2 + bend} ${to.x + (from.x < to.x ? -nodeWidth / 2 - 5 : nodeWidth / 2 + 5)} ${to.y}`
                    }
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeDasharray={link.status === "active" ? undefined : "6 5"}
                    markerEnd={`url(#${marker})`}
                    className="text-primary"
                  >
                    <title>
                      {t(key("edgeDescription"), {
                        source: names.get(link.sourceEntityId),
                        relationship: TYPES.includes(link.type as (typeof TYPES)[number])
                          ? t(key(link.type))
                          : link.type,
                        target: names.get(link.targetEntityId),
                        status: t(key(link.status)),
                      })}
                    </title>
                  </path>
                );
              })}
              {entities.map((entity) => {
                const point = positions.get(entity.entityId)!;
                return (
                  <foreignObject
                    key={entity.entityId}
                    x={point.x - nodeWidth / 2}
                    y={point.y - 25}
                    width={nodeWidth}
                    height="50"
                  >
                    <button
                      type="button"
                      className="h-full w-full truncate rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                      title={name(entity)}
                      aria-pressed={focus === entity.entityId}
                      onClick={() => focusOn(entity.entityId)}
                    >
                      {name(entity)}
                    </button>
                  </foreignObject>
                );
              })}
            </svg>
          </div>
          {links.length === 0 && <p className="text-sm text-muted-foreground">{t(key("noLinks"))}</p>}
          <ul className="divide-y divide-border">
            {links.map((link) => (
              <li key={link.relationshipId} className="space-y-2 py-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <button
                    className="min-h-10 break-words text-primary underline"
                    disabled={!wikiEnabled}
                    onClick={() => {
                      if (wikiEnabled) onSelect(link.sourceEntityId);
                    }}
                  >
                    {names.get(link.sourceEntityId)}
                  </button>
                  <span>→ {TYPES.includes(link.type as (typeof TYPES)[number]) ? t(key(link.type)) : link.type} →</span>
                  <button
                    className="min-h-10 break-words text-primary underline"
                    disabled={!wikiEnabled}
                    onClick={() => {
                      if (wikiEnabled) onSelect(link.targetEntityId);
                    }}
                  >
                    {names.get(link.targetEntityId)}
                  </button>
                  <WikiChip>{t(key(link.status))}</WikiChip>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(key(link.provenance.actor === "user" ? "userAuthored" : "recorded"))} ·{" "}
                  {t(key("evidence"), { count: link.evidence.length })}
                </p>
                {link.notes && (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    <strong>{t(key("notes"))}: </strong>
                    {link.notes}
                  </p>
                )}
                <div className="flex gap-2">
                  <button className={editorButton.secondary} onClick={() => setEditor(link)}>
                    {t(key("edit"))}
                  </button>
                  <button
                    className={editorButton.secondary}
                    aria-expanded={historyId === link.relationshipId}
                    onClick={() => setHistoryId(historyId === link.relationshipId ? null : link.relationshipId)}
                  >
                    {t(key("history"))}
                  </button>
                </div>
                {historyId === link.relationshipId && (
                  <History key={link.relationshipId} chatId={chatId} relation={link} />
                )}
              </li>
            ))}
          </ul>
          {graph.data.relationships.total > 8 && (
            <Pager offset={offset} limit={8} total={graph.data.relationships.total} onChange={setOffset} />
          )}
        </>
      )}
    </section>
  );
}
