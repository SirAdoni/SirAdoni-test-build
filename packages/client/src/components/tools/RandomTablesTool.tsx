// ──────────────────────────────────────────────
// Random tables and the yes/no oracle
// Roll GM tables (weighted or on dice, with [[nested]] tables), ask the oracle,
// then copy the result, drop it into the chat input as an OOC note, or log it
// to the game's dice history. Tables are edited as plain text, one row a line.
// ──────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  Copy,
  Dices,
  Download,
  HelpCircle,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ORACLE_LIKELIHOODS,
  buildRandomTableExport,
  formatPlainTableList,
  parsePlainTableList,
  parseTableDice,
  type OracleLikelihood,
  type OracleOutcome,
  type TableRollResult,
} from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { formatOocNote, insertIntoChatInput } from "../../lib/chat-input-insert";
import { useLorebooks } from "../../hooks/use-lorebooks";
import {
  useLorebookTableSources,
  useRandomTableMutations,
  useRandomTableRolls,
  useRandomTables,
  type RandomTableRecord,
  type RandomTableScope,
} from "../../hooks/use-random-tables";

const FIELD_CLASS =
  "h-8 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const ICON_BUTTON_CLASS =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50";
const SMALL_BUTTON_CLASS =
  "flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60";
const LABEL_CLASS = "text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground";
const LOG_PREF_KEY = "marinara-random-tables-log";
const IMPORT_MAX_BYTES = 16 * 1024 * 1024;

const LIKELIHOOD_KEYS: Record<OracleLikelihood, string> = {
  certain: "ui.randomTables.likelihoodCertain",
  likely: "ui.randomTables.likelihoodLikely",
  even: "ui.randomTables.likelihoodEven",
  unlikely: "ui.randomTables.likelihoodUnlikely",
  impossible: "ui.randomTables.likelihoodImpossible",
};

const OUTCOME_KEYS: Record<OracleOutcome, string> = {
  yes_and: "ui.randomTables.outcomeYesAnd",
  yes: "ui.randomTables.outcomeYes",
  yes_but: "ui.randomTables.outcomeYesBut",
  no_but: "ui.randomTables.outcomeNoBut",
  no: "ui.randomTables.outcomeNo",
  no_and: "ui.randomTables.outcomeNoAnd",
};

type RollOutput =
  | { kind: "table"; line: string; result: TableRollResult }
  | { kind: "oracle"; line: string; outcome: OracleOutcome; roll: number; chance: number };

type Panel =
  | { kind: "none" }
  | { kind: "edit"; id: string | null; name: string; dice: string; scope: RandomTableScope; text: string }
  | { kind: "lorebook" };

function readLogPreference(): boolean {
  try {
    return localStorage.getItem(LOG_PREF_KEY) === "true";
  } catch {
    return false;
  }
}

function writeLogPreference(value: boolean) {
  try {
    localStorage.setItem(LOG_PREF_KEY, value ? "true" : "false");
  } catch {
    /* ignore */
  }
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function NestedRolls({ result }: { result: TableRollResult }) {
  if (result.nested.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 border-l border-border pl-2">
      {result.nested.map((child, index) => (
        <li key={`${child.tableName}-${index}`} className="text-[0.625rem] text-muted-foreground">
          <span className="font-medium text-foreground/80">{child.tableName}</span> ({child.notation}: {child.total}){" "}
          {child.text}
          <NestedRolls result={child} />
        </li>
      ))}
    </ul>
  );
}

function LorebookBuilder({
  canScopeToGame,
  onCreate,
  onCancel,
  pending,
}: {
  canScopeToGame: boolean;
  onCreate: (input: {
    name: string;
    lorebookId: string;
    folderId: string | null;
    tag: string | null;
    includeSubfolders: boolean;
    scope: RandomTableScope;
  }) => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const lorebooks = useLorebooks(undefined);
  const [lorebookId, setLorebookId] = useState("");
  const [source, setSource] = useState("");
  const [includeSubfolders, setIncludeSubfolders] = useState(true);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<RandomTableScope>(canScopeToGame ? "game" : "global");
  const sources = useLorebookTableSources(lorebookId || null);

  useEffect(() => setSource(""), [lorebookId]);

  const sourceLabel = useMemo(() => {
    if (source.startsWith("folder:")) {
      return sources.data?.folders.find((folder) => `folder:${folder.id}` === source)?.name ?? "";
    }
    return source.startsWith("tag:") ? source.slice(4) : "";
  }, [source, sources.data]);

  const submit = () => {
    if (!lorebookId || !source) return;
    onCreate({
      name: name.trim() || sourceLabel || t("ui.randomTables.untitled"),
      lorebookId,
      folderId: source.startsWith("folder:") ? source.slice(7) : null,
      tag: source.startsWith("tag:") ? source.slice(4) : null,
      includeSubfolders,
      scope,
    });
  };

  return (
    <div className="space-y-2 rounded-lg border border-border p-2.5">
      <p className="text-[0.6875rem] leading-snug text-muted-foreground">{t("ui.randomTables.lorebookHint")}</p>
      <select
        className={cn(FIELD_CLASS, "w-full")}
        value={lorebookId}
        onChange={(event) => setLorebookId(event.target.value)}
        aria-label={t("ui.randomTables.lorebook")}
      >
        <option value="">{t("ui.randomTables.pickLorebook")}</option>
        {(lorebooks.data ?? []).map((book) => (
          <option key={book.id} value={book.id}>
            {book.name}
          </option>
        ))}
      </select>
      {lorebookId && (
        <select
          className={cn(FIELD_CLASS, "w-full")}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          aria-label={t("ui.randomTables.lorebookSource")}
          disabled={sources.isLoading}
        >
          <option value="">
            {sources.isLoading ? t("ui.randomTables.loading") : t("ui.randomTables.pickFolderOrTag")}
          </option>
          {(sources.data?.folders.length ?? 0) > 0 && (
            <optgroup label={t("ui.randomTables.folders")}>
              {sources.data!.folders.map((folder) => (
                <option key={folder.id} value={`folder:${folder.id}`}>
                  {folder.name} ({folder.entryCount})
                </option>
              ))}
            </optgroup>
          )}
          {(sources.data?.tags.length ?? 0) > 0 && (
            <optgroup label={t("ui.randomTables.tags")}>
              {sources.data!.tags.map((tag) => (
                <option key={tag.tag} value={`tag:${tag.tag}`}>
                  {tag.tag} ({tag.count})
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}
      {source.startsWith("folder:") && (
        <label className="flex cursor-pointer items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <input
            type="checkbox"
            checked={includeSubfolders}
            onChange={(event) => setIncludeSubfolders(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          {t("ui.randomTables.includeSubfolders")}
        </label>
      )}
      <div className="flex gap-1.5">
        <input
          className={cn(FIELD_CLASS, "flex-1")}
          value={name}
          maxLength={120}
          placeholder={sourceLabel || t("ui.randomTables.tableName")}
          onChange={(event) => setName(event.target.value)}
          aria-label={t("ui.randomTables.tableName")}
        />
        {canScopeToGame && (
          <select
            className={FIELD_CLASS}
            value={scope}
            onChange={(event) => setScope(event.target.value as RandomTableScope)}
            aria-label={t("ui.randomTables.scope")}
          >
            <option value="game">{t("ui.randomTables.scopeGame")}</option>
            <option value="global">{t("ui.randomTables.scopeGlobal")}</option>
          </select>
        )}
      </div>
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={onCancel} className={SMALL_BUTTON_CLASS}>
          {t("ui.randomTables.cancel")}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!lorebookId || !source || pending}
          className={SMALL_BUTTON_CLASS}
        >
          {pending ? <Loader2 size={12} className="animate-spin" /> : <BookOpen size={12} />}
          {t("ui.randomTables.buildTable")}
        </button>
      </div>
    </div>
  );
}

export function RandomTablesTool({ chatId, className }: { chatId: string | null; className?: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = useRandomTables(chatId);
  const { save, remove, importTables, fromLorebook } = useRandomTableMutations(chatId);
  const { roll, oracle } = useRandomTableRolls(chatId);
  const tables = useMemo(() => data?.tables ?? [], [data?.tables]);
  const inGame = !!data?.gameId;

  const [selectedId, setSelectedId] = useState("");
  const [question, setQuestion] = useState("");
  const [likelihood, setLikelihood] = useState<OracleLikelihood>("even");
  const [output, setOutput] = useState<RollOutput | null>(null);
  const [copied, setCopied] = useState(false);
  const [logRolls, setLogRolls] = useState(readLogPreference);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = tables.find((table) => table.id === selectedId) ?? null;
  useEffect(() => {
    if (!selected && tables.length > 0) setSelectedId(tables[0]!.id);
  }, [selected, tables]);

  const shouldLog = inGame && logRolls;

  const rollSelected = () => {
    if (!selected) return;
    roll.mutate(
      { tableId: selected.id, log: shouldLog },
      {
        onSuccess: (response) => setOutput({ kind: "table", line: response.line, result: response.result }),
        onError: (error) => toast.error(errorText(error, t("ui.randomTables.rollFailed"))),
      },
    );
  };

  const askOracle = () => {
    oracle.mutate(
      { likelihood, question: question.trim(), log: shouldLog },
      {
        onSuccess: (response) =>
          setOutput({
            kind: "oracle",
            line: response.line,
            outcome: response.result.outcome,
            roll: response.result.roll,
            chance: response.result.chance,
          }),
        onError: (error) => toast.error(errorText(error, t("ui.randomTables.rollFailed"))),
      },
    );
  };

  const copyOutput = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output.line);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error(t("ui.randomTables.copyFailed"));
    }
  };

  const insertOutput = () => {
    if (!output) return;
    insertIntoChatInput(formatOocNote(output.line), chatId);
    toast.success(t("ui.randomTables.inserted"));
  };

  const openEditor = (table: RandomTableRecord | null) =>
    setPanel({
      kind: "edit",
      id: table?.id ?? null,
      name: table?.name ?? "",
      dice: table?.dice ?? "",
      scope: table ? (table.gameId ? "game" : "global") : inGame ? "game" : "global",
      text: table ? formatPlainTableList(table.rows) : "",
    });

  const editDraft = panel.kind === "edit" ? panel : null;
  const parsedDraft = useMemo(() => (editDraft ? parsePlainTableList(editDraft.text) : null), [editDraft]);
  const diceInvalid = !!editDraft?.dice.trim() && !parseTableDice(editDraft.dice);

  const saveDraft = () => {
    if (!editDraft || !parsedDraft) return;
    const name = editDraft.name.trim();
    if (!name) {
      toast.error(t("ui.randomTables.nameRequired"));
      return;
    }
    if (diceInvalid) {
      toast.error(t("ui.randomTables.diceInvalid"));
      return;
    }
    const dice = editDraft.dice.trim() || parsedDraft.dice;
    save.mutate(
      { id: editDraft.id ?? undefined, scope: editDraft.scope, table: { name, dice, rows: parsedDraft.rows } },
      {
        onSuccess: (record) => {
          setSelectedId(record.id);
          setPanel({ kind: "none" });
        },
        onError: (error) => toast.error(errorText(error, t("ui.randomTables.saveFailed"))),
      },
    );
  };

  const deleteDraft = async () => {
    if (!editDraft?.id) return;
    const confirmed = await showConfirmDialog({
      title: t("ui.randomTables.deleteTitle"),
      message: t("ui.randomTables.deleteMessage", { name: editDraft.name }),
      confirmLabel: t("ui.randomTables.delete"),
      tone: "destructive",
    });
    if (!confirmed) return;
    remove.mutate(editDraft.id, {
      onSuccess: () => setPanel({ kind: "none" }),
      onError: (error) => toast.error(errorText(error, t("ui.randomTables.saveFailed"))),
    });
  };

  const importFile = async (file: File) => {
    // The server refuses bodies over 16 MB; don't parse a file that large here first.
    if (file.size > IMPORT_MAX_BYTES) {
      toast.error(t("ui.randomTables.importFailed"));
      return;
    }
    try {
      const json: unknown = JSON.parse(await file.text());
      importTables.mutate(
        { scope: inGame ? "game" : "global", data: json },
        {
          onSuccess: (result) => toast.success(t("ui.randomTables.imported", { count: result.created.length })),
          onError: (error) => toast.error(errorText(error, t("ui.randomTables.importFailed"))),
        },
      );
    } catch {
      toast.error(t("ui.randomTables.importFailed"));
    }
  };

  const exportTables = () => {
    if (tables.length === 0) return;
    downloadJson("random-tables.json", buildRandomTableExport(tables));
  };

  return (
    <div className={cn("space-y-3", className)}>
      {/* Oracle */}
      <div className="space-y-1.5">
        <span className={LABEL_CLASS}>{t("ui.randomTables.oracle")}</span>
        <input
          className={cn(FIELD_CLASS, "w-full")}
          value={question}
          maxLength={300}
          placeholder={t("ui.randomTables.questionPlaceholder")}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && !oracle.isPending) askOracle();
          }}
          aria-label={t("ui.randomTables.question")}
        />
        <div className="flex gap-1.5">
          <select
            className={cn(FIELD_CLASS, "flex-1")}
            value={likelihood}
            onChange={(event) => setLikelihood(event.target.value as OracleLikelihood)}
            aria-label={t("ui.randomTables.likelihood")}
          >
            {ORACLE_LIKELIHOODS.map((level) => (
              <option key={level} value={level}>
                {t(LIKELIHOOD_KEYS[level])}
              </option>
            ))}
          </select>
          <button type="button" onClick={askOracle} disabled={oracle.isPending} className={SMALL_BUTTON_CLASS}>
            {oracle.isPending ? <Loader2 size={12} className="animate-spin" /> : <HelpCircle size={12} />}
            {t("ui.randomTables.ask")}
          </button>
        </div>
      </div>

      {/* Tables */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className={LABEL_CLASS}>{t("ui.randomTables.tables")}</span>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => openEditor(null)}
              className={ICON_BUTTON_CLASS}
              title={t("ui.randomTables.newTable")}
              aria-label={t("ui.randomTables.newTable")}
            >
              <Plus size={13} />
            </button>
            <button
              type="button"
              onClick={() => setPanel(panel.kind === "lorebook" ? { kind: "none" } : { kind: "lorebook" })}
              className={ICON_BUTTON_CLASS}
              title={t("ui.randomTables.fromLorebook")}
              aria-label={t("ui.randomTables.fromLorebook")}
            >
              <BookOpen size={13} />
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={importTables.isPending}
              className={ICON_BUTTON_CLASS}
              title={t("ui.randomTables.import")}
              aria-label={t("ui.randomTables.import")}
            >
              <Upload size={13} />
            </button>
            <button
              type="button"
              onClick={exportTables}
              disabled={tables.length === 0}
              className={ICON_BUTTON_CLASS}
              title={t("ui.randomTables.export")}
              aria-label={t("ui.randomTables.export")}
            >
              <Download size={13} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importFile(file);
              }}
            />
          </div>
        </div>
        {isLoading ? (
          <Loader2 size={14} className="animate-spin text-muted-foreground" />
        ) : tables.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
            {t("ui.randomTables.empty")}
          </p>
        ) : (
          <div className="flex gap-1.5">
            <select
              className={cn(FIELD_CLASS, "flex-1")}
              value={selected?.id ?? ""}
              onChange={(event) => setSelectedId(event.target.value)}
              aria-label={t("ui.randomTables.table")}
            >
              {tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                  {table.gameId ? null : (
                    <>
                      {" ("}
                      {t("ui.randomTables.scopeGlobal")}
                      {")"}
                    </>
                  )}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => openEditor(selected)}
              disabled={!selected}
              className={ICON_BUTTON_CLASS}
              title={t("ui.randomTables.editTable")}
              aria-label={t("ui.randomTables.editTable")}
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={rollSelected}
              disabled={!selected || roll.isPending}
              className={SMALL_BUTTON_CLASS}
            >
              {roll.isPending ? <Loader2 size={12} className="animate-spin" /> : <Dices size={12} />}
              {t("ui.randomTables.roll")}
            </button>
          </div>
        )}
      </div>

      {/* Result */}
      {output && (
        <div className="rounded-lg border border-border bg-secondary/40 p-2.5" aria-live="polite">
          {output.kind === "oracle" ? (
            <p className="text-sm font-semibold text-foreground">
              {t(OUTCOME_KEYS[output.outcome])}
              <span className="ml-1.5 text-[0.6875rem] font-normal text-muted-foreground">
                {t("ui.randomTables.oracleRoll", { roll: output.roll, chance: output.chance })}
              </span>
            </p>
          ) : (
            <>
              <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                {output.result.rowIndex < 0 ? t("ui.randomTables.noRow") : output.result.text}
              </p>
              <p className="mt-0.5 text-[0.625rem] text-muted-foreground">
                {output.result.tableName} ({output.result.notation}: {output.result.total})
                {output.result.unresolved.length > 0 &&
                  ` · ${t("ui.randomTables.unresolved", { names: output.result.unresolved.join(", ") })}`}
              </p>
              <NestedRolls result={output.result} />
            </>
          )}
          <div className="mt-2 flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => void copyOutput()}
              className={ICON_BUTTON_CLASS}
              title={t("ui.randomTables.copy")}
              aria-label={t("ui.randomTables.copy")}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            {chatId && (
              <button
                type="button"
                onClick={insertOutput}
                className={SMALL_BUTTON_CLASS}
                title={t("ui.randomTables.insertHint")}
              >
                <MessageSquarePlus size={12} />
                {t("ui.randomTables.insert")}
              </button>
            )}
          </div>
        </div>
      )}

      {inGame && (
        <label className="flex cursor-pointer items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <input
            type="checkbox"
            checked={logRolls}
            onChange={(event) => {
              setLogRolls(event.target.checked);
              writeLogPreference(event.target.checked);
            }}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          {t("ui.randomTables.logRolls")}
        </label>
      )}

      {/* Editor */}
      {editDraft && (
        <div className="space-y-2 rounded-lg border border-border p-2.5">
          <div className="flex gap-1.5">
            <input
              className={cn(FIELD_CLASS, "min-w-0 flex-1")}
              value={editDraft.name}
              maxLength={120}
              placeholder={t("ui.randomTables.tableName")}
              onChange={(event) => setPanel({ ...editDraft, name: event.target.value })}
              aria-label={t("ui.randomTables.tableName")}
            />
            <input
              className={cn(FIELD_CLASS, "w-20", diceInvalid && "border-[var(--destructive)]")}
              value={editDraft.dice}
              maxLength={12}
              spellCheck={false}
              placeholder={parsedDraft?.dice ?? t("ui.randomTables.dicePlaceholder")}
              onChange={(event) => setPanel({ ...editDraft, dice: event.target.value })}
              aria-label={t("ui.randomTables.dice")}
              title={t("ui.randomTables.diceHint")}
            />
          </div>
          {inGame && (
            <select
              className={cn(FIELD_CLASS, "w-full")}
              value={editDraft.scope}
              onChange={(event) => setPanel({ ...editDraft, scope: event.target.value as RandomTableScope })}
              aria-label={t("ui.randomTables.scope")}
            >
              <option value="game">{t("ui.randomTables.scopeGame")}</option>
              <option value="global">{t("ui.randomTables.scopeGlobal")}</option>
            </select>
          )}
          <textarea
            className="min-h-[7.5rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs leading-snug text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            value={editDraft.text}
            spellCheck={false}
            placeholder={t("ui.randomTables.rowsPlaceholder")}
            onChange={(event) => setPanel({ ...editDraft, text: event.target.value })}
            aria-label={t("ui.randomTables.rows")}
          />
          <p className="text-[0.625rem] leading-snug text-muted-foreground">
            {t("ui.randomTables.rowsHint")}{" "}
            {parsedDraft &&
              parsedDraft.rows.length > 0 &&
              t("ui.randomTables.rowsSummary", {
                count: parsedDraft.rows.length,
                dice: editDraft.dice.trim() || parsedDraft.dice || t("ui.randomTables.byWeight"),
              })}
          </p>
          <div className="flex items-center gap-1.5">
            {editDraft.id && (
              <button
                type="button"
                onClick={() => void deleteDraft()}
                className={cn(ICON_BUTTON_CLASS, "hover:text-[var(--destructive)]")}
                title={t("ui.randomTables.delete")}
                aria-label={t("ui.randomTables.delete")}
              >
                <Trash2 size={13} />
              </button>
            )}
            <div className="ml-auto flex gap-1.5">
              <button type="button" onClick={() => setPanel({ kind: "none" })} className={SMALL_BUTTON_CLASS}>
                {t("ui.randomTables.cancel")}
              </button>
              <button type="button" onClick={saveDraft} disabled={save.isPending} className={SMALL_BUTTON_CLASS}>
                {save.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {t("ui.randomTables.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {panel.kind === "lorebook" && (
        <LorebookBuilder
          canScopeToGame={inGame}
          pending={fromLorebook.isPending}
          onCancel={() => setPanel({ kind: "none" })}
          onCreate={(input) =>
            fromLorebook.mutate(input, {
              onSuccess: (record) => {
                setSelectedId(record.id);
                setPanel({ kind: "none" });
                toast.success(t("ui.randomTables.built", { name: record.name, count: record.rows.length }));
              },
              onError: (error) => toast.error(errorText(error, t("ui.randomTables.saveFailed"))),
            })
          }
        />
      )}
    </div>
  );
}
