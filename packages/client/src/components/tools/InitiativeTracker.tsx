// ──────────────────────────────────────────────
// Initiative and encounter tracker
// Combatants from character cards, lorebook entries or typed names; initiative
// rolled on the server and logged to the dice log; turn order, rounds, HP and
// condition notes; encounters saved per game. The turn summary goes into the
// chat input as an OOC note and is never sent on its own.
// ──────────────────────────────────────────────
import { useMemo, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Dices,
  Hourglass,
  MessageSquarePlus,
  Plus,
  Save,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  addCombatant,
  advanceTurn,
  applyInitiatives,
  createInitiativeState,
  delayCombatant,
  formatInitiativeTurnSummary,
  moveCombatant,
  normalizeInitiativeDice,
  previousTurn,
  removeCombatant,
  sameInitiativeState,
  updateCombatant,
  type InitiativeCombatant,
  type InitiativeCombatantSource,
  type InitiativeEncounterState,
} from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { formatOocNote, insertIntoChatInput } from "../../lib/chat-input-insert";
import { setInitiativeDraft, useInitiativeDraft } from "../../lib/initiative-draft";
import { useAllCharacterCatalog } from "../../hooks/use-characters";
import { useLorebookEntries, useLorebooks } from "../../hooks/use-lorebooks";
import { useInitiativeEncounters, useInitiativeMutations } from "../../hooks/use-initiative";

const FIELD_CLASS =
  "h-8 pointer-coarse:h-9 min-w-0 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const SMALL_FIELD_CLASS =
  "h-7 pointer-coarse:h-9 min-w-0 rounded-md border border-border bg-background px-1.5 text-[0.6875rem] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/40";
const ICON_BUTTON_CLASS =
  "flex h-7 w-7 pointer-coarse:h-9 pointer-coarse:w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent";
const SMALL_BUTTON_CLASS =
  "flex h-7 pointer-coarse:h-9 items-center gap-1.5 rounded-md border border-border px-2.5 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-60";
const MAX_PICKER_RESULTS = 8;

type AddMode = InitiativeCombatantSource;

function newCombatantId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function matches(name: string, query: string) {
  return !query || name.toLocaleLowerCase().includes(query);
}

function CombatantRow({
  combatant,
  active,
  first,
  last,
  rolling,
  onChange,
  onInitiative,
  onRoll,
  onMove,
  onDelay,
  onRemove,
}: {
  combatant: InitiativeCombatant;
  active: boolean;
  first: boolean;
  last: boolean;
  rolling: boolean;
  onChange: (patch: Partial<Omit<InitiativeCombatant, "id">>) => void;
  onInitiative: (value: number | null) => void;
  onRoll: () => void;
  onMove: (delta: -1 | 1) => void;
  onDelay: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [initiativeText, setInitiativeText] = useState<string | null>(null);
  const shownInitiative = initiativeText ?? (combatant.initiative === null ? "" : String(combatant.initiative));

  const commitInitiative = () => {
    if (initiativeText === null) return;
    const text = initiativeText.trim();
    setInitiativeText(null);
    const value = text === "" ? null : Number.parseInt(text, 10);
    if (value !== null && !Number.isFinite(value)) return;
    if (value !== combatant.initiative) onInitiative(value);
  };

  return (
    <li
      className={cn(
        "rounded-lg border px-2 py-1.5",
        active ? "border-primary/60 bg-primary/10" : "border-border bg-secondary/30",
      )}
      aria-current={active ? "step" : undefined}
    >
      <div className="flex items-center gap-1">
        <input
          value={shownInitiative}
          inputMode="numeric"
          onChange={(event) => setInitiativeText(event.target.value.replace(/[^\d-]/g, "").slice(0, 5))}
          onBlur={commitInitiative}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder="-"
          className={cn(SMALL_FIELD_CLASS, "w-10 shrink-0 text-center font-semibold tabular-nums")}
          aria-label={t("ui.initiative.initiativeFor", { name: combatant.name })}
        />
        {combatant.source === "character" && <User size={11} className="shrink-0 text-muted-foreground" />}
        {combatant.source === "lorebook" && <BookOpen size={11} className="shrink-0 text-muted-foreground" />}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            active ? "font-semibold text-foreground" : "text-foreground",
          )}
          title={combatant.name}
        >
          {combatant.name}
        </span>
        <span className="shrink-0 text-[0.625rem] pointer-coarse:text-[0.6875rem] tabular-nums text-muted-foreground">
          {combatant.dice}
        </span>
        <button
          type="button"
          onClick={onRoll}
          disabled={rolling}
          className={ICON_BUTTON_CLASS}
          title={t("ui.initiative.rollOne")}
          aria-label={t("ui.initiative.rollOne")}
        >
          <Dices size={13} />
        </button>
        <button
          type="button"
          onClick={onDelay}
          disabled={last}
          className={ICON_BUTTON_CLASS}
          title={t("ui.initiative.delay")}
          aria-label={t("ui.initiative.delay")}
        >
          <Hourglass size={13} />
        </button>
        <button
          type="button"
          onClick={onRemove}
          className={ICON_BUTTON_CLASS}
          title={t("ui.initiative.remove")}
          aria-label={t("ui.initiative.remove")}
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1">
        <input
          value={combatant.hp}
          onChange={(event) => onChange({ hp: event.target.value.slice(0, 60) })}
          placeholder={t("ui.initiative.hp")}
          className={cn(SMALL_FIELD_CLASS, "w-16 shrink-0")}
          aria-label={t("ui.initiative.hpFor", { name: combatant.name })}
        />
        <input
          value={combatant.notes}
          onChange={(event) => onChange({ notes: event.target.value.slice(0, 500) })}
          placeholder={t("ui.initiative.notes")}
          className={cn(SMALL_FIELD_CLASS, "flex-1")}
          aria-label={t("ui.initiative.notesFor", { name: combatant.name })}
        />
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={first}
          className={ICON_BUTTON_CLASS}
          title={t("ui.initiative.moveUp")}
          aria-label={t("ui.initiative.moveUp")}
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={last}
          className={ICON_BUTTON_CLASS}
          title={t("ui.initiative.moveDown")}
          aria-label={t("ui.initiative.moveDown")}
        >
          <ArrowDown size={13} />
        </button>
      </div>
    </li>
  );
}

function AddCombatant({
  onAdd,
}: {
  onAdd: (input: Omit<InitiativeCombatant, "id" | "initiative" | "hp" | "notes">) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AddMode>("custom");
  const [text, setText] = useState("");
  const [dice, setDice] = useState("");
  const [lorebookId, setLorebookId] = useState("");
  const characters = useAllCharacterCatalog(mode === "character");
  const lorebooks = useLorebooks(undefined);
  const entries = useLorebookEntries(mode === "lorebook" && lorebookId ? lorebookId : null);
  const query = text.trim().toLocaleLowerCase();

  const options = useMemo(() => {
    if (mode === "character") {
      return (characters.data ?? [])
        .filter((character) => matches(character.name, query))
        .slice(0, MAX_PICKER_RESULTS)
        .map((character) => ({ id: character.id, name: character.name }));
    }
    if (mode === "lorebook") {
      return (entries.data ?? [])
        .filter((entry) => entry.name && matches(entry.name, query))
        .slice(0, MAX_PICKER_RESULTS)
        .map((entry) => ({ id: entry.id, name: entry.name }));
    }
    return [];
  }, [characters.data, entries.data, mode, query]);

  const add = (name: string, sourceId: string | null) => {
    const clean = name.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const normalized = normalizeInitiativeDice(dice);
    if (!normalized) {
      toast.error(t("ui.initiative.diceInvalid"));
      return;
    }
    onAdd({ name: clean, source: mode, sourceId, dice: normalized });
    if (mode === "custom") setText("");
  };

  const modeButton = (value: AddMode, label: string) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      aria-pressed={mode === value}
      className={cn(
        "h-7 pointer-coarse:h-9 flex-1 rounded-md px-2 text-[0.6875rem] font-medium transition-colors",
        mode === value ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  const loading = (mode === "character" && characters.isLoading) || (mode === "lorebook" && entries.isLoading);

  return (
    <div className="space-y-1.5 rounded-lg border border-border p-2">
      <div className="flex gap-1" role="group" aria-label={t("ui.initiative.addFrom")}>
        {modeButton("custom", t("ui.initiative.fromName"))}
        {modeButton("character", t("ui.initiative.fromCard"))}
        {modeButton("lorebook", t("ui.initiative.fromLorebook"))}
      </div>
      {mode === "lorebook" && (
        <select
          value={lorebookId}
          onChange={(event) => setLorebookId(event.target.value)}
          className={cn(FIELD_CLASS, "w-full")}
          aria-label={t("ui.initiative.lorebook")}
        >
          <option value="">{t("ui.initiative.pickLorebook")}</option>
          {(lorebooks.data ?? []).map((lorebook) => (
            <option key={lorebook.id} value={lorebook.id}>
              {lorebook.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex gap-1.5">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key !== "Enter") return;
            if (mode === "custom") add(text, null);
            else if (options[0]) add(options[0].name, options[0].id);
          }}
          placeholder={mode === "custom" ? t("ui.initiative.namePlaceholder") : t("ui.initiative.searchPlaceholder")}
          className={cn(FIELD_CLASS, "flex-1")}
          aria-label={mode === "custom" ? t("ui.initiative.name") : t("ui.initiative.search")}
        />
        <input
          value={dice}
          onChange={(event) => setDice(event.target.value.slice(0, 20))}
          placeholder={t("ui.initiative.dicePlaceholder")}
          className={cn(FIELD_CLASS, "w-16 shrink-0")}
          title={t("ui.initiative.diceHint")}
          aria-label={t("ui.initiative.dice")}
        />
        {mode === "custom" && (
          <button
            type="button"
            onClick={() => add(text, null)}
            disabled={!text.trim()}
            className={cn(SMALL_BUTTON_CLASS, "h-8 pointer-coarse:h-9")}
          >
            <Plus size={13} />
            {t("ui.initiative.add")}
          </button>
        )}
      </div>
      {mode !== "custom" && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto">
          {loading && <li className="px-1 text-[0.6875rem] text-muted-foreground">{t("ui.initiative.loading")}</li>}
          {!loading && options.length === 0 && (mode === "character" || lorebookId) && (
            <li className="px-1 text-[0.6875rem] text-muted-foreground">{t("ui.initiative.noMatches")}</li>
          )}
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                onClick={() => add(option.name, option.id)}
                className="flex h-7 pointer-coarse:h-9 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-foreground transition-colors hover:bg-secondary"
              >
                <Plus size={12} className="shrink-0 text-muted-foreground" />
                <span className="truncate">{option.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function InitiativeTracker({ chatId }: { chatId: string }) {
  const { t } = useTranslation();
  const draft = useInitiativeDraft(chatId);
  const { state } = draft;
  const saved = useInitiativeEncounters(chatId);
  const { save, remove, roll } = useInitiativeMutations(chatId);
  const encounters = saved.data?.encounters ?? [];
  const [adding, setAdding] = useState(false);

  const setState = (update: (current: InitiativeEncounterState) => InitiativeEncounterState) =>
    setInitiativeDraft(chatId, (current) => ({ ...current, state: update(current.state) }));

  const rollFor = (combatants: InitiativeCombatant[], restart: boolean) => {
    if (combatants.length === 0) return;
    roll.mutate(
      combatants.map((combatant) => ({ id: combatant.id, name: combatant.name, dice: combatant.dice })),
      {
        onSuccess: (response) => setState((current) => applyInitiatives(current, response.totals, { restart })),
        onError: (error) => toast.error(errorText(error, t("ui.initiative.rollFailed"))),
      },
    );
  };

  const insertSummary = () => {
    const summary = formatInitiativeTurnSummary(state);
    if (!summary) return;
    insertIntoChatInput(formatOocNote(summary), chatId);
    toast.success(t("ui.initiative.inserted"));
  };

  const saveEncounter = () => {
    const name = draft.name.trim() || t("ui.initiative.untitled");
    save.mutate(
      { id: draft.encounterId, name, state },
      {
        onSuccess: (record) => {
          setInitiativeDraft(chatId, (current) => ({ ...current, encounterId: record.id, name: record.name }));
          toast.success(t("ui.initiative.saved"));
        },
        onError: (error) => toast.error(errorText(error, t("ui.initiative.saveFailed"))),
      },
    );
  };

  const loadEncounter = async (id: string) => {
    const loaded = encounters.find((encounter) => encounter.id === draft.encounterId);
    const unsaved = state.combatants.length > 0 && (!loaded || !sameInitiativeState(loaded.state, state));
    if (unsaved) {
      const confirmed = await showConfirmDialog({
        title: t("ui.initiative.discardTitle"),
        message: t("ui.initiative.discardMessage"),
        confirmLabel: t("ui.initiative.discard"),
        tone: "destructive",
      });
      if (!confirmed) return;
    }
    if (!id) {
      setInitiativeDraft(chatId, () => ({ encounterId: null, name: "", state: createInitiativeState() }));
      return;
    }
    const record = encounters.find((encounter) => encounter.id === id);
    if (record) setInitiativeDraft(chatId, () => ({ encounterId: record.id, name: record.name, state: record.state }));
  };

  const deleteEncounter = async () => {
    const record = encounters.find((encounter) => encounter.id === draft.encounterId);
    if (!record) return;
    const confirmed = await showConfirmDialog({
      title: t("ui.initiative.deleteTitle"),
      message: t("ui.initiative.deleteMessage", { name: record.name }),
      confirmLabel: t("ui.initiative.delete"),
      tone: "destructive",
    });
    if (!confirmed) return;
    remove.mutate(record.id, {
      onSuccess: () => setInitiativeDraft(chatId, (current) => ({ ...current, encounterId: null })),
      onError: (error) => toast.error(errorText(error, t("ui.initiative.deleteFailed"))),
    });
  };

  const current = state.combatants[state.turn] ?? null;
  const hasCombatants = state.combatants.length > 0;
  const loadedId = encounters.some((encounter) => encounter.id === draft.encounterId) ? draft.encounterId! : "";

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <select
          value={loadedId}
          onChange={(event) => void loadEncounter(event.target.value)}
          className={cn(FIELD_CLASS, "w-28 shrink-0 pointer-coarse:w-36")}
          aria-label={t("ui.initiative.savedEncounters")}
        >
          <option value="">{t("ui.initiative.newEncounter")}</option>
          {encounters.map((encounter) => (
            <option key={encounter.id} value={encounter.id}>
              {encounter.name}
            </option>
          ))}
        </select>
        <input
          value={draft.name}
          onChange={(event) =>
            setInitiativeDraft(chatId, (currentDraft) => ({ ...currentDraft, name: event.target.value.slice(0, 120) }))
          }
          placeholder={t("ui.initiative.encounterName")}
          className={cn(FIELD_CLASS, "flex-1")}
          aria-label={t("ui.initiative.encounterName")}
        />
        <button
          type="button"
          onClick={saveEncounter}
          disabled={save.isPending || !hasCombatants}
          className={ICON_BUTTON_CLASS}
          title={t("ui.initiative.save")}
          aria-label={t("ui.initiative.save")}
        >
          <Save size={13} />
        </button>
        {loadedId && (
          <button
            type="button"
            onClick={() => void deleteEncounter()}
            disabled={remove.isPending}
            className={ICON_BUTTON_CLASS}
            title={t("ui.initiative.delete")}
            aria-label={t("ui.initiative.delete")}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 rounded-lg border border-border bg-secondary/40 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setState(previousTurn)}
          disabled={!hasCombatants || (state.round <= 1 && state.turn === 0)}
          className={ICON_BUTTON_CLASS}
          title={t("ui.initiative.previousTurn")}
          aria-label={t("ui.initiative.previousTurn")}
        >
          <ChevronLeft size={15} />
        </button>
        <div className="min-w-0 flex-1 text-center" aria-live="polite">
          <p className="text-[0.625rem] pointer-coarse:text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
            {t("ui.initiative.round", { round: state.round })}
          </p>
          <p className="truncate text-xs font-semibold text-foreground">
            {current ? current.name : t("ui.initiative.empty")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setState(advanceTurn)}
          disabled={!hasCombatants}
          className={ICON_BUTTON_CLASS}
          title={t("ui.initiative.nextTurn")}
          aria-label={t("ui.initiative.nextTurn")}
        >
          <ChevronRight size={15} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => rollFor(state.combatants, true)}
          disabled={!hasCombatants || roll.isPending}
          className={SMALL_BUTTON_CLASS}
          title={t("ui.initiative.rollAllHint")}
        >
          <Dices size={13} />
          {t("ui.initiative.rollAll")}
        </button>
        <button type="button" onClick={insertSummary} disabled={!current} className={SMALL_BUTTON_CLASS}>
          <MessageSquarePlus size={13} />
          {t("ui.initiative.toInput")}
        </button>
        <button
          type="button"
          onClick={() => setAdding((value) => !value)}
          aria-expanded={adding}
          className={cn(SMALL_BUTTON_CLASS, adding && "bg-secondary")}
        >
          <Plus size={13} />
          {t("ui.initiative.addCombatant")}
        </button>
      </div>

      {adding && (
        <AddCombatant
          onAdd={(input) =>
            setState((currentState) =>
              addCombatant(currentState, { ...input, id: newCombatantId(), initiative: null, hp: "", notes: "" }),
            )
          }
        />
      )}

      {hasCombatants ? (
        <ol className="space-y-1">
          {state.combatants.map((combatant, index) => (
            <CombatantRow
              key={combatant.id}
              combatant={combatant}
              active={index === state.turn}
              first={index === 0}
              last={index === state.combatants.length - 1}
              rolling={roll.isPending}
              onChange={(patch) => setState((currentState) => updateCombatant(currentState, combatant.id, patch))}
              onInitiative={(value) =>
                setState((currentState) =>
                  value === null
                    ? updateCombatant(currentState, combatant.id, { initiative: null })
                    : applyInitiatives(currentState, { [combatant.id]: value }),
                )
              }
              onRoll={() => rollFor([combatant], false)}
              onMove={(delta) => setState((currentState) => moveCombatant(currentState, combatant.id, delta))}
              onDelay={() => setState((currentState) => delayCombatant(currentState, combatant.id))}
              onRemove={() => setState((currentState) => removeCombatant(currentState, combatant.id))}
            />
          ))}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">{t("ui.initiative.emptyHint")}</p>
      )}
    </div>
  );
}
