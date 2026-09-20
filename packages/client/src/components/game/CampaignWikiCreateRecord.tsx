import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CampaignMemoryAuthoringRequest,
  CampaignMemoryAuthoringPreview,
  CampaignMemoryEntity,
  CampaignMemoryEntityDetail,
  CampaignMemoryEntityKind,
  CampaignMemoryFact,
  CampaignMemoryKnowledge,
  CampaignMemoryPage,
  CampaignMemoryRelationshipStatus,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { ApiError, api } from "../../lib/api-client";
import {
  useApplyCampaignMemoryMutation,
  useCampaignMemoryEntities,
  usePreviewCampaignMemoryMutation,
} from "../../hooks/use-campaign-memory";

type RecordKind = "fact" | "knowledge" | "relationship" | "entity";

const CREATABLE_ENTITY_KINDS = ["organization", "item", "quest", "lore", "note"] as const;
type CreatableEntityKind = (typeof CREATABLE_ENTITY_KINDS)[number];

/** Owner stores accepted by the server for existing owners (mirrors CAMPAIGN_MEMORY_OWNER_STORES); registry kinds own themselves. */
const EXISTING_OWNER_STORES: Partial<Record<CampaignMemoryEntityKind, string>> = {
  lore: "lorebook-entries",
  quest: "game-state",
  item: "game-state",
};

function newOperationId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `campaign-memory-create-${Date.now()}`;
}

function valueText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function lines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function TextField({
  label,
  value,
  onChange,
  disabled,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  required?: boolean;
}) {
  return (
    <label className="block text-sm">
      {label}
      <textarea
        required={required}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 min-h-10 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-2 text-sm"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block text-sm">
      {label}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 min-h-10 w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2"
      >
        {children}
      </select>
    </label>
  );
}

export function CampaignWikiCreateRecord({
  chatId,
  detail,
  onCancel,
  onApplied,
  onDirtyChange,
}: {
  chatId: string;
  detail: CampaignMemoryEntityDetail;
  onCancel: () => void;
  onApplied: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useUiTranslation();
  const { entity, facts, referencedFacts } = detail;
  const [kind, setKind] = useState<RecordKind>("fact");
  const [predicate, setPredicate] = useState("");
  const [factValue, setFactValue] = useState("");
  const [conditions, setConditions] = useState("");
  const [factStatus, setFactStatus] = useState<CampaignMemoryFact["status"]>("proposed");
  const [holderState, setHolderState] = useState<CampaignMemoryKnowledge["epistemicState"]>("knows");
  const [factId, setFactId] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [targetId, setTargetId] = useState("");
  const [relationshipType, setRelationshipType] = useState("");
  const [inverseLabel, setInverseLabel] = useState("");
  const [relationshipStatus, setRelationshipStatus] = useState<CampaignMemoryRelationshipStatus>("proposed");
  const [entityKind, setEntityKind] = useState<CreatableEntityKind>("organization");
  const [entityAliases, setEntityAliases] = useState("");
  const [entityTags, setEntityTags] = useState("");
  const [entitySummary, setEntitySummary] = useState("");
  const [ownerRecordId, setOwnerRecordId] = useState("");
  const [ownerLookup, setOwnerLookup] = useState("");
  const [reason, setReason] = useState("");
  const [request, setRequest] = useState<CampaignMemoryAuthoringRequest | null>(null);
  const [preview, setPreview] = useState<CampaignMemoryAuthoringPreview | null>(null);
  const [error, setError] = useState<"validation" | "preview" | "apply" | "conflict" | "ownerLinked" | null>(null);
  const [dirty, setDirty] = useState(false);
  const version = useRef(0);
  const mounted = useRef(true);
  const previewMutation = usePreviewCampaignMemoryMutation(chatId);
  const applyMutation = useApplyCampaignMemoryMutation(chatId);
  const targets = useCampaignMemoryEntities(chatId, {
    query: targetQuery,
    kind: "all",
    offset: 0,
    limit: 20,
    enabled: kind === "relationship",
  });
  const ownerStore = EXISTING_OWNER_STORES[entityKind];
  const ownerRef = ownerStore && ownerLookup ? `${ownerStore}:${ownerLookup}` : "";
  // Contract item 2: entities already owned by the chosen existing owner record.
  const ownerEntities = useQuery({
    queryKey: ["campaign-memory", "owner", chatId, ownerRef],
    queryFn: () =>
      api.get<CampaignMemoryPage<CampaignMemoryEntity>>(
        `/game/${chatId}/memory/entities?owner=${encodeURIComponent(ownerRef)}&offset=0&limit=5`,
      ),
    enabled: kind === "entity" && Boolean(ownerRef),
    staleTime: 0,
  });
  const ownerLinked = ownerEntities.data?.items[0];

  const verifiedFacts = useMemo(() => {
    const byId = new Map<string, CampaignMemoryFact>();
    [...facts.items, ...referencedFacts].forEach((fact) => {
      if (fact.status === "verified" && detail.sourceChecks?.[fact.factId]?.state !== "stale")
        byId.set(fact.factId, fact);
    });
    return [...byId.values()];
  }, [detail.sourceChecks, facts.items, referencedFacts]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => setOwnerLookup(ownerRecordId.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [ownerRecordId]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const busy = previewMutation.isPending || applyMutation.isPending;
  const invalidate = () => {
    version.current += 1;
    setRequest(null);
    setPreview(null);
    setError(null);
  };
  const edit =
    <T,>(setter: (value: T) => void) =>
    (value: T) => {
      setter(value);
      invalidate();
      setDirty(true);
    };
  const changeKind = (value: RecordKind) => {
    setKind(value);
    setTargetId("");
    invalidate();
    setDirty(true);
  };
  const close = () => {
    if (
      dirty &&
      !window.confirm(t("ui.game.campaignWiki.editor.unsavedConfirm", { defaultValue: "Discard unsaved record?" }))
    )
      return;
    onCancel();
  };
  const buildRequest = (): CampaignMemoryAuthoringRequest | null => {
    if (!reason.trim()) return null;
    const operationId = newOperationId();
    if (kind === "fact") {
      if (!predicate.trim() || !factValue.trim()) return null;
      const parsedConditions = lines(conditions).map((line) => ({ kind: "condition", value: line }));
      return {
        operationId,
        action: "create",
        recordType: "fact",
        reason: reason.trim(),
        input: {
          subjectEntityId: entity.entityId,
          predicate: predicate.trim(),
          value: factValue.trim(),
          conditions: parsedConditions,
          status: factStatus,
          evidence: [],
          manualLock: false,
        },
      };
    }
    if (kind === "knowledge") {
      if (!factId) return null;
      return {
        operationId,
        action: "create",
        recordType: "knowledge",
        reason: reason.trim(),
        input: {
          holderEntityId: entity.entityId,
          factId,
          epistemicState: holderState,
          learnedFrom: [],
          manualLock: false,
        },
      };
    }
    if (kind === "entity") {
      const aliases = lines(entityAliases);
      if (aliases.length === 0) return null;
      const recordId = ownerRecordId.trim();
      if (ownerStore && !recordId) return null;
      // Registry owners must point at their own entity ID, so the ID is fixed before the request is previewed.
      const entityId = ownerStore ? undefined : operationId;
      return {
        operationId,
        action: "create",
        recordType: "entity",
        reason: reason.trim(),
        input: {
          ...(entityId ? { entityId } : {}),
          kind: entityKind,
          owner: ownerStore
            ? { type: "existing", store: ownerStore, recordId }
            : { type: "registry", store: "campaign-memory", recordId: entityId },
          aliases,
          tags: entityTags
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          ...(entitySummary.trim() ? { summary: entitySummary.trim() } : {}),
          attributes: {},
          status: "active",
          manualLock: false,
        },
      };
    }
    if (!targetId || !relationshipType.trim() || !inverseLabel.trim()) return null;
    return {
      operationId,
      action: "create",
      recordType: "relationship",
      reason: reason.trim(),
      input: {
        sourceEntityId: entity.entityId,
        targetEntityId: targetId,
        type: relationshipType.trim(),
        inverseLabel: inverseLabel.trim(),
        status: relationshipStatus,
        evidence: [],
        manualLock: false,
      },
    };
  };
  const previewDraft = () => {
    if (kind === "entity" && ownerStore && (ownerLinked || !ownerEntities.data)) {
      setError(ownerLinked ? "ownerLinked" : "validation");
      return;
    }
    const next = buildRequest();
    if (!next) {
      setError("validation");
      return;
    }
    setError(null);
    const requestVersion = version.current;
    setRequest(next);
    void previewMutation
      .mutateAsync(next)
      .then((result) => {
        if (mounted.current && requestVersion === version.current) setPreview(result);
      })
      .catch(() => {
        if (mounted.current && requestVersion === version.current) {
          setPreview(null);
          setError("preview");
        }
      });
  };
  const apply = () => {
    if (!request || !preview) return;
    setError(null);
    void applyMutation
      .mutateAsync(request)
      .then(() => {
        setDirty(false);
        setRequest(null);
        setPreview(null);
        onApplied();
      })
      .catch((reasonValue) => {
        setError(reasonValue instanceof ApiError && reasonValue.status === 409 ? "conflict" : "apply");
      });
  };

  return (
    <div
      className="space-y-4 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4"
      aria-label={t("ui.game.campaignWiki.create.title", { defaultValue: "Add record" })}
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-base font-semibold">
          {t("ui.game.campaignWiki.create.title", { defaultValue: "Add record" })}
        </h4>
        <button type="button" onClick={close} disabled={busy} className="min-h-10 rounded-md px-3 text-sm">
          {t("ui.game.campaignWiki.editor.cancel", { defaultValue: "Cancel" })}
        </button>
      </div>
      <SelectField
        label={t("ui.game.campaignWiki.create.type", { defaultValue: "Record type" })}
        value={kind}
        onChange={(value) => changeKind(value as RecordKind)}
        disabled={busy}
      >
        <option value="fact">{t("ui.game.campaignWiki.create.fact", { defaultValue: "Fact" })}</option>
        {(entity.kind === "character" || entity.kind === "persona") && (
          <option value="knowledge">{t("ui.game.campaignWiki.create.knowledge", { defaultValue: "Knowledge" })}</option>
        )}
        <option value="relationship">
          {t("ui.game.campaignWiki.create.relationship", { defaultValue: "Relationship" })}
        </option>
        <option value="entity">{t("ui.game.campaignWiki.create.entity")}</option>
      </SelectField>
      {kind === "fact" && (
        <>
          <TextField
            label={t("ui.game.campaignWiki.editor.predicate")}
            value={predicate}
            onChange={edit(setPredicate)}
            disabled={busy}
            required
          />
          <TextField
            label={t("ui.game.campaignWiki.editor.value")}
            value={factValue}
            onChange={edit(setFactValue)}
            disabled={busy}
            required
          />
          <TextField
            label={t("ui.game.campaignWiki.create.conditions")}
            value={conditions}
            onChange={edit(setConditions)}
            disabled={busy}
          />
          <SelectField
            label={t("ui.game.campaignWiki.editor.status")}
            value={factStatus}
            onChange={(value) => edit(setFactStatus)(value as CampaignMemoryFact["status"])}
            disabled={busy}
          >
            {["proposed", "verified", "superseded", "held", "retracted"].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </SelectField>
        </>
      )}
      {kind === "knowledge" && (
        <>
          <SelectField
            label={t("ui.game.campaignWiki.create.verifiedFact", { defaultValue: "Existing verified fact" })}
            value={factId}
            onChange={edit(setFactId)}
            disabled={busy}
          >
            <option value="">
              {t("ui.game.campaignWiki.create.chooseFact", { defaultValue: "Choose a verified fact" })}
            </option>
            {verifiedFacts.map((fact) => (
              <option key={fact.factId} value={fact.factId}>
                {fact.predicate} · {fact.factId}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("ui.game.campaignWiki.create.epistemicState", { defaultValue: "Epistemic state" })}
            value={holderState}
            onChange={(value) => edit(setHolderState)(value as CampaignMemoryKnowledge["epistemicState"])}
            disabled={busy}
          >
            {(["knows", "believes", "rumor"] as const).map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </SelectField>
          <p className="text-xs text-[var(--muted-foreground)]">
            {t("ui.game.campaignWiki.create.manualKnowledge", {
              defaultValue: "Knowledge is manual and has no inferred source.",
            })}
          </p>
        </>
      )}
      {kind === "relationship" && (
        <>
          <TextField
            label={t("ui.game.campaignWiki.create.targetSearch", { defaultValue: "Search existing target" })}
            value={targetQuery}
            onChange={(value) => {
              setTargetQuery(value);
              setTargetId("");
              invalidate();
              setDirty(true);
            }}
            disabled={busy}
          />
          <SelectField
            label={t("ui.game.campaignWiki.create.target", { defaultValue: "Target entity" })}
            value={targetId}
            onChange={edit(setTargetId)}
            disabled={busy}
          >
            <option value="">
              {t("ui.game.campaignWiki.create.chooseTarget", { defaultValue: "Choose a target" })}
            </option>
            {(targets.data?.items ?? [])
              .filter((candidate) => candidate.entityId !== entity.entityId)
              .map((candidate: CampaignMemoryEntity) => (
                <option key={candidate.entityId} value={candidate.entityId}>
                  {candidate.aliases[0] || candidate.entityId} · {candidate.entityId}
                </option>
              ))}
          </SelectField>
          {targets.isLoading && (
            <p className="text-xs text-[var(--muted-foreground)]">
              {t("ui.game.campaignWiki.create.searching", { defaultValue: "Searching…" })}
            </p>
          )}
          <TextField
            label={t("ui.game.campaignWiki.create.relationshipLabel", { defaultValue: "Relationship label" })}
            value={relationshipType}
            onChange={edit(setRelationshipType)}
            disabled={busy}
            required
          />
          <TextField
            label={t("ui.game.campaignWiki.create.inverseLabel", { defaultValue: "Inverse label" })}
            value={inverseLabel}
            onChange={edit(setInverseLabel)}
            disabled={busy}
            required
          />
          <SelectField
            label={t("ui.game.campaignWiki.editor.status")}
            value={relationshipStatus}
            onChange={(value) => edit(setRelationshipStatus)(value as CampaignMemoryRelationshipStatus)}
            disabled={busy}
          >
            {["proposed", "active", "ended", "held"].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </SelectField>
        </>
      )}
      {kind === "entity" && (
        <>
          <SelectField
            label={t("ui.game.campaignWiki.create.entityKind")}
            value={entityKind}
            onChange={(value) => {
              edit(setEntityKind)(value as CreatableEntityKind);
              setOwnerRecordId("");
            }}
            disabled={busy}
          >
            {CREATABLE_ENTITY_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(`ui.game.campaignWiki.kind.${candidate}`, { defaultValue: candidate })}
              </option>
            ))}
          </SelectField>
          <TextField
            label={t("ui.game.campaignWiki.create.entityAliases")}
            value={entityAliases}
            onChange={edit(setEntityAliases)}
            disabled={busy}
            required
          />
          <TextField
            label={t("ui.game.campaignWiki.editor.tags")}
            value={entityTags}
            onChange={edit(setEntityTags)}
            disabled={busy}
          />
          <TextField
            label={t("ui.game.campaignWiki.editor.summary")}
            value={entitySummary}
            onChange={edit(setEntitySummary)}
            disabled={busy}
          />
          <section
            aria-label={t("ui.game.campaignWiki.create.owner")}
            className="space-y-2 rounded-md border border-[var(--border)] p-3 text-xs"
          >
            <p className="font-medium">{t("ui.game.campaignWiki.create.owner")}</p>
            {ownerStore ? (
              <>
                <p className="text-[var(--muted-foreground)]">
                  {t("ui.game.campaignWiki.create.ownerStore", { store: ownerStore })}
                </p>
                {/* ponytail: owner selection is by stable record ID; a candidate list from the owner stores is the upgrade path. */}
                <TextField
                  label={t("ui.game.campaignWiki.create.ownerRecordId")}
                  value={ownerRecordId}
                  onChange={edit(setOwnerRecordId)}
                  disabled={busy}
                  required
                />
                {ownerRef && ownerEntities.isLoading && (
                  <p className="text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.create.ownerChecking")}</p>
                )}
                {ownerRef && ownerEntities.isError && (
                  <p className="text-[var(--destructive)]">{t("ui.game.campaignWiki.create.ownerCheckError")}</p>
                )}
                {ownerRef && ownerEntities.data && (
                  <p className={ownerLinked ? "text-[var(--destructive)]" : "text-[var(--muted-foreground)]"}>
                    {ownerLinked
                      ? t("ui.game.campaignWiki.create.ownerLinked", {
                          name: ownerLinked.aliases[0] || ownerLinked.entityId,
                        })
                      : t("ui.game.campaignWiki.create.ownerFree")}
                  </p>
                )}
              </>
            ) : (
              <p className="text-[var(--muted-foreground)]">{t("ui.game.campaignWiki.create.ownerRegistry")}</p>
            )}
          </section>
        </>
      )}
      <TextField
        label={t("ui.game.campaignWiki.editor.reason")}
        value={reason}
        onChange={edit(setReason)}
        disabled={busy}
        required
      />
      {error && (
        <p className="text-sm text-[var(--destructive)]">
          {error === "validation"
            ? t("ui.game.campaignWiki.create.validation", { defaultValue: "Complete the required fields and reason." })
            : error === "ownerLinked"
              ? t("ui.game.campaignWiki.create.ownerLinked", {
                  name: ownerLinked?.aliases[0] || ownerLinked?.entityId || "",
                })
              : error === "conflict"
                ? t("ui.game.campaignWiki.editor.conflict")
                : error === "preview"
                  ? t("ui.game.campaignWiki.editor.previewError")
                  : t("ui.game.campaignWiki.editor.applyError")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={previewDraft}
          disabled={busy}
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
            className="min-h-10 rounded-md border border-[var(--primary)] px-3 text-sm"
          >
            {applyMutation.isPending ? t("ui.game.campaignWiki.editor.saving") : t("ui.game.campaignWiki.editor.apply")}
          </button>
        )}
      </div>
      {preview && (
        <div className="space-y-1 rounded-md border border-[var(--border)] p-3 text-xs">
          <p className="font-medium">{t("ui.game.campaignWiki.editor.changedFields")}</p>
          {Object.keys(preview.diff).length === 0 ? (
            <p>{t("ui.game.campaignWiki.editor.noChangedFields")}</p>
          ) : (
            Object.entries(preview.diff).map(([field, value]) => (
              <p key={field} className="break-words">
                <span className="font-medium">{field}:</span> {valueText(value)}
              </p>
            ))
          )}
        </div>
      )}
    </div>
  );
}
