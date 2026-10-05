import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Check, Loader2, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import {
  FAMILY_KINDS,
  familyCreatesCycle,
  layoutFamilyTree,
  type FamilyLink,
  type FamilyPerson,
  type FamilyTreeData,
} from "@marinara-engine/shared";
import { ApiError } from "../../lib/api-client";
import { cn, getAvatarCropStyle } from "../../lib/utils";
import { useFamilyTree, type FamilyTreeEdit } from "../../hooks/use-family-tree";
import { AvatarImage } from "../characters/AvatarImage";
import { editorButton } from "./CampaignWikiCreateRecord";

const INPUT =
  "min-h-11 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

export function FamilyTree({
  chatId,
  onOpen,
  onEditingChange,
}: {
  chatId: string;
  onOpen: (person: FamilyPerson) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const { t } = useTranslation();
  const query = useFamilyTree(chatId);
  if (query.isLoading)
    return (
      <p role="status" className="flex items-center gap-2 p-4">
        <Loader2 size={18} className="animate-spin" />
        {t("ui.familyTree.loading")}
      </p>
    );
  if (!query.data)
    return (
      <div role="alert" className="space-y-3 p-4">
        <p>{t("ui.familyTree.loadFailed")}</p>
        <button type="button" className={editorButton.secondary} onClick={() => void query.refetch()}>
          {t("ui.familyTree.retry")}
        </button>
      </div>
    );
  return (
    <FamilyTreeView
      data={query.data}
      onSave={query.save}
      saving={query.saving}
      onOpen={onOpen}
      onEditingChange={onEditingChange}
    />
  );
}

/** Kept separate from transport so browser fixtures can exercise the real editor without campaign data. */
export function FamilyTreeView({
  data,
  onSave,
  saving,
  onOpen,
  onEditingChange,
}: {
  data: FamilyTreeData;
  onSave: (edit: FamilyTreeEdit) => Promise<unknown>;
  saving: boolean;
  onOpen: (person: FamilyPerson) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState("");
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [depth, setDepth] = useState(2);
  const [draft, setDraft] = useState<FamilyTreeEdit | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const people = useMemo(() => new Map(data.people.map((person) => [person.id, person])), [data.people]);
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const person of data.people) counts.set(person.name, (counts.get(person.name) ?? 0) + 1);
    return counts;
  }, [data.people]);
  const displayName = (person: FamilyPerson) =>
    (nameCounts.get(person.name) ?? 0) > 1 ? `${person.name} (${person.owner.recordId})` : person.name;
  const focus =
    people.get(selected) ?? people.get(data.links.find((link) => link.confirmed)?.sourceId ?? "") ?? data.people[0];
  useEffect(() => {
    onEditingChange?.(!!draft || saving);
  }, [draft, saving, onEditingChange]);
  const tree = useMemo(() => layoutFamilyTree(data, focus?.id ?? "", depth), [data, focus?.id, depth]);
  const positioned = new Map(tree.nodes.map((node) => [node.person.id, node]));
  const tags = [...new Set(data.people.flatMap((person) => person.tags))].sort();
  const matches = data.people.filter(
    (person) =>
      (!tag || person.tags.includes(tag)) &&
      `${person.name} ${person.tags.join(" ")} ${person.owner.recordId}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const relevant = data.links.filter((link) => link.sourceId === focus?.id || link.targetId === focus?.id);
  const relation = (kind: FamilyLink["kind"]) =>
    t(`ui.familyTree.kind.${kind === "adoptive-parent" ? "adoptiveParent" : kind}`);
  const personName = (id: string | null) => {
    const person = id ? people.get(id) : undefined;
    return person ? displayName(person) : t(id ? "ui.familyTree.unavailable" : "ui.familyTree.unknown");
  };
  const identity = (person: FamilyPerson) => `${person.name} · ${person.owner.store} · ${person.owner.recordId}`;
  const edit = (link?: FamilyLink) => {
    setError("");
    setNotice("");
    setDraft(
      link
        ? {
            action: "save",
            id: link.id,
            revision: link.revision,
            sourceId: link.sourceId,
            targetId: link.targetId,
            kind: link.kind,
            note: link.note,
          }
        : { action: "save", sourceId: focus!.id, targetId: "", kind: "parent", note: "" },
    );
  };
  const save = async (value: FamilyTreeEdit) => {
    setError("");
    try {
      await onSave(value);
      setDraft(null);
      setNotice(t("ui.familyTree.saved"));
    } catch (failure) {
      const payload = failure instanceof ApiError ? failure.payload : undefined;
      const code =
        payload && typeof payload === "object" && "code" in payload && typeof payload.code === "string"
          ? payload.code
          : undefined;
      const key =
        code === "FAMILY_CYCLE"
          ? "cycle"
          : code === "FAMILY_DUPLICATE"
            ? "duplicate"
            : code === "FAMILY_CONFLICT" || code === "CAMPAIGN_MEMORY_CAS_MISMATCH"
              ? "conflict"
              : code === "FAMILY_SELF_LINK"
                ? "self"
                : "saveFailed";
      setError(t(`ui.familyTree.${key}`));
    }
  };
  const cycle = useMemo(
    () =>
      data.links.some(
        (link) =>
          link.confirmed &&
          familyCreatesCycle(
            data.links.filter((other) => other.id !== link.id),
            link,
          ),
      ),
    [data.links],
  );
  const origin = draft?.id ? data.links.find((link) => link.id === draft.id) : people.get(draft?.sourceId ?? "");
  if (!focus) return <p className="p-4 text-sm text-muted-foreground">{t("ui.familyTree.empty")}</p>;

  return (
    <div className="space-y-4 text-foreground" data-family-tree>
      <p className="max-w-prose text-sm text-muted-foreground">{t("ui.familyTree.description")}</p>
      <p className="max-w-prose text-xs text-muted-foreground">{t("ui.familyTree.branchPolicy")}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          {t("ui.familyTree.search")}
          <input className={INPUT} value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <label className="space-y-1 text-sm">
          {t("ui.familyTree.house")}
          <select
            aria-label={t("ui.familyTree.house")}
            className={INPUT}
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          >
            <option value="">{t("ui.familyTree.allTags")}</option>
            {tags.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          {t("ui.familyTree.center")}
          <select
            aria-label={t("ui.familyTree.center")}
            className={INPUT}
            value={focus.id}
            onChange={(event) => setSelected(event.target.value)}
          >
            {!matches.some((person) => person.id === focus.id) && <option value={focus.id}>{identity(focus)}</option>}
            {matches.map((person) => (
              <option key={person.id} value={person.id}>
                {identity(person)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {t("ui.familyTree.count", { shown: matches.length, total: data.people.length })}
          {tree.truncated && ` ${t("ui.familyTree.bounded")}`}
        </p>
        <label className="flex items-center gap-2 text-sm">
          {t("ui.familyTree.depth")}
          <select
            aria-label={t("ui.familyTree.depth")}
            className={cn(INPUT, "w-auto")}
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <button type="button" className={editorButton.primary} onClick={() => edit()} disabled={saving || !!draft}>
          <Plus size={16} />
          {t("ui.familyTree.add")}
        </button>
      </div>
      {cycle && (
        <p role="alert" className="rounded-lg border border-border p-3 text-sm">
          {t("ui.familyTree.existingCycle")}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{t("ui.familyTree.navigation")}</p>
      <div
        className="max-h-[65vh] overflow-auto rounded-xl border border-border bg-secondary/20"
        tabIndex={0}
        role="region"
        aria-label={t("ui.familyTree.diagram")}
      >
        <div className="relative" style={{ width: tree.width, height: tree.height }}>
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 text-muted-foreground"
            width={tree.width}
            height={tree.height}
          >
            {tree.edges.map((edge) => {
              const a = positioned.get(edge.sourceId)!;
              const b = positioned.get(edge.targetId!)!;
              const sameRow = a.y === b.y;
              const x1 = a.x + 90;
              const x2 = b.x + 90;
              const y1 = a.y + (sameRow || a.y < b.y ? 126 : 0);
              const y2 = b.y + (sameRow || b.y < a.y ? 126 : 0);
              return (
                <path
                  key={edge.id}
                  d={`M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2 + (sameRow ? 35 : 0)}, ${x2} ${(y1 + y2) / 2 + (sameRow ? 35 : 0)}, ${x2} ${y2}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeDasharray={sameRow ? "5 4" : undefined}
                />
              );
            })}
          </svg>
          {tree.nodes.map(({ person, x, y }) => (
            <div
              key={person.id}
              className={cn(
                "absolute flex h-[126px] w-[180px] flex-col items-center justify-center gap-1 rounded-xl border bg-card p-2",
                person.id === focus.id ? "border-primary ring-1 ring-primary" : "border-border",
              )}
              style={{ left: x, top: y }}
            >
              {person.avatarUrl ? (
                <span className="relative h-10 w-10 overflow-hidden rounded-full">
                  <AvatarImage
                    src={person.avatarUrl}
                    alt={person.name}
                    loading="lazy"
                    className="h-full w-full rounded-full object-cover"
                    style={getAvatarCropStyle(person.avatarCrop)}
                  />
                </span>
              ) : (
                <UserRound size={30} aria-hidden="true" className="text-muted-foreground" />
              )}
              <button
                type="button"
                className="line-clamp-2 min-h-8 w-full break-words text-center text-xs font-semibold hover:text-primary focus-visible:ring-2 focus-visible:ring-primary"
                onClick={() => setSelected(person.id)}
                title={identity(person)}
              >
                {displayName(person)}
              </button>
              <button
                type="button"
                disabled={!!draft || saving}
                className="inline-flex min-h-7 items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
                onClick={() => onOpen(person)}
              >
                <BookOpen size={12} />
                {t("ui.familyTree.profile")}
              </button>
            </div>
          ))}
        </div>
      </div>
      <p role="status" className="text-sm">
        {notice}
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {draft && (
        <form
          className="space-y-3 rounded-xl border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
        >
          <h3 className="font-semibold">{t("ui.familyTree.editing", { name: personName(draft.sourceId) })}</h3>
          <p className="text-xs text-muted-foreground">
            {origin?.sessionNumber !== undefined
              ? t("ui.familyTree.originSession", { number: origin.sessionNumber })
              : t("ui.familyTree.originRecord")}
          </p>
          <p className="text-xs text-muted-foreground">{t("ui.familyTree.finishEdit")}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              {t("ui.familyTree.relation")}
              <select
                aria-label={t("ui.familyTree.relation")}
                className={INPUT}
                value={draft.kind}
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, kind: event.target.value as FamilyLink["kind"] })}
              >
                {FAMILY_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {relation(kind)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              {t("ui.familyTree.relative")}
              <select
                aria-label={t("ui.familyTree.relative")}
                required={draft.targetId !== null}
                className={INPUT}
                value={draft.targetId ?? "__unknown"}
                disabled={
                  saving || data.links.some((link) => link.id === draft.id && link.recordType === "relationship")
                }
                onChange={(event) =>
                  setDraft({ ...draft, targetId: event.target.value === "__unknown" ? null : event.target.value })
                }
              >
                <option value="" disabled>
                  {t("ui.familyTree.choose")}
                </option>
                <option value="__unknown">{t("ui.familyTree.unknown")}</option>
                {data.people
                  .filter((person) => person.id !== draft.sourceId)
                  .map((person) => (
                    <option key={person.id} value={person.id}>
                      {identity(person)}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label className="block space-y-1 text-sm">
            {t("ui.familyTree.note")}
            <textarea
              aria-label={t("ui.familyTree.note")}
              className={INPUT}
              value={draft.note}
              maxLength={
                data.links.some((link) => link.id === draft.id && link.recordType === "relationship") ? 20_000 : 2_000
              }
              required={draft.targetId === null}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, note: event.target.value })}
            />
          </label>
          {draft.targetId === null && <p className="text-xs text-muted-foreground">{t("ui.familyTree.unknownHint")}</p>}
          <div className="flex gap-2">
            <button type="submit" className={editorButton.primary} disabled={saving || draft.targetId === ""}>
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
              {t("ui.familyTree.save")}
            </button>
            <button
              type="button"
              className={editorButton.secondary}
              disabled={saving}
              onClick={() => {
                setDraft(null);
                setError("");
              }}
            >
              {t("ui.familyTree.cancel")}
            </button>
          </div>
        </form>
      )}
      <section className="space-y-2" aria-label={t("ui.familyTree.links")}>
        <h3 className="font-semibold">{t("ui.familyTree.linksFor", { name: focus.name })}</h3>
        {!relevant.length && <p className="text-sm text-muted-foreground">{t("ui.familyTree.noLinks")}</p>}
        {relevant.map((link) => (
          <div key={link.id} className="flex flex-wrap items-center gap-2 border-b border-border py-3">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm">
                {personName(link.sourceId)} {relation(link.kind)} {personName(link.targetId)}
              </p>
              {link.note && (
                <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{link.note}</p>
              )}
              {!link.confirmed && <p className="text-xs text-muted-foreground">{t("ui.familyTree.needsReview")}</p>}
            </div>
            <button
              type="button"
              className={editorButton.secondary}
              disabled={saving || !!draft}
              onClick={() => edit(link)}
              aria-label={t(link.confirmed ? "ui.familyTree.edit" : "ui.familyTree.review")}
            >
              <Pencil size={14} />
              {t(link.confirmed ? "ui.familyTree.edit" : "ui.familyTree.review")}
            </button>
            <button
              type="button"
              className={cn(editorButton.ghost, "text-destructive")}
              disabled={saving || !!draft}
              aria-label={t("ui.familyTree.remove")}
              onClick={() => {
                if (window.confirm(t("ui.familyTree.removeConfirm"))) void save({ ...link, action: "remove" });
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </section>
    </div>
  );
}
