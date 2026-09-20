import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, RotateCcw, RotateCw, X } from "lucide-react";
import type {
  CampaignMemoryAuthoringRequest,
  CampaignMemoryAuthoringPreview,
  CampaignMemoryEntityDetail,
  CampaignMemoryFact,
  CampaignMemoryJson,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ApiError, api } from "../../lib/api-client";
import {
  useApplyCampaignMemoryMutation,
  useCampaignMemoryAudit,
  useCompensateCampaignMemoryMutation,
  usePreviewCampaignMemoryMutation,
} from "../../hooks/use-campaign-memory";
import { CampaignWikiCreateRecord } from "./CampaignWikiCreateRecord";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";

/** Wiki read contract item 5: records that depend on a fact. */
interface CampaignMemoryFactDependents {
  knowledge: { knowledgeId: string; holder: { entityId: string; alias: string }; epistemicState: string }[];
  states: { entityId: string; key: string; causeEventId: string }[];
  events: { eventId: string; summary: string }[];
}

/** Wiki read contract item 6: reference counts for an entity. */
interface CampaignMemoryEntityReferences {
  facts: number;
  knowledge: number;
  events: number;
  relationships: number;
  states: number;
  samples: Partial<Record<"facts" | "knowledge" | "events" | "relationships" | "states", string[]>>;
}

const REFERENCE_KEYS = ["facts", "knowledge", "events", "relationships", "states"] as const;

type ValueType = "string" | "number" | "boolean" | "json";

function operationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `campaign-memory-${Date.now()}`;
}

function valueText(value: CampaignMemoryJson) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function conditionsText(conditions: CampaignMemoryFact["conditions"]) {
  return conditions.map((item) => `${item.kind}=${valueText(item.value)}`).join("\n");
}

function parseConditions(value: string, original: CampaignMemoryFact["conditions"]) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 0
        ? { kind: line, value: true }
        : {
            kind: line.slice(0, separator).trim(),
            value: parseTyped(
              line.slice(separator + 1).trim(),
              original.find((item) => item.kind === line.slice(0, separator).trim())?.value,
            ),
          };
    });
}

function parseTyped(value: string, original?: CampaignMemoryJson): CampaignMemoryJson {
  if (original !== undefined) {
    const type = valueKind(original);
    if (type === "string") return value;
    if (type === "number") return Number(value);
    if (type === "boolean") return value === "true";
    try {
      return JSON.parse(value) as CampaignMemoryJson;
    } catch {
      return value;
    }
  }
  // New condition lines are intentionally strings until the user chooses a typed field value.
  return value;
}

function valueKind(value: CampaignMemoryJson): ValueType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value !== null && typeof value === "object") return "json";
  return "string";
}

/** Returns `undefined` when the text is not a valid value of the chosen type. */
function parseValue(text: string, type: ValueType): CampaignMemoryJson | undefined {
  if (type === "number") {
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (type === "boolean") return text === "true" ? true : text === "false" ? false : undefined;
  if (type === "json") {
    try {
      return JSON.parse(text) as CampaignMemoryJson;
    } catch {
      return undefined;
    }
  }
  return text;
}

function displayPreviewValue(value: unknown) {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function CampaignWikiEditor({
  chatId,
  detail,
  onClose,
  onReload,
  onDirtyChange,
}: {
  chatId: string;
  detail: CampaignMemoryEntityDetail;
  onClose: () => void;
  onReload: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useUiTranslation();
  const { entity, facts } = detail;
  const [tab, setTab] = useState<"entity" | "fact" | "correction">("entity");
  const [aliases, setAliases] = useState(entity.aliases.join("\n"));
  const [tags, setTags] = useState(entity.tags.join(", "));
  const [summary, setSummary] = useState(entity.summary ?? "");
  // Prose notes. Read through a local widening until the shared dist is rebuilt with `body`.
  const entityBody = (entity as { body?: string }).body ?? "";
  const [body, setBody] = useState(entityBody);
  const [manualLock, setManualLock] = useState(entity.manualLock);
  const [archived, setArchived] = useState(entity.status === "archived");
  const [factId, setFactId] = useState(facts.items[0]?.factId ?? "");
  const fact = useMemo(
    () => facts.items.find((item) => item.factId === factId) ?? facts.items[0],
    [factId, facts.items],
  );
  const [predicate, setPredicate] = useState(fact?.predicate ?? "");
  const [factValue, setFactValue] = useState(fact ? valueText(fact.value) : "");
  const [valueType, setValueType] = useState<ValueType>(fact ? valueKind(fact.value) : "string");
  const [conditions, setConditions] = useState(fact ? conditionsText(fact.conditions) : "");
  const [factStatus, setFactStatus] = useState<CampaignMemoryFact["status"]>(fact?.status ?? "proposed");
  const [factLock, setFactLock] = useState(fact?.manualLock ?? false);
  // Correction drawer draft: a superseding fact, kept separate from the in-place fact edit.
  const [correctionPredicate, setCorrectionPredicate] = useState(fact?.predicate ?? "");
  const [correctionValue, setCorrectionValue] = useState(fact ? valueText(fact.value) : "");
  const [correctionType, setCorrectionType] = useState<ValueType>(fact ? valueKind(fact.value) : "string");
  const [correctionConditions, setCorrectionConditions] = useState(fact ? conditionsText(fact.conditions) : "");
  const [correctionValidFrom, setCorrectionValidFrom] = useState("");
  const [correctionStatus, setCorrectionStatus] = useState<CampaignMemoryFact["status"]>("verified");
  const [correctionLock, setCorrectionLock] = useState(true);
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState<CampaignMemoryAuthoringRequest | null>(null);
  const [preview, setPreview] = useState<CampaignMemoryAuthoringPreview | null>(null);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [validationError, setValidationError] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [applyError, setApplyError] = useState(false);
  const [undoError, setUndoError] = useState(false);
  const [creating, setCreating] = useState(false);
  const draftVersion = useRef(0);
  const mounted = useRef(true);
  const undoOperationIds = useRef(new Map<string, string>());
  const previewMutation = usePreviewCampaignMemoryMutation(chatId);
  const applyMutation = useApplyCampaignMemoryMutation(chatId);
  const compensateMutation = useCompensateCampaignMemoryMutation(chatId);
  const audit = useCampaignMemoryAudit(chatId);
  const archiving = archived && entity.status !== "archived";
  const references = useQuery({
    queryKey: ["campaign-memory", "references", chatId, entity.entityId],
    queryFn: () =>
      api.get<CampaignMemoryEntityReferences>(`/game/${chatId}/memory/entities/${entity.entityId}/references`),
    enabled: archiving,
    staleTime: 0,
  });
  const dependents = useQuery({
    queryKey: ["campaign-memory", "dependents", chatId, fact?.factId ?? ""],
    queryFn: () => api.get<CampaignMemoryFactDependents>(`/game/${chatId}/memory/facts/${fact?.factId}/dependents`),
    enabled: tab === "correction" && Boolean(fact),
    staleTime: 0,
  });

  useEffect(() => {
    if (!fact || dirty) return;
    setPredicate(fact.predicate);
    setFactValue(valueText(fact.value));
    setValueType(valueKind(fact.value));
    setConditions(conditionsText(fact.conditions));
    setFactStatus(fact.status);
    setFactLock(fact.manualLock);
    setCorrectionPredicate(fact.predicate);
    setCorrectionValue(valueText(fact.value));
    setCorrectionType(valueKind(fact.value));
    setCorrectionConditions(conditionsText(fact.conditions));
  }, [dirty, fact]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [dirty]);

  const invalidatePreview = () => {
    draftVersion.current += 1;
    setRequest(null);
    setPreview(null);
    setConflict(false);
    setPreviewError(false);
    setApplyError(false);
  };

  const updateDirty = () => {
    invalidatePreview();
    setDirty(true);
  };

  const mark = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    updateDirty();
  };
  const switchTab = (next: typeof tab) => {
    if (tab !== next) invalidatePreview();
    setTab(next);
  };
  const buildRequest = (): CampaignMemoryAuthoringRequest | null => {
    const id = operationId();
    if (tab === "entity") {
      return {
        operationId: id,
        action: "update",
        recordType: "entity",
        recordId: entity.entityId,
        expectedRevision: entity.revision,
        reason,
        patch: {
          ...(aliases
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean)
            .join("\n") !== entity.aliases.join("\n")
            ? {
                aliases: aliases
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(tags
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
            .join(",") !== entity.tags.join(",")
            ? {
                tags: tags
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              }
            : {}),
          ...(summary !== (entity.summary ?? "") ? { summary } : {}),
          ...(body !== entityBody ? { body } : {}),
          ...(manualLock !== entity.manualLock ? { manualLock } : {}),
          ...(archived !== (entity.status === "archived") ? { status: archived ? "archived" : "active" } : {}),
        },
      };
    }
    if (!fact) return null;
    if (tab === "fact") {
      const typedValue = parseValue(factValue, valueType);
      if (typedValue === undefined) {
        setValidationError(true);
        return null;
      }
      return {
        operationId: id,
        action: "update",
        recordType: "fact",
        recordId: fact.factId,
        expectedRevision: fact.revision,
        reason,
        patch: {
          ...(predicate !== fact.predicate ? { predicate } : {}),
          ...(factValue !== valueText(fact.value) || valueType !== valueKind(fact.value) ? { value: typedValue } : {}),
          ...(conditions !== conditionsText(fact.conditions)
            ? { conditions: parseConditions(conditions, fact.conditions) }
            : {}),
          ...(factStatus !== fact.status ? { status: factStatus } : {}),
          ...(factLock !== fact.manualLock ? { manualLock: factLock } : {}),
        },
      };
    }
    const correctedValue = parseValue(correctionValue, correctionType);
    if (correctedValue === undefined || !correctionPredicate.trim()) {
      setValidationError(true);
      return null;
    }
    // A correction is a new superseding fact; the original row is retained unchanged as the previous version.
    return {
      operationId: id,
      action: "create",
      recordType: "fact",
      reason,
      input: {
        subjectEntityId: entity.entityId,
        predicate: correctionPredicate.trim(),
        value: correctedValue,
        conditions: parseConditions(correctionConditions, fact.conditions),
        status: correctionStatus,
        ...(correctionValidFrom.trim() ? { validFromOrder: correctionValidFrom.trim() } : {}),
        evidence: [],
        supersedesFactId: fact.factId,
        manualLock: correctionLock,
      },
    };
  };
  const startRequest = () => {
    if (!reason.trim()) return;
    setValidationError(false);
    const next = buildRequest();
    if (!next) return;
    const requestVersion = draftVersion.current;
    setRequest(next);
    setConflict(false);
    setPreviewError(false);
    void previewMutation
      .mutateAsync(next)
      .then((result) => {
        if (mounted.current && requestVersion === draftVersion.current) setPreview(result);
      })
      .catch(() => {
        if (mounted.current && requestVersion === draftVersion.current) {
          setPreview(null);
          setPreviewError(true);
        }
      });
  };
  const apply = () => {
    if (!request) return;
    setApplyError(false);
    void applyMutation
      .mutateAsync(request)
      .then(() => {
        setDirty(false);
        setPreview(null);
        setRequest(null);
        onReload();
      })
      .catch((error) => {
        setConflict(error instanceof ApiError && error.status === 409);
        setApplyError(true);
      });
  };
  const close = () => {
    if (dirty && !window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm"))) return;
    onClose();
  };
  const busy = previewMutation.isPending || applyMutation.isPending || compensateMutation.isPending;
  const previewBlocked = !reason.trim() || busy || (archiving && !references.data);
  if (creating) {
    return (
      <CampaignWikiCreateRecord
        chatId={chatId}
        detail={detail}
        onCancel={() => {
          setCreating(false);
          onDirtyChange(false);
        }}
        onApplied={() => {
          setCreating(false);
          onDirtyChange(false);
          onReload();
        }}
        onDirtyChange={onDirtyChange}
      />
    );
  }
  const factSelect = fact && (
    <label className="block text-sm">
      {t("ui.game.campaignWiki.editor.factToEdit")}
      <select
        value={fact.factId}
        onChange={(event) => {
          if (dirty && !window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm"))) return;
          setDirty(false);
          invalidatePreview();
          setFactId(event.target.value);
        }}
        disabled={busy}
        className="mt-1 min-h-10 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2"
      >
        <option value="">{t("ui.game.campaignWiki.editor.chooseFact")}</option>
        {facts.items.map((item) => (
          <option key={item.factId} value={item.factId}>
            {item.predicate}
          </option>
        ))}
      </select>
    </label>
  );
  const typeSelect = (value: ValueType, onChange: (next: ValueType) => void) => (
    <label className="block text-sm">
      {t("ui.game.campaignWiki.editor.valueType")}
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value as ValueType);
          updateDirty();
        }}
        disabled={busy}
        className="mt-1 min-h-10 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2"
      >
        {["string", "number", "boolean", "json"].map((type) => (
          <option key={type} value={type}>
            {t(`ui.game.campaignWiki.editor.valueType.${type}`, { defaultValue: type })}
          </option>
        ))}
      </select>
    </label>
  );
  const statusSelect = (
    label: string,
    value: CampaignMemoryFact["status"],
    onChange: (next: CampaignMemoryFact["status"]) => void,
  ) => (
    <label className="block text-sm">
      {label}
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value as CampaignMemoryFact["status"]);
          updateDirty();
        }}
        disabled={busy}
        className="mt-1 min-h-10 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2"
      >
        {["proposed", "verified", "superseded", "held", "retracted"].map((status) => (
          <option key={status} value={status}>
            {t(`ui.game.campaignWiki.editor.status.${status}`, { defaultValue: status })}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div
      className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4"
      aria-label={t("ui.game.campaignWiki.editor.title")}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{t("ui.game.campaignWiki.editor.title")}</h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (dirty && !window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm"))) return;
              invalidatePreview();
              setCreating(true);
              setDirty(false);
            }}
            disabled={busy}
            className="min-h-10 rounded-md border border-[var(--primary)] px-3 text-sm"
          >
            {t("ui.game.campaignWiki.create.open", { defaultValue: "Add record" })}
          </button>
          <button
            type="button"
            onClick={close}
            className="min-h-10 rounded-md p-2 text-[var(--muted-foreground)] hover:bg-[var(--secondary)]"
            aria-label={t("ui.game.campaignWiki.editor.close")}
          >
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {(["entity", "fact", "correction"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => switchTab(item)}
            disabled={busy}
            aria-pressed={tab === item}
            className="min-h-10 rounded-md px-3 text-xs"
          >
            {t(`ui.game.campaignWiki.editor.${item}`)}
          </button>
        ))}
      </div>
      {tab === "entity" && (
        <div className="space-y-3">
          <Field
            label={t("ui.game.campaignWiki.editor.aliases")}
            value={aliases}
            onChange={mark(setAliases)}
            disabled={busy}
          />
          <Field label={t("ui.game.campaignWiki.editor.tags")} value={tags} onChange={mark(setTags)} disabled={busy} />
          <Field
            label={t("ui.game.campaignWiki.editor.summary")}
            value={summary}
            onChange={mark(setSummary)}
            disabled={busy}
          />
          <label className="block text-sm">
            {t("ui.game.campaignWiki.editor.notes")}
            <textarea
              value={body}
              disabled={busy}
              maxLength={20000}
              onChange={(event) => mark(setBody)(event.target.value)}
              className="mt-1 min-h-32 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-2 font-mono text-sm"
            />
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={manualLock}
              disabled={busy}
              onChange={(event) => {
                setManualLock(event.target.checked);
                updateDirty();
              }}
            />
            {t("ui.game.campaignWiki.editor.manualLock")}
          </label>
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={archived}
              disabled={busy}
              onChange={(event) => {
                setArchived(event.target.checked);
                updateDirty();
              }}
            />
            {t("ui.game.campaignWiki.editor.archive")}
          </label>
          {archiving && (
            <section
              aria-label={t("ui.game.campaignWiki.editor.archiveReferences")}
              className="space-y-2 rounded-md border border-[var(--border)] p-3 text-xs"
            >
              <p className="font-medium">{t("ui.game.campaignWiki.editor.archiveReferences")}</p>
              {references.isLoading && (
                <p className="inline-flex items-center gap-1 text-[var(--muted-foreground)]">
                  <Loader2 size={12} className="animate-spin" />
                  {t("ui.game.campaignWiki.editor.referencesLoading")}
                </p>
              )}
              {references.isError && (
                <div className="space-y-1 text-[var(--destructive)]">
                  <p>{t("ui.game.campaignWiki.editor.referencesError")}</p>
                  <button
                    type="button"
                    onClick={() => void references.refetch()}
                    className="inline-flex min-h-8 items-center gap-1 rounded border border-[var(--border)] px-2 text-[var(--muted-foreground)]"
                  >
                    <RotateCw size={11} />
                    {t("ui.game.campaignWiki.retry")}
                  </button>
                </div>
              )}
              {references.data && (
                <ul className="space-y-1">
                  {REFERENCE_KEYS.map((key) => (
                    <li key={key} className="flex flex-wrap gap-x-2">
                      <span className="font-medium">
                        {t(`ui.game.campaignWiki.editor.referenceCount.${key}`, { defaultValue: key })}:{" "}
                        {references.data[key]}
                      </span>
                      {(references.data.samples[key] ?? []).length > 0 && (
                        <span className="break-all text-[var(--muted-foreground)]">
                          {(references.data.samples[key] ?? []).join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.editor.referencesPreserved")}</p>
            </section>
          )}
        </div>
      )}
      {tab === "fact" && (
        <div className="space-y-3">
          {fact ? (
            <>
              {factSelect}
              <Field
                label={t("ui.game.campaignWiki.editor.predicate")}
                value={predicate}
                onChange={mark(setPredicate)}
                disabled={busy}
              />
              <Field
                label={t("ui.game.campaignWiki.editor.value")}
                value={factValue}
                onChange={mark(setFactValue)}
                disabled={busy}
              />
              {typeSelect(valueType, setValueType)}
              <Field
                label={t("ui.game.campaignWiki.editor.conditionsHelp")}
                value={conditions}
                onChange={mark(setConditions)}
                disabled={busy}
              />
              {statusSelect(t("ui.game.campaignWiki.editor.status"), factStatus, setFactStatus)}
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={factLock}
                  disabled={busy}
                  onChange={(event) => {
                    setFactLock(event.target.checked);
                    updateDirty();
                  }}
                />
                {t("ui.game.campaignWiki.editor.manualLock")}
              </label>
            </>
          ) : (
            <p className="text-sm text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.editor.noFacts")}</p>
          )}
        </div>
      )}
      {tab === "correction" && (
        <section aria-label={t("ui.game.campaignWiki.editor.correctionTitle")} className="space-y-3">
          {fact ? (
            <>
              {factSelect}
              <div className="rounded-md border border-[var(--border)] p-3 text-xs">
                <p className="font-medium">{t("ui.game.campaignWiki.editor.originalClaim")}</p>
                <p className="mt-1 break-words">
                  {fact.predicate}: {valueText(fact.value)}
                </p>
                <p className="text-[var(--muted-foreground)]">
                  {t("ui.game.campaignWiki.status", {
                    status: t(`ui.game.campaignWiki.factStatus.${fact.status}`, { defaultValue: fact.status }),
                  })}
                  {fact.conditions.length > 0 && ` · ${conditionsText(fact.conditions).replaceAll("\n", "; ")}`}
                </p>
                <CampaignWikiEvidence chatId={chatId} evidence={fact.evidence} />
              </div>
              <p className="text-sm font-medium">{t("ui.game.campaignWiki.editor.proposedCorrection")}</p>
              <Field
                label={t("ui.game.campaignWiki.editor.predicate")}
                value={correctionPredicate}
                onChange={mark(setCorrectionPredicate)}
                disabled={busy}
              />
              <Field
                label={t("ui.game.campaignWiki.editor.value")}
                value={correctionValue}
                onChange={mark(setCorrectionValue)}
                disabled={busy}
              />
              {typeSelect(correctionType, setCorrectionType)}
              <p className="text-sm font-medium">{t("ui.game.campaignWiki.editor.correctionScope")}</p>
              <Field
                label={t("ui.game.campaignWiki.editor.conditionsHelp")}
                value={correctionConditions}
                onChange={mark(setCorrectionConditions)}
                disabled={busy}
              />
              <Field
                label={t("ui.game.campaignWiki.editor.correctionValidFrom")}
                value={correctionValidFrom}
                onChange={mark(setCorrectionValidFrom)}
                disabled={busy}
              />
              {statusSelect(t("ui.game.campaignWiki.editor.correctionStatus"), correctionStatus, setCorrectionStatus)}
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={correctionLock}
                  disabled={busy}
                  onChange={(event) => {
                    setCorrectionLock(event.target.checked);
                    updateDirty();
                  }}
                />
                {t("ui.game.campaignWiki.editor.protectRecord")}
              </label>
              <p className="text-xs text-[var(--muted-foreground)]">
                {t("ui.game.campaignWiki.editor.correctionRetains")}
              </p>
              <div className="space-y-2 rounded-md border border-[var(--border)] p-3 text-xs">
                <p className="font-medium">{t("ui.game.campaignWiki.editor.downstreamImpact")}</p>
                {dependents.isLoading && (
                  <p className="inline-flex items-center gap-1 text-[var(--muted-foreground)]">
                    <Loader2 size={12} className="animate-spin" />
                    {t("ui.game.campaignWiki.editor.impactLoading")}
                  </p>
                )}
                {dependents.isError && (
                  <div className="space-y-1 text-[var(--destructive)]">
                    <p>{t("ui.game.campaignWiki.editor.impactError")}</p>
                    <button
                      type="button"
                      onClick={() => void dependents.refetch()}
                      className="inline-flex min-h-8 items-center gap-1 rounded border border-[var(--border)] px-2 text-[var(--muted-foreground)]"
                    >
                      <RotateCw size={11} />
                      {t("ui.game.campaignWiki.retry")}
                    </button>
                  </div>
                )}
                {dependents.data &&
                  (dependents.data.knowledge.length + dependents.data.states.length + dependents.data.events.length ===
                  0 ? (
                    <p className="text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.editor.impactNone")}</p>
                  ) : (
                    <>
                      {dependents.data.knowledge.length > 0 && (
                        <div>
                          <p className="font-medium">
                            {t("ui.game.campaignWiki.editor.impactKnowledge", {
                              count: dependents.data.knowledge.length,
                            })}
                          </p>
                          <ul className="list-disc pl-4">
                            {dependents.data.knowledge.map((item) => (
                              <li key={item.knowledgeId} className="break-words">
                                {item.holder.alias || item.holder.entityId} ·{" "}
                                {t(`ui.game.campaignWiki.epistemicState.${item.epistemicState}`, {
                                  defaultValue: item.epistemicState,
                                })}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {dependents.data.states.length > 0 && (
                        <div>
                          <p className="font-medium">
                            {t("ui.game.campaignWiki.editor.impactStates", { count: dependents.data.states.length })}
                          </p>
                          <ul className="list-disc pl-4">
                            {dependents.data.states.map((item) => (
                              <li key={`${item.entityId}-${item.key}-${item.causeEventId}`} className="break-words">
                                {item.entityId} · {item.key}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {dependents.data.events.length > 0 && (
                        <div>
                          <p className="font-medium">
                            {t("ui.game.campaignWiki.editor.impactEvents", { count: dependents.data.events.length })}
                          </p>
                          <ul className="list-disc pl-4">
                            {dependents.data.events.map((item) => (
                              <li key={item.eventId} className="break-words">
                                {item.summary || item.eventId}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p className="text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.editor.impactRecheck")}</p>
                    </>
                  ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.editor.noFacts")}</p>
          )}
        </section>
      )}
      <Field
        label={t("ui.game.campaignWiki.editor.reason")}
        value={reason}
        onChange={mark(setReason)}
        disabled={busy}
      />
      {validationError && (
        <p className="text-sm text-[var(--destructive)]">{t("ui.game.campaignWiki.editor.invalidValue")}</p>
      )}
      {previewError && (
        <p className="text-sm text-[var(--destructive)]">{t("ui.game.campaignWiki.editor.previewError")}</p>
      )}
      {applyError && <p className="text-sm text-[var(--destructive)]">{t("ui.game.campaignWiki.editor.applyError")}</p>}
      {conflict && (
        <div className="flex items-center gap-2 rounded-md border border-[var(--destructive)] p-3 text-sm text-[var(--destructive)]">
          <AlertTriangle size={15} />
          {t("ui.game.campaignWiki.editor.conflict")}
          <button type="button" onClick={onReload} className="ml-auto underline">
            {t("ui.game.campaignWiki.editor.reload")}
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={startRequest}
          disabled={previewBlocked}
          className="min-h-10 rounded-md bg-[var(--primary)] px-3 text-sm text-[var(--primary-foreground)]"
        >
          {previewMutation.isPending
            ? t("ui.game.campaignWiki.editor.previewing")
            : t("ui.game.campaignWiki.editor.preview")}
        </button>
        {preview && (
          <button
            type="button"
            onClick={apply}
            disabled={busy}
            className="inline-flex min-h-10 items-center gap-1 rounded-md border border-[var(--primary)] px-3 text-sm"
          >
            {applyMutation.isPending ? (
              t("ui.game.campaignWiki.editor.saving")
            ) : (
              <>
                <Check size={14} />
                {t("ui.game.campaignWiki.editor.apply")}
              </>
            )}
          </button>
        )}
      </div>
      {preview && (
        <div className="space-y-2 rounded-md border border-[var(--border)] p-3 text-xs">
          <p className="font-medium">{t("ui.game.campaignWiki.editor.changedFields")}</p>
          {Object.keys(preview.diff).length > 0 ? (
            <ul className="space-y-1">
              {Object.keys(preview.diff).map((field) => {
                const before = (preview.before as Record<string, unknown> | undefined)?.[field];
                const after = (preview.after as Record<string, unknown> | undefined)?.[field] ?? preview.diff[field];
                return (
                  <li key={field} className="grid gap-1 sm:grid-cols-[minmax(7rem,auto)_1fr]">
                    <span className="font-medium">
                      {t(`ui.game.campaignWiki.editor.field.${field}`, { defaultValue: field })}
                    </span>
                    <span className="break-words">
                      <span className="text-[var(--destructive)]">{displayPreviewValue(before)}</span>
                      <span className="px-1 text-[var(--muted-foreground)]">→</span>
                      <span className="text-[var(--primary)]">{displayPreviewValue(after)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.editor.noChangedFields")}</p>
          )}
        </div>
      )}
      {undoError && <p className="text-sm text-[var(--destructive)]">{t("ui.game.campaignWiki.editor.undoError")}</p>}
      {audit.data?.items
        .filter(
          (entry) =>
            (entry.recordType === "entity" && entry.recordId === entity.entityId) ||
            (entry.recordType === "fact" && facts.items.some((item) => item.factId === entry.recordId)),
        )
        .filter((entry) => entry.before !== undefined && entry.after !== undefined)
        .slice(0, 5)
        .map((entry) => (
          <div
            key={entry.journalId}
            className="flex items-center justify-between gap-2 border-t border-[var(--border)] pt-2 text-xs"
          >
            <span>
              {entry.recordType} · {entry.reason}
            </span>
            <button
              type="button"
              onClick={() => {
                setUndoError(false);
                const undoId = undoOperationIds.current.get(entry.operationId) ?? operationId();
                undoOperationIds.current.set(entry.operationId, undoId);
                void compensateMutation
                  .mutateAsync({
                    operationId: undoId,
                    originalOperationId: entry.operationId,
                    reason: t("ui.game.campaignWiki.editor.undoReason"),
                  })
                  .then(onReload)
                  .catch(() => setUndoError(true));
              }}
              disabled={busy}
              className="inline-flex min-h-9 items-center gap-1 text-[var(--muted-foreground)]"
            >
              <RotateCcw size={13} />
              {t("ui.game.campaignWiki.editor.undo")}
            </button>
          </div>
        ))}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="block text-sm">
      {label}
      <textarea
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 min-h-10 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-2 text-sm"
      />
    </label>
  );
}
