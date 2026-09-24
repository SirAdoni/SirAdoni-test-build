import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  Check,
  ChevronDown,
  FileText,
  History,
  Loader2,
  Lock,
  PencilLine,
  Plus,
  RotateCcw,
  RotateCw,
  Tags,
  Wrench,
  X,
} from "lucide-react";
import type {
  CampaignMemoryAuthoringRequest,
  CampaignMemoryAuthoringPreview,
  CampaignMemoryEntityDetail,
  CampaignMemoryFact,
  CampaignMemoryJson,
  CampaignMemoryMutationJournal,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { cn } from "../../lib/utils";
import {
  useApplyCampaignMemoryMutation,
  useCampaignMemoryAudit,
  useCompensateCampaignMemoryMutation,
  usePreviewCampaignMemoryMutation,
} from "../../hooks/use-campaign-memory";
import {
  CampaignWikiCreateRecord,
  ChangeReview,
  EditorAlert,
  EditorField,
  EditorFooter,
  EditorSection,
  EditorSelect,
  EditorStepper,
  EditorToggle,
  editorButton,
} from "./CampaignWikiCreateRecord";
import { CampaignWikiEvidence } from "./CampaignWikiEvidence";
import {
  EntityAvatar,
  WikiChip,
  crossSessionReferenceDetail,
  crossSessionReferenceText,
  factDisplay,
  humanizeKey,
  isWikiRevisionConflict,
  recordOrigin,
  recordWriteChatId,
} from "./campaign-wiki-ui";
import type { TFn } from "./CampaignWikiReaderParts";

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
const REFERENCE_NAMES: Record<(typeof REFERENCE_KEYS)[number], string> = {
  facts: "Facts",
  knowledge: "Things people know",
  events: "Events",
  relationships: "Connections",
  states: "Current details",
};

type ValueType = "string" | "number" | "boolean" | "json";
export type EditorTab = "entity" | "fact" | "correction";

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

type ConditionParse =
  | { conditions: CampaignMemoryFact["conditions"]; invalid?: undefined }
  | { conditions?: undefined; invalid: { kind: string; type: ValueType } };

/** Parses `kind=value` lines, keeping each existing condition's type. A value that does not fit that type is reported, never coerced. */
function parseConditions(value: string, original: CampaignMemoryFact["conditions"]): ConditionParse {
  const conditions: CampaignMemoryFact["conditions"] = [];
  for (const line of value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator < 0) {
      conditions.push({ kind: line, value: true });
      continue;
    }
    const kind = line.slice(0, separator).trim();
    const previous = original.find((item) => item.kind === kind)?.value;
    const typed = parseTyped(line.slice(separator + 1).trim(), previous);
    if (typed === undefined) return { invalid: { kind, type: valueKind(previous as CampaignMemoryJson) } };
    conditions.push({ kind, value: typed });
  }
  return { conditions };
}

function parseTyped(value: string, original?: CampaignMemoryJson): CampaignMemoryJson | undefined {
  if (original !== undefined) {
    const type = valueKind(original);
    if (type === "string") return value;
    if (type === "number") {
      const parsed = Number(value);
      return value.trim() !== "" && Number.isFinite(parsed) ? parsed : undefined;
    }
    if (type === "boolean") return value === "true" ? true : value === "false" ? false : undefined;
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

function lineList(value: string) {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function tagList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function shorten(value: string, max = 80) {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function firstName(aliases: readonly string[]) {
  return aliases.find((alias) => alias.trim() && !/^cme_[a-f0-9-]+$/iu.test(alias.trim())) ?? "";
}

export function CampaignWikiEditor({
  chatId,
  detail,
  onClose,
  onReload,
  onDirtyChange,
  initialFactId,
  initialTab,
}: {
  chatId: string;
  detail: CampaignMemoryEntityDetail;
  onClose: () => void;
  onReload: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Fact to open on (the reader's "Correct" action); defaults to the first fact of the page. */
  initialFactId?: string;
  initialTab?: EditorTab;
}) {
  const { t, i18n } = useUiTranslation();
  const { entity, facts } = detail;
  const displayName =
    firstName(entity.aliases) ||
    t("ui.game.campaignWiki.editor.untitled", {
      defaultValue: "Untitled {{kind}}",
      kind: t(`ui.game.campaignWiki.kind.${entity.kind}`, { defaultValue: humanizeKey(entity.kind) }).toLowerCase(),
    });
  const [tab, setTab] = useState<EditorTab>(initialTab ?? "entity");
  // The first alias is the page's display name; the rest are other names the story can use.
  const [name, setName] = useState(entity.aliases[0] ?? "");
  const [otherNames, setOtherNames] = useState(entity.aliases.slice(1).join("\n"));
  const [tags, setTags] = useState(entity.tags.join(", "));
  const [summary, setSummary] = useState(entity.summary ?? "");
  // Prose notes. Read through a local widening until the shared dist is rebuilt with `body`.
  const entityBody = (entity as { body?: string }).body ?? "";
  const [body, setBody] = useState(entityBody);
  const [manualLock, setManualLock] = useState(entity.manualLock);
  const [archived, setArchived] = useState(entity.status === "archived");
  const [factId, setFactId] = useState(initialFactId ?? facts.items[0]?.factId ?? "");
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
  // Server reason for CAMPAIGN_MEMORY_CROSS_SESSION_REFERENCE on preview or save; a reload cannot fix it.
  const [crossSession, setCrossSession] = useState<string | null>(null);
  const [undoError, setUndoError] = useState(false);
  const [creating, setCreating] = useState(false);
  const draftVersion = useRef(0);
  const mounted = useRef(true);
  const undoOperationIds = useRef(new Map<string, string>());
  const reviewRef = useRef<HTMLDivElement | null>(null);
  // In campaign scope a page or fact can belong to an earlier session: every write goes to the record's own session.
  const entityWriteChatId = recordWriteChatId(entity, chatId);
  const factWriteChatId = fact ? recordWriteChatId(fact, chatId) : entityWriteChatId;
  const writeChatId = tab === "entity" ? entityWriteChatId : factWriteChatId;
  const previewMutation = usePreviewCampaignMemoryMutation(writeChatId);
  const applyMutation = useApplyCampaignMemoryMutation(writeChatId);
  const compensateEntityMutation = useCompensateCampaignMemoryMutation(entityWriteChatId);
  const compensateFactMutation = useCompensateCampaignMemoryMutation(factWriteChatId);
  const entityAuditData = useCampaignMemoryAudit(entityWriteChatId).data;
  const factAuditData = useCampaignMemoryAudit(factWriteChatId).data;
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

  const entityNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const related of detail.relatedEntities) {
      const relatedName = firstName(related.aliases);
      if (relatedName) names.set(related.entityId, relatedName);
    }
    names.set(entity.entityId, displayName);
    return names;
  }, [detail.relatedEntities, displayName, entity.entityId]);

  // Diffs and expectedRevision use the records the draft was loaded from. A refetch while the draft is dirty
  // then surfaces as a 409 conflict instead of a silent overwrite; a clean draft follows the fresh record.
  const [entityBase, setEntityBase] = useState(entity);
  const [factBase, setFactBase] = useState(fact);
  useEffect(() => {
    if (dirty) return;
    setEntityBase(entity);
    setName(entity.aliases[0] ?? "");
    setOtherNames(entity.aliases.slice(1).join("\n"));
    setTags(entity.tags.join(", "));
    setSummary(entity.summary ?? "");
    setBody((entity as { body?: string }).body ?? "");
    setManualLock(entity.manualLock);
    setArchived(entity.status === "archived");
  }, [dirty, entity]);

  useEffect(() => {
    if (!fact || dirty) return;
    setFactBase(fact);
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

  useEffect(() => {
    if (preview) reviewRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [preview]);

  const invalidatePreview = () => {
    draftVersion.current += 1;
    setRequest(null);
    setPreview(null);
    setConflict(false);
    setPreviewError(false);
    setApplyError(false);
    setCrossSession(null);
  };

  const updateDirty = () => {
    invalidatePreview();
    setDirty(true);
  };

  const mark = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    updateDirty();
  };
  const switchTab = (next: EditorTab) => {
    if (tab !== next) invalidatePreview();
    setValidationError(false);
    setTab(next);
  };
  const aliasList = () => {
    const first = name.trim();
    return [...(first ? [first] : []), ...lineList(otherNames).filter((alias) => alias !== first)];
  };
  const buildRequest = (): CampaignMemoryAuthoringRequest | null => {
    const id = operationId();
    if (tab === "entity") {
      const aliases = aliasList();
      const base = entityBase.entityId === entity.entityId ? entityBase : entity;
      const entityBody = (base as { body?: string }).body ?? "";
      return {
        operationId: id,
        action: "update",
        recordType: "entity",
        recordId: entity.entityId,
        expectedRevision: base.revision,
        reason,
        patch: {
          ...(aliases.join("\n") !== base.aliases.join("\n") ? { aliases } : {}),
          ...(tagList(tags).join(",") !== base.tags.join(",") ? { tags: tagList(tags) } : {}),
          ...(summary !== (base.summary ?? "") ? { summary } : {}),
          ...(body !== entityBody ? { body } : {}),
          ...(manualLock !== base.manualLock ? { manualLock } : {}),
          ...(archived !== (base.status === "archived") ? { status: archived ? "archived" : "active" } : {}),
        },
      };
    }
    if (!fact) return null;
    if (tab === "fact") {
      const base = factBase?.factId === fact.factId ? factBase : fact;
      const typedValue = parseValue(factValue, valueType);
      const conditionsChanged = conditions !== conditionsText(base.conditions);
      const parsedConditions = conditionsChanged ? parseConditions(conditions, base.conditions).conditions : undefined;
      if (typedValue === undefined || (conditionsChanged && !parsedConditions)) {
        setValidationError(true);
        return null;
      }
      return {
        operationId: id,
        action: "update",
        recordType: "fact",
        recordId: fact.factId,
        expectedRevision: base.revision,
        reason,
        patch: {
          ...(predicate !== base.predicate ? { predicate } : {}),
          ...(factValue !== valueText(base.value) || valueType !== valueKind(base.value) ? { value: typedValue } : {}),
          ...(parsedConditions ? { conditions: parsedConditions } : {}),
          ...(factStatus !== base.status ? { status: factStatus } : {}),
          ...(factLock !== base.manualLock ? { manualLock: factLock } : {}),
        },
      };
    }
    const correctedValue = parseValue(correctionValue, correctionType);
    const correctedConditions = parseConditions(correctionConditions, fact.conditions).conditions;
    if (correctedValue === undefined || !correctedConditions || !correctionPredicate.trim()) {
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
        conditions: correctedConditions,
        status: correctionStatus,
        ...(correctionValidFrom.trim() ? { validFromOrder: correctionValidFrom.trim() } : {}),
        evidence: [],
        supersedesFactId: fact.factId,
        manualLock: correctionLock,
      },
    };
  };
  // Inline checks shown next to the field while typing.
  const nameMissing = tab === "entity" && !name.trim() && entity.aliases.length > 0;
  const factValueInvalid = tab === "fact" && Boolean(fact) && parseValue(factValue, valueType) === undefined;
  const correctionValueInvalid =
    tab === "correction" && Boolean(fact) && parseValue(correctionValue, correctionType) === undefined;
  const correctionTopicMissing = tab === "correction" && Boolean(fact) && !correctionPredicate.trim();
  const factConditionsIssue =
    tab === "fact" && fact && conditions !== conditionsText(fact.conditions)
      ? parseConditions(conditions, fact.conditions).invalid
      : undefined;
  const correctionConditionsIssue =
    tab === "correction" && fact ? parseConditions(correctionConditions, fact.conditions).invalid : undefined;
  const inlineInvalid =
    nameMissing ||
    factValueInvalid ||
    correctionValueInvalid ||
    correctionTopicMissing ||
    Boolean(factConditionsIssue) ||
    Boolean(correctionConditionsIssue);

  const startRequest = () => {
    if (!reason.trim()) return;
    if (nameMissing) {
      setValidationError(true);
      return;
    }
    setValidationError(false);
    const next = buildRequest();
    if (!next) return;
    const requestVersion = draftVersion.current;
    setRequest(next);
    setConflict(false);
    setPreviewError(false);
    setCrossSession(null);
    void previewMutation
      .mutateAsync(next)
      .then((result) => {
        if (mounted.current && requestVersion === draftVersion.current) setPreview(result);
      })
      .catch((error: unknown) => {
        if (mounted.current && requestVersion === draftVersion.current) {
          const detail = crossSessionReferenceDetail(error);
          setPreview(null);
          setCrossSession(detail);
          setPreviewError(detail === null);
        }
      });
  };
  const apply = () => {
    if (!request) return;
    setApplyError(false);
    setCrossSession(null);
    void applyMutation
      .mutateAsync(request)
      .then(() => {
        setDirty(false);
        setPreview(null);
        setRequest(null);
        onReload();
      })
      .catch((error: unknown) => {
        const detail = crossSessionReferenceDetail(error);
        setCrossSession(detail);
        setConflict(isWikiRevisionConflict(error));
        setApplyError(detail === null);
      });
  };
  const close = () => {
    if (dirty && !window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm"))) return;
    onClose();
  };
  const busy =
    previewMutation.isPending ||
    applyMutation.isPending ||
    compensateEntityMutation.isPending ||
    compensateFactMutation.isPending;
  const previewBlocked = !reason.trim() || busy || (archiving && !references.data);

  // Recent reversible changes to this page and its facts, from each session that owns them.
  const undoEntries = useMemo(() => {
    const seen = new Set<string>();
    const rows: { entry: CampaignMemoryMutationJournal; owner: "entity" | "fact" }[] = [];
    const sources: [typeof entityAuditData, "entity" | "fact"][] = [[entityAuditData, "entity"]];
    if (factWriteChatId !== entityWriteChatId) sources.push([factAuditData, "fact"]);
    for (const [data, owner] of sources) {
      for (const entry of data?.items ?? []) {
        const relevant =
          (entry.recordType === "entity" && entry.recordId === entity.entityId) ||
          (entry.recordType === "fact" && facts.items.some((item) => item.factId === entry.recordId));
        if (!relevant || entry.before === undefined || entry.after === undefined) continue;
        const key = `${owner}:${entry.journalId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ entry, owner });
      }
    }
    return rows.sort((left, right) => right.entry.createdAt.localeCompare(left.entry.createdAt)).slice(0, 5);
  }, [entity.entityId, entityAuditData, entityWriteChatId, factAuditData, factWriteChatId, facts.items]);

  const undo = (entry: CampaignMemoryMutationJournal, owner: "entity" | "fact") => {
    setUndoError(false);
    const undoId = undoOperationIds.current.get(entry.operationId) ?? operationId();
    undoOperationIds.current.set(entry.operationId, undoId);
    const mutation = owner === "fact" ? compensateFactMutation : compensateEntityMutation;
    void mutation
      .mutateAsync({
        operationId: undoId,
        originalOperationId: entry.operationId,
        reason: t("ui.game.campaignWiki.editor.undoReason"),
      })
      .then(onReload)
      .catch(() => setUndoError(true));
  };

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

  const required = t("ui.game.campaignWiki.editor.required", { defaultValue: "Required" });
  const origin = recordOrigin(entity);
  const fromEarlierSession = entityWriteChatId !== chatId;
  const step: 1 | 2 | 3 = applyMutation.isPending ? 3 : preview ? 2 : 1;
  const invalidValueText = (type: ValueType) =>
    t("ui.game.campaignWiki.editor.invalidTyped", {
      defaultValue: "This is not valid {{type}}. Fix it or change the value type.",
      type: t(`ui.game.campaignWiki.editor.valueType.${type}`, { defaultValue: type }).toLowerCase(),
    });
  const invalidConditionText = (issue: { kind: string; type: ValueType } | undefined) =>
    issue
      ? t("ui.game.campaignWiki.editor.invalidCondition", {
          defaultValue: 'The value for "{{condition}}" must be {{expected}}. Fix that line before previewing.',
          condition: issue.kind,
          expected:
            issue.type === "number"
              ? t("ui.game.campaignWiki.editor.expectedNumber", { defaultValue: "a number" })
              : t("ui.game.campaignWiki.editor.expectedBoolean", { defaultValue: "true or false" }),
        })
      : null;
  const factLabel = (item: CampaignMemoryFact) => {
    if (item.predicate && item.predicate !== "other") return item.predicate;
    const text = factDisplay(item).text;
    return shorten(text && text !== "—" ? text : humanizeKey(item.predicate || "fact"), 70);
  };
  const tabs: { id: EditorTab; label: string; icon: ReactNode; hint: string }[] = [
    {
      id: "entity",
      label: t("ui.game.campaignWiki.editor.tab.page", { defaultValue: "Page details" }),
      icon: <FileText size={14} />,
      hint: t("ui.game.campaignWiki.editor.tabHint.page", {
        defaultValue: "Rename the page, add other names, and edit its description and notes.",
      }),
    },
    {
      id: "fact",
      label: t("ui.game.campaignWiki.editor.fact"),
      icon: <PencilLine size={14} />,
      hint: t("ui.game.campaignWiki.editor.tabHint.fact", {
        defaultValue: "Fix a typo or detail in one fact. The fact is updated in place.",
      }),
    },
    {
      id: "correction",
      label: t("ui.game.campaignWiki.editor.correction"),
      icon: <Wrench size={14} />,
      hint: t("ui.game.campaignWiki.editor.tabHint.correction", {
        defaultValue:
          "The story changed or a fact was wrong? Write the corrected version; the old one stays in history.",
      }),
    },
  ];
  const activeHint = tabs.find((item) => item.id === tab)?.hint ?? "";

  const factSelect = fact && (
    <EditorSelect
      label={t("ui.game.campaignWiki.editor.factToEdit")}
      value={fact.factId}
      onChange={(value) => {
        if (dirty && !window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm"))) return;
        setDirty(false);
        invalidatePreview();
        setFactId(value);
      }}
      disabled={busy}
      hint={
        factDisplay(fact).text && factDisplay(fact).text !== "—"
          ? t("ui.game.campaignWiki.editor.factCurrently", {
              defaultValue: "Currently: {{text}}",
              text: shorten(factDisplay(fact).text, 160),
            })
          : undefined
      }
    >
      <option value="">{t("ui.game.campaignWiki.editor.chooseFact")}</option>
      {facts.items.map((item) => (
        <option key={item.factId} value={item.factId}>
          {factLabel(item)}
        </option>
      ))}
    </EditorSelect>
  );
  const typeSelect = (value: ValueType, onChange: (next: ValueType) => void) => (
    <EditorSelect
      label={t("ui.game.campaignWiki.editor.valueType")}
      hint={t("ui.game.campaignWiki.editor.valueTypeHint", {
        defaultValue:
          "Most facts are text. Pick another type only if the value is a number, yes or no, or structured data.",
      })}
      value={value}
      onChange={(next) => {
        onChange(next as ValueType);
        updateDirty();
      }}
      disabled={busy}
    >
      {["string", "number", "boolean", "json"].map((type) => (
        <option key={type} value={type}>
          {t(`ui.game.campaignWiki.editor.valueType.${type}`, { defaultValue: type })}
        </option>
      ))}
    </EditorSelect>
  );
  const statusSelect = (
    label: string,
    value: CampaignMemoryFact["status"],
    onChange: (next: CampaignMemoryFact["status"]) => void,
  ) => (
    <EditorSelect
      label={label}
      hint={t("ui.game.campaignWiki.create.statusHint", {
        defaultValue: "Verified facts are treated as settled canon. Proposed ones can still be reviewed.",
      })}
      value={value}
      onChange={(next) => {
        onChange(next as CampaignMemoryFact["status"]);
        updateDirty();
      }}
      disabled={busy}
    >
      {["proposed", "verified", "superseded", "held", "retracted"].map((status) => (
        <option key={status} value={status}>
          {t(`ui.game.campaignWiki.editor.status.${status}`, { defaultValue: status })}
        </option>
      ))}
    </EditorSelect>
  );
  const retryButton = (onRetry: () => void) => (
    <button type="button" onClick={onRetry} className={cn(editorButton.secondary, "min-h-9 px-3 text-xs")}>
      <RotateCw size={12} />
      {t("ui.game.campaignWiki.retry")}
    </button>
  );
  const referenceTotal = references.data
    ? REFERENCE_KEYS.reduce((total, key) => total + (references.data?.[key] ?? 0), 0)
    : 0;
  const exampleFacts = facts.items
    .map((item) => factDisplay(item).text)
    .filter((text) => text && text !== "—")
    .slice(0, 3);
  const connectedNames = detail.relatedEntities
    .map((related) => firstName(related.aliases))
    .filter(Boolean)
    .slice(0, 8);
  const footerStatus = !reason.trim()
    ? t("ui.game.campaignWiki.editor.footer.needReason", {
        defaultValue: "Add a short reason for this change to continue.",
      })
    : archiving && !references.data
      ? t("ui.game.campaignWiki.editor.footer.checkingArchive", {
          defaultValue: "Checking what archiving this page affects before you can continue.",
        })
      : preview
        ? t("ui.game.campaignWiki.editor.footer.reviewed", {
            defaultValue: "Looks right? Save it to the wiki. Editing any field will ask for a fresh preview.",
          })
        : t("ui.game.campaignWiki.editor.footer.draft", {
            defaultValue: "Nothing is saved until you review the preview and confirm.",
          });

  return (
    <div className="space-y-4" aria-label={t("ui.game.campaignWiki.editor.title")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <EntityAvatar name={displayName} kind={entity.kind} size={40} />
          <div className="min-w-0 space-y-2">
            <div>
              <h3 className="text-lg font-bold leading-tight text-foreground">
                {t("ui.game.campaignWiki.editor.title")}
              </h3>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="break-words font-medium text-foreground/90">{displayName}</span>
                {entity.status === "archived" && (
                  <WikiChip tone="warning">
                    {t("ui.game.campaignWiki.editor.status.archived", { defaultValue: "Archived" })}
                  </WikiChip>
                )}
                {fromEarlierSession && (
                  <WikiChip
                    tone="info"
                    title={t("ui.game.campaignWiki.editor.earlierSessionHint", {
                      defaultValue: "This page was recorded in an earlier session. Your changes are saved there.",
                    })}
                  >
                    {origin.sessionNumber !== null
                      ? t("ui.game.campaignWiki.editor.fromSession", {
                          defaultValue: "From session {{number}}",
                          number: origin.sessionNumber,
                        })
                      : t("ui.game.campaignWiki.editor.fromEarlierSession", {
                          defaultValue: "From an earlier session",
                        })}
                  </WikiChip>
                )}
              </p>
            </div>
            <EditorStepper
              step={step}
              labels={[
                t("ui.game.campaignWiki.editor.step.edit", { defaultValue: "Write" }),
                t("ui.game.campaignWiki.editor.step.review", { defaultValue: "Review" }),
                t("ui.game.campaignWiki.editor.step.save", { defaultValue: "Save" }),
              ]}
            />
          </div>
        </div>
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
            className={cn(editorButton.secondary, "px-3")}
          >
            <Plus size={15} />
            {t("ui.game.campaignWiki.create.open", { defaultValue: "Add record" })}
          </button>
          <button
            type="button"
            onClick={close}
            className={cn(editorButton.ghost, "w-10 px-0")}
            aria-label={t("ui.game.campaignWiki.editor.close")}
          >
            <X size={17} />
          </button>
        </div>
      </div>

      <div>
        <div
          role="group"
          className="grid grid-cols-3 gap-1 rounded-xl border border-border bg-secondary/30 p-1"
          aria-label={t("ui.game.campaignWiki.editor.modeLabel", { defaultValue: "What do you want to change?" })}
        >
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => switchTab(item.id)}
              disabled={busy}
              aria-pressed={tab === item.id}
              className={cn(
                "inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60 sm:text-sm",
                tab === item.id
                  ? "bg-primary/20 text-foreground shadow-sm ring-1 ring-primary/50"
                  : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
              )}
            >
              <span className="hidden shrink-0 sm:inline-flex">{item.icon}</span>
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{activeHint}</p>
      </div>

      {tab === "entity" && (
        <>
          <EditorSection
            icon={<Tags size={14} />}
            title={t("ui.game.campaignWiki.editor.section.names", { defaultValue: "Name and tags" })}
          >
            <EditorField
              multiline={false}
              label={t("ui.game.campaignWiki.editor.name", { defaultValue: "Name" })}
              hint={t("ui.game.campaignWiki.editor.nameHint", {
                defaultValue: "The title shown at the top of the page and in lists.",
              })}
              value={name}
              onChange={mark(setName)}
              disabled={busy}
              required
              requiredLabel={required}
              error={
                nameMissing
                  ? t("ui.game.campaignWiki.editor.nameMissing", { defaultValue: "A page needs a name." })
                  : null
              }
            />
            <EditorField
              label={t("ui.game.campaignWiki.editor.otherNames", { defaultValue: "Other names" })}
              hint={t("ui.game.campaignWiki.editor.otherNamesHint", {
                defaultValue: "Nicknames, titles or spellings, one per line. They help the story recognise this page.",
              })}
              value={otherNames}
              onChange={mark(setOtherNames)}
              disabled={busy}
              rows={2}
            />
            <EditorField
              label={t("ui.game.campaignWiki.editor.tags")}
              hint={t("ui.game.campaignWiki.editor.tagsHint", {
                defaultValue: "Optional. Short labels for grouping, separated by commas.",
              })}
              value={tags}
              onChange={mark(setTags)}
              disabled={busy}
            />
          </EditorSection>
          <EditorSection
            icon={<FileText size={14} />}
            title={t("ui.game.campaignWiki.editor.section.description", { defaultValue: "Description and notes" })}
          >
            <EditorField
              label={t("ui.game.campaignWiki.editor.summary")}
              hint={t("ui.game.campaignWiki.editor.summaryHint", {
                defaultValue: "One or two sentences shown at the top of the page.",
              })}
              value={summary}
              onChange={mark(setSummary)}
              disabled={busy}
              rows={3}
            />
            <EditorField
              label={t("ui.game.campaignWiki.editor.notesLabel", { defaultValue: "Notes" })}
              hint={t("ui.game.campaignWiki.editor.notesHint", {
                defaultValue: "Longer notes in plain text or Markdown.",
              })}
              counter={t("ui.game.campaignWiki.editor.notesCounter", {
                defaultValue: "{{used}} / {{max}}",
                used: body.length.toLocaleString(i18n.language),
                max: (20000).toLocaleString(i18n.language),
              })}
              value={body}
              onChange={mark(setBody)}
              disabled={busy}
              maxLength={20000}
              rows={6}
            />
          </EditorSection>
          <EditorSection
            icon={<Lock size={14} />}
            title={t("ui.game.campaignWiki.editor.section.protection", { defaultValue: "Protection and archive" })}
          >
            <EditorToggle
              label={t("ui.game.campaignWiki.editor.manualLock")}
              description={t("ui.game.campaignWiki.editor.manualLockHint", {
                defaultValue:
                  "When on, the story engine will not rewrite this page on its own. You can still edit it here.",
              })}
              checked={manualLock}
              disabled={busy}
              onChange={(checked) => {
                setManualLock(checked);
                updateDirty();
              }}
            />
            <EditorToggle
              tone="danger"
              label={t("ui.game.campaignWiki.editor.archive")}
              description={
                entity.status === "archived"
                  ? t("ui.game.campaignWiki.editor.unarchiveHint", {
                      defaultValue: "This page is archived. Untick to bring it back.",
                    })
                  : t("ui.game.campaignWiki.editor.archiveHint", {
                      defaultValue: "Hide this page when it no longer matters. Nothing is deleted and you can undo it.",
                    })
              }
              checked={archived}
              disabled={busy}
              onChange={(checked) => {
                setArchived(checked);
                updateDirty();
              }}
            />
            {archiving && (
              <section
                aria-label={t("ui.game.campaignWiki.editor.archiveReferences")}
                className="space-y-3 rounded-lg border border-amber-400/35 bg-amber-400/5 p-3"
              >
                <div className="flex items-start gap-2">
                  <Archive size={15} className="mt-0.5 shrink-0 text-amber-200" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      {t("ui.game.campaignWiki.editor.archiveImpactTitle", {
                        defaultValue: "Before you archive {{name}}",
                        name: displayName,
                      })}
                    </p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t("ui.game.campaignWiki.editor.referencesPreserved")}
                    </p>
                  </div>
                </div>
                {references.isLoading && (
                  <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 size={12} className="animate-spin" />
                    {t("ui.game.campaignWiki.editor.referencesLoading")}
                  </p>
                )}
                {references.isError && (
                  <EditorAlert action={retryButton(() => void references.refetch())}>
                    {t("ui.game.campaignWiki.editor.referencesError")}
                  </EditorAlert>
                )}
                {references.data && (
                  <>
                    <p className="text-xs leading-5 text-foreground/90">
                      {referenceTotal === 0
                        ? t("ui.game.campaignWiki.editor.archiveImpactNone", {
                            defaultValue: "Nothing else in the wiki mentions this page.",
                          })
                        : t("ui.game.campaignWiki.editor.archiveImpactSome", {
                            defaultValue:
                              "These records mention this page. They stay as they are and keep their history:",
                          })}
                    </p>
                    {referenceTotal > 0 && (
                      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {REFERENCE_KEYS.filter((key) => (references.data?.[key] ?? 0) > 0).map((key) => (
                          <li key={key} className="rounded-lg bg-secondary/40 px-3 py-2">
                            <span className="block text-lg font-bold tabular-nums text-foreground">
                              {references.data[key].toLocaleString(i18n.language)}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {t(`ui.game.campaignWiki.editor.referenceName.${key}`, {
                                defaultValue: REFERENCE_NAMES[key],
                              })}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {references.data.facts > 0 && exampleFacts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("ui.game.campaignWiki.editor.archiveExamples", { defaultValue: "For example" })}
                        </p>
                        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs leading-5 text-foreground/90">
                          {exampleFacts.map((text, index) => (
                            <li key={`${index}-${text}`} className="break-words">
                              {shorten(text, 140)}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {references.data.relationships > 0 && connectedNames.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("ui.game.campaignWiki.editor.archiveConnected", { defaultValue: "Connected pages" })}
                        </p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {connectedNames.map((connected) => (
                            <WikiChip key={connected}>{connected}</WikiChip>
                          ))}
                        </div>
                      </div>
                    )}
                    {referenceTotal > 0 && (
                      <details className="group text-xs">
                        <summary className="flex min-h-8 pointer-coarse:min-h-9 cursor-pointer list-none items-center gap-1.5 text-muted-foreground">
                          <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
                          {t("ui.game.campaignWiki.editor.review.technical", { defaultValue: "Technical details" })}
                        </summary>
                        <dl className="mt-1 space-y-1">
                          {REFERENCE_KEYS.filter((key) => (references.data?.samples[key] ?? []).length > 0).map(
                            (key) => (
                              <div key={key} className="grid gap-0.5 sm:grid-cols-[8rem_1fr]">
                                <dt className="text-muted-foreground">
                                  {t(`ui.game.campaignWiki.editor.referenceCount.${key}`, { defaultValue: key })}
                                </dt>
                                <dd className="break-all font-mono text-foreground/80">
                                  {(references.data?.samples[key] ?? []).join(", ")}
                                </dd>
                              </div>
                            ),
                          )}
                        </dl>
                      </details>
                    )}
                  </>
                )}
              </section>
            )}
          </EditorSection>
        </>
      )}

      {tab === "fact" && (
        <EditorSection
          icon={<PencilLine size={14} />}
          title={t("ui.game.campaignWiki.editor.section.fact", { defaultValue: "Edit a fact" })}
        >
          {fact ? (
            <>
              {factSelect}
              <EditorField
                label={t("ui.game.campaignWiki.create.topic", { defaultValue: "Topic" })}
                hint={t("ui.game.campaignWiki.create.topicHint", {
                  defaultValue: "A short label, like occupation, owes money to, or favourite drink.",
                })}
                value={predicate}
                onChange={mark(setPredicate)}
                disabled={busy}
              />
              <EditorField
                label={t("ui.game.campaignWiki.create.details", { defaultValue: "What is true" })}
                value={factValue}
                onChange={mark(setFactValue)}
                disabled={busy}
                rows={3}
                error={factValueInvalid ? invalidValueText(valueType) : null}
              />
              {typeSelect(valueType, setValueType)}
              <EditorField
                label={t("ui.game.campaignWiki.editor.whenApplies", { defaultValue: "When it applies" })}
                hint={t("ui.game.campaignWiki.editor.conditionsHelp")}
                value={conditions}
                onChange={mark(setConditions)}
                disabled={busy}
                rows={2}
                error={invalidConditionText(factConditionsIssue)}
              />
              {statusSelect(t("ui.game.campaignWiki.editor.status"), factStatus, setFactStatus)}
              <EditorToggle
                label={t("ui.game.campaignWiki.editor.manualLock")}
                description={t("ui.game.campaignWiki.editor.factLockHint", {
                  defaultValue: "When on, the story engine will not change this fact on its own.",
                })}
                checked={factLock}
                disabled={busy}
                onChange={(checked) => {
                  setFactLock(checked);
                  updateDirty();
                }}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("ui.game.campaignWiki.editor.noFacts")}</p>
          )}
        </EditorSection>
      )}

      {tab === "correction" && (
        <section aria-label={t("ui.game.campaignWiki.editor.correctionTitle")} className="space-y-4">
          {fact ? (
            <>
              <EditorSection
                title={t("ui.game.campaignWiki.editor.originalClaim")}
                description={t("ui.game.campaignWiki.editor.correctionRetains")}
              >
                {factSelect}
                <div className="rounded-lg bg-secondary/40 px-3 py-2.5">
                  <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                    {humanizeKey(fact.predicate || "fact")}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                    {factDisplay(fact).text}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <WikiChip tone={fact.status === "verified" ? "success" : "neutral"}>
                      {t(`ui.game.campaignWiki.factStatus.${fact.status}`, { defaultValue: fact.status })}
                    </WikiChip>
                    {factDisplay(fact).conditions.map((condition) => (
                      <WikiChip key={condition} tone="warning">
                        {condition}
                      </WikiChip>
                    ))}
                  </div>
                </div>
                <CampaignWikiEvidence chatId={chatId} evidence={fact.evidence} />
              </EditorSection>
              <EditorSection
                icon={<Wrench size={14} />}
                title={t("ui.game.campaignWiki.editor.proposedCorrection")}
                description={t("ui.game.campaignWiki.editor.correctionHint", {
                  defaultValue: "Write the fact as it should read now. It replaces the original going forward.",
                })}
              >
                <EditorField
                  label={t("ui.game.campaignWiki.create.topic", { defaultValue: "Topic" })}
                  value={correctionPredicate}
                  onChange={mark(setCorrectionPredicate)}
                  disabled={busy}
                  required
                  requiredLabel={required}
                  error={
                    correctionTopicMissing
                      ? t("ui.game.campaignWiki.editor.requiredError", { defaultValue: "Fill this in to continue." })
                      : null
                  }
                />
                <EditorField
                  label={t("ui.game.campaignWiki.create.details", { defaultValue: "What is true" })}
                  value={correctionValue}
                  onChange={mark(setCorrectionValue)}
                  disabled={busy}
                  rows={3}
                  error={correctionValueInvalid ? invalidValueText(correctionType) : null}
                />
                {typeSelect(correctionType, setCorrectionType)}
                <EditorField
                  label={t("ui.game.campaignWiki.editor.whenApplies", { defaultValue: "When it applies" })}
                  hint={t("ui.game.campaignWiki.editor.conditionsHelp")}
                  value={correctionConditions}
                  onChange={mark(setCorrectionConditions)}
                  disabled={busy}
                  rows={2}
                  error={invalidConditionText(correctionConditionsIssue)}
                />
                {statusSelect(t("ui.game.campaignWiki.editor.correctionStatus"), correctionStatus, setCorrectionStatus)}
                <EditorToggle
                  label={t("ui.game.campaignWiki.editor.protectRecord")}
                  description={t("ui.game.campaignWiki.editor.factLockHint", {
                    defaultValue: "When on, the story engine will not change this fact on its own.",
                  })}
                  checked={correctionLock}
                  disabled={busy}
                  onChange={(checked) => {
                    setCorrectionLock(checked);
                    updateDirty();
                  }}
                />
                <details
                  className="group rounded-lg border border-border/70 px-3 py-2"
                  open={Boolean(correctionValidFrom)}
                >
                  <summary className="flex min-h-8 pointer-coarse:min-h-9 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
                    {t("ui.game.campaignWiki.editor.advanced", { defaultValue: "Advanced options" })}
                  </summary>
                  <div className="mt-2">
                    <EditorField
                      label={t("ui.game.campaignWiki.editor.appliesFrom", { defaultValue: "Applies from (optional)" })}
                      hint={t("ui.game.campaignWiki.editor.appliesFromHint", {
                        defaultValue:
                          "Leave empty to apply from now on. Only fill this in if you know the exact story moment marker.",
                      })}
                      value={correctionValidFrom}
                      onChange={mark(setCorrectionValidFrom)}
                      disabled={busy}
                    />
                  </div>
                </details>
              </EditorSection>
              <EditorSection
                title={t("ui.game.campaignWiki.editor.impactTitle", { defaultValue: "What else might need a look" })}
                description={t("ui.game.campaignWiki.editor.impactHint", {
                  defaultValue: "These records were built on the original fact. They are not changed automatically.",
                })}
              >
                {dependents.isLoading && (
                  <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 size={12} className="animate-spin" />
                    {t("ui.game.campaignWiki.editor.impactLoading")}
                  </p>
                )}
                {dependents.isError && (
                  <EditorAlert action={retryButton(() => void dependents.refetch())}>
                    {t("ui.game.campaignWiki.editor.impactError")}
                  </EditorAlert>
                )}
                {dependents.data &&
                  (dependents.data.knowledge.length + dependents.data.states.length + dependents.data.events.length ===
                  0 ? (
                    <p className="text-sm text-muted-foreground">{t("ui.game.campaignWiki.editor.impactNone")}</p>
                  ) : (
                    <div className="space-y-3 text-sm">
                      {dependents.data.knowledge.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground">
                            {t("ui.game.campaignWiki.editor.impactKnowledge", {
                              count: dependents.data.knowledge.length,
                            })}
                          </p>
                          <ul className="mt-1 space-y-1">
                            {dependents.data.knowledge.map((item) => (
                              <li key={item.knowledgeId} className="flex flex-wrap items-center gap-1.5 break-words">
                                <span className="font-medium text-foreground">
                                  {item.holder.alias ||
                                    entityNames.get(item.holder.entityId) ||
                                    t("ui.game.campaignWiki.editor.someone", { defaultValue: "Someone" })}
                                </span>
                                <WikiChip tone={item.epistemicState === "knows" ? "success" : "info"}>
                                  {t(`ui.game.campaignWiki.epistemicState.${item.epistemicState}`, {
                                    defaultValue: item.epistemicState,
                                  })}
                                </WikiChip>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {dependents.data.states.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground">
                            {t("ui.game.campaignWiki.editor.impactStates", { count: dependents.data.states.length })}
                          </p>
                          <ul className="mt-1 space-y-1">
                            {dependents.data.states.map((item) => (
                              <li key={`${item.entityId}-${item.key}-${item.causeEventId}`} className="break-words">
                                {entityNames.get(item.entityId) ? (
                                  <>
                                    <span className="font-medium text-foreground">
                                      {entityNames.get(item.entityId)}
                                    </span>
                                    {": "}
                                  </>
                                ) : null}
                                {humanizeKey(item.key)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {dependents.data.events.length > 0 && (
                        <div>
                          <p className="text-xs font-semibold text-muted-foreground">
                            {t("ui.game.campaignWiki.editor.impactEvents", { count: dependents.data.events.length })}
                          </p>
                          <ul className="mt-1 list-disc space-y-0.5 pl-5">
                            {dependents.data.events.map((item) => (
                              <li key={item.eventId} className="break-words">
                                {item.summary ||
                                  t("ui.game.campaignWiki.editor.unnamedEvent", {
                                    defaultValue: "An event with no summary",
                                  })}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">{t("ui.game.campaignWiki.editor.impactRecheck")}</p>
                    </div>
                  ))}
              </EditorSection>
            </>
          ) : (
            <EditorSection title={t("ui.game.campaignWiki.editor.originalClaim")}>
              <p className="text-sm text-muted-foreground">{t("ui.game.campaignWiki.editor.noFacts")}</p>
            </EditorSection>
          )}
        </section>
      )}

      <EditorSection title={t("ui.game.campaignWiki.editor.whyChangeSection", { defaultValue: "Why this change?" })}>
        <EditorField
          label={t("ui.game.campaignWiki.editor.reason")}
          hint={t("ui.game.campaignWiki.editor.reasonHint", {
            defaultValue: "A short note for the change history, for example: fixed after session 12.",
          })}
          value={reason}
          onChange={mark(setReason)}
          disabled={busy}
          required
          requiredLabel={required}
        />
      </EditorSection>

      {validationError && (
        <EditorAlert>
          {nameMissing
            ? t("ui.game.campaignWiki.editor.nameMissing", { defaultValue: "A page needs a name." })
            : t("ui.game.campaignWiki.editor.invalidValue")}
        </EditorAlert>
      )}
      {previewError && <EditorAlert>{t("ui.game.campaignWiki.editor.previewError")}</EditorAlert>}
      {crossSession !== null && (
        <EditorAlert>
          <span data-campaign-wiki-cross-session>{crossSessionReferenceText(t as TFn, crossSession)}</span>
        </EditorAlert>
      )}
      {applyError && !conflict && <EditorAlert>{t("ui.game.campaignWiki.editor.applyError")}</EditorAlert>}
      {conflict && (
        <EditorAlert
          action={
            <button type="button" onClick={onReload} className={cn(editorButton.secondary, "min-h-9 px-3 text-xs")}>
              <RotateCw size={12} />
              {t("ui.game.campaignWiki.editor.reload")}
            </button>
          }
        >
          {t("ui.game.campaignWiki.editor.conflict")}
        </EditorAlert>
      )}

      {preview && (
        <div ref={reviewRef}>
          <ChangeReview
            preview={preview}
            resolveName={(id) => entityNames.get(id)}
            footnote={tab === "correction" ? t("ui.game.campaignWiki.editor.correctionRetains") : undefined}
          />
        </div>
      )}

      {undoEntries.length > 0 && (
        <EditorSection
          icon={<History size={14} />}
          title={t("ui.game.campaignWiki.editor.recentChanges", { defaultValue: "Recent changes" })}
          description={t("ui.game.campaignWiki.editor.recentChangesHint", {
            defaultValue: "Undo puts the record back the way it was before that change.",
          })}
        >
          {undoError && <EditorAlert>{t("ui.game.campaignWiki.editor.undoError")}</EditorAlert>}
          <ul className="divide-y divide-border/70">
            {undoEntries.map(({ entry, owner }) => {
              const when = new Date(entry.createdAt);
              return (
                <li
                  key={`${owner}-${entry.journalId}`}
                  className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                      <WikiChip tone={entry.recordType === "fact" ? "info" : "accent"}>
                        {entry.recordType === "fact"
                          ? t("ui.game.campaignWiki.editor.fact")
                          : t("ui.game.campaignWiki.editor.tab.page", { defaultValue: "Page details" })}
                      </WikiChip>
                      <span className="min-w-0 break-words">
                        {entry.reason || t("ui.game.campaignWiki.editor.noReason", { defaultValue: "No reason given" })}
                      </span>
                    </p>
                    {Number.isFinite(when.getTime()) && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {when.toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" })}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => undo(entry, owner)}
                    disabled={busy}
                    className={cn(editorButton.secondary, "min-h-9 shrink-0 px-3 text-xs")}
                  >
                    <RotateCcw size={13} />
                    {t("ui.game.campaignWiki.editor.undo")}
                  </button>
                </li>
              );
            })}
          </ul>
        </EditorSection>
      )}
      {undoError && undoEntries.length === 0 && <EditorAlert>{t("ui.game.campaignWiki.editor.undoError")}</EditorAlert>}

      <EditorFooter
        status={
          <span className="flex flex-wrap items-center gap-2">
            {dirty && (
              <WikiChip tone="warning">
                {t("ui.game.campaignWiki.editor.unsaved", { defaultValue: "Unsaved changes" })}
              </WikiChip>
            )}
            <span>{footerStatus}</span>
          </span>
        }
      >
        <button type="button" onClick={close} className={editorButton.ghost}>
          {t("ui.game.campaignWiki.editor.cancel", { defaultValue: "Cancel" })}
        </button>
        <button
          type="button"
          onClick={startRequest}
          disabled={previewBlocked || (inlineInvalid && !preview)}
          className={preview ? editorButton.secondary : editorButton.primary}
        >
          {previewMutation.isPending && <Loader2 size={14} className="animate-spin" />}
          {previewMutation.isPending
            ? t("ui.game.campaignWiki.editor.previewing")
            : t("ui.game.campaignWiki.editor.preview")}
        </button>
        {preview && (
          <button type="button" onClick={apply} disabled={busy} className={editorButton.primary}>
            {applyMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {applyMutation.isPending ? t("ui.game.campaignWiki.editor.saving") : t("ui.game.campaignWiki.editor.apply")}
          </button>
        )}
      </EditorFooter>
    </div>
  );
}
