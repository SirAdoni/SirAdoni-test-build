import { SlpMessageDetailsEditor, SlpEditableDetail, useSlpDetailEditing } from "./SlpMessageDetailsEditor";
import { Toggle } from "../../modules/settings/SlpSettingsControls";
import {
  Activity,
  BriefcaseBusiness,
  Check,
  ChevronDown,
  Coffee,
  Crown,
  Handshake,
  MessageCircle,
  Palette,
  Search,
  ShieldCheck,
  Star,
  UserRound,
} from "lucide-react";
import { SlpHeartGlyph, SlpLockGlyph, SlpSparkleGlyph } from "../../base/chrome/SlpGlyphs";
import { useState, type ReactNode } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";
import { SlpSegment } from "../../modules/chrome/SlpButton";
import { SlurpPromptDebugPanel, useDismissablePopover } from "./SlpMessageInsightParts";
export { SlurpPromptDebugPanel, useDismissablePopover };
import type { SlurpRapport, SlurpFanRelationship } from "./slp-messages-contract";

const ADULT_LEVELS = ["ordinary", "suggestive", "provocative", "intimate", "explicit"] as const;
const ADULT_LEVEL_HINT: Record<string, string> = {
  ordinary: "Ordinary conversation. Nothing adult is on the table here yet.",
  suggestive: "Flirting and innuendo. She will hint, but not more than that.",
  provocative: "Openly forward. She will say what she means.",
  intimate: "Explicitly intimate, and personal about it.",
  explicit: "No limit beyond the ones she sets herself.",
};

const PANEL_TONES = {
  accent: {
    fill: "bg-[var(--noodle-accent)]",
    track: "bg-[color-mix(in_srgb,var(--noodle-accent)_18%,transparent)]",
    text: "text-[var(--noodle-accent-foreground)]",
    ring: "ring-[color-mix(in_srgb,var(--noodle-accent)_40%,transparent)]",
  },
  good: {
    fill: "bg-emerald-500",
    track: "bg-emerald-500/18",
    text: "text-emerald-600 dark:text-emerald-400",
    ring: "ring-emerald-500/40",
  },
  warning: {
    fill: "bg-amber-500",
    track: "bg-amber-500/18",
    text: "text-amber-600 dark:text-amber-400",
    ring: "ring-amber-500/40",
  },
  serious: {
    fill: "bg-red-500",
    track: "bg-red-500/18",
    text: "text-red-600 dark:text-red-400",
    ring: "ring-red-500/40",
  },
} as const;

type PanelTone = keyof typeof PANEL_TONES;

const humanizeValue = (value: string) =>
  value.replaceAll("_", " ").replace(/\b\w/gu, (character) => character.toUpperCase());
const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
const bandWord = (value: number) => (value <= 25 ? "low" : value <= 60 ? "medium" : value <= 80 ? "high" : "urgent");
const moodWord = (mood: number) =>
  mood >= 40 ? "warm" : mood >= 10 ? "open" : mood > -25 ? "neutral" : mood > -60 ? "cooling" : "cold";

function Meter({
  label,
  value,
  tone = "accent",
  hint,
}: {
  label: string;
  value: number;
  tone?: PanelTone;
  hint?: string;
}) {
  const tones = PANEL_TONES[tone];
  const editing = useSlpDetailEditing(label);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[0.7rem] text-[var(--muted-foreground)]">{label}</span>
        <span className="min-w-0 flex-1 text-right text-[0.72rem] font-bold tabular-nums">
          <SlpEditableDetail label={label}>{value}</SlpEditableDetail>
        </span>
      </div>
      {!editing && (
        <div
          role="meter"
          aria-valuenow={clampPercent(value)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
          className={cn("h-1.5 overflow-hidden rounded-full", tones.track)}
        >
          <div
            className={cn("h-full rounded-r-[4px] transition-[width] motion-reduce:transition-none", tones.fill)}
            style={{ width: `${clampPercent(value)}%` }}
          />
        </div>
      )}
      {hint && <p className="mt-1 text-[0.65rem] leading-snug text-[var(--muted-foreground)]">{hint}</p>}
    </div>
  );
}

function DivergingBar({
  label,
  value,
  max,
  negativeLabel,
  positiveLabel,
  reading,
  fieldKey,
}: {
  label: string;
  value: number;
  max: number;
  negativeLabel?: string;
  positiveLabel?: string;
  reading?: string;
  fieldKey?: string;
}) {
  const editing = useSlpDetailEditing(fieldKey ?? label);
  const share = max > 0 ? Math.min(1, Math.abs(value) / max) : 0;
  const tones = value < 0 ? PANEL_TONES.serious : PANEL_TONES.accent;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[0.7rem] text-[var(--muted-foreground)]">{label}</span>
        <span className={cn("min-w-0 flex-1 text-right text-[0.72rem] font-bold", value < 0 && tones.text)}>
          <SlpEditableDetail label={label} fieldKey={fieldKey}>
            {reading ?? (value > 0 ? `+${value}` : String(value))}
          </SlpEditableDetail>
        </span>
      </div>
      {!editing && (
        <div className="relative h-1.5 rounded-full bg-[color-mix(in_srgb,var(--muted-foreground)_16%,transparent)]">
          <div className="absolute inset-y-[-2px] left-1/2 w-px -translate-x-1/2 bg-[var(--muted-foreground)]/45" />
          <div
            className={cn(
              "absolute inset-y-0 rounded-full transition-[width] motion-reduce:transition-none",
              tones.fill,
            )}
            style={value < 0 ? { right: "50%", width: `${share * 50}%` } : { left: "50%", width: `${share * 50}%` }}
          />
        </div>
      )}
      {(negativeLabel || positiveLabel) && (
        <div className="mt-1 flex justify-between text-[0.6rem] text-[var(--muted-foreground)]">
          <span>{negativeLabel}</span>
          <span>{positiveLabel}</span>
        </div>
      )}
    </div>
  );
}

function Stepper({ steps, current, label }: { steps: readonly string[]; current: string; label: string }) {
  const index = steps.indexOf(current);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[0.7rem] text-[var(--muted-foreground)]">{label}</span>
        <span className="min-w-0 flex-1 text-right text-[0.72rem] font-bold capitalize">
          <SlpEditableDetail label={label}>{humanizeValue(current)}</SlpEditableDetail>
        </span>
      </div>
      <ol className="flex gap-[2px]" aria-label={`${label}: ${humanizeValue(current)}`}>
        {steps.map((step, position) => (
          <li
            key={step}
            title={humanizeValue(step)}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              position <= index
                ? "bg-[var(--noodle-accent)]"
                : "bg-[color-mix(in_srgb,var(--noodle-accent)_18%,transparent)]",
            )}
          />
        ))}
      </ol>
    </div>
  );
}

function StatusRow({
  icon: Icon,
  tone,
  title,
  detail,
}: {
  icon: typeof Activity;
  tone: PanelTone;
  title: string;
  detail?: string;
}) {
  const tones = PANEL_TONES[tone];
  return (
    <div className={cn("flex items-start gap-2 rounded-xl px-2.5 py-2 ring-1 ring-inset", tones.ring)}>
      <Icon size={14} className={cn("mt-px shrink-0", tones.text)} aria-hidden="true" />
      <div className="min-w-0">
        <p className={cn("font-bold", tones.text)}>{title}</p>
        {detail && <p className="mt-0.5 leading-snug text-[var(--muted-foreground)]">{detail}</p>}
      </div>
    </div>
  );
}

function Field({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-[var(--slurp-surface-raised)] px-2.5 py-2">
      <div className="text-xs text-[var(--slurp-muted)]">{label}</div>
      <div className="mt-0.5 break-words font-bold capitalize">
        <SlpEditableDetail label={label}>{value}</SlpEditableDetail>
      </div>
      {hint && <div className="mt-1 text-[0.65rem] leading-snug text-[var(--muted-foreground)]">{hint}</div>}
    </div>
  );
}

function PanelSection({
  icon: Icon,
  title,
  summary,
  children,
  defaultOpen = false,
}: {
  icon: typeof Activity;
  title: string;
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="border-b border-[var(--noodle-divider)] last:border-b-0">
      <summary className="group flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 py-2.5 font-bold [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <Icon size={15} className="shrink-0 text-[var(--noodle-accent-foreground)]" aria-hidden="true" />
          <span className="truncate">{title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="max-w-[9rem] truncate text-right text-[0.68rem] font-normal text-[var(--muted-foreground)]">
            {summary}
          </span>
          <ChevronDown
            size={13}
            className="shrink-0 text-[var(--muted-foreground)] transition-transform group-open:rotate-180 motion-reduce:transition-none"
            aria-hidden="true"
          />
        </span>
      </summary>
      <div className="space-y-2.5 pb-3.5">{children}</div>
    </details>
  );
}

export function SlurpRapportBadge({ rapport, ownsCreator }: { rapport: SlurpRapport; ownsCreator: boolean }) {
  const { t: localizeUi } = useUiTranslation();
  if (!rapport) return null;
  const Icon = SLURP_TIER_ICONS[rapport.tier] ?? UserRound;
  return (
    <span
      title={localizeUi(
        ownsCreator ? `ui.slurp.rapport.creatorHint.${rapport.tier}` : `ui.slurp.rapport.viewerHint.${rapport.tier}`,
      )}
      aria-label={localizeUi(`ui.slurp.rapport.tier.${rapport.tier}`)}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--noodle-accent)]/15 text-[var(--noodle-accent-foreground)]"
    >
      <Icon size={12} aria-hidden="true" />
    </span>
  );
}

const SLURP_TIERS = ["stranger", "acquaintance", "regular", "favourite", "whale"] as const;
const SLURP_TIER_ICONS: Record<SlurpRapport["tier"], typeof SlpHeartGlyph> = {
  stranger: UserRound,
  acquaintance: Handshake,
  regular: Coffee,
  favourite: Star,
  whale: Crown,
};

export function SlurpTierLadder({ tier, className }: { tier: SlurpRapport["tier"]; className?: string }) {
  const { t: localizeUi } = useUiTranslation();
  const current = Math.max(0, SLURP_TIERS.indexOf(tier));
  return (
    <ol className={cn("relative grid grid-cols-5", className)}>
      <span className="absolute inset-x-[10%] top-4 h-1 rounded-full bg-[var(--slurp-outline)]" aria-hidden="true" />
      <span
        className="absolute start-[10%] top-4 h-1 rounded-full bg-[var(--noodle-accent)] transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${(current / (SLURP_TIERS.length - 1)) * 80}%` }}
        aria-hidden="true"
      />
      {SLURP_TIERS.map((step, index) => {
        const Icon = SLURP_TIER_ICONS[step];
        const reached = index <= current;
        const isCurrent = index === current;
        return (
          <li
            key={step}
            aria-current={isCurrent ? "step" : undefined}
            className="relative flex min-w-0 flex-col items-center gap-1.5"
          >
            <span
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full ring-2 transition-transform motion-reduce:transition-none",
                reached
                  ? "bg-[var(--noodle-accent)] ring-[var(--noodle-accent)] [&_svg]:!text-[var(--slurp-on-accent)]"
                  : "bg-[var(--slurp-surface-raised)] ring-[var(--slurp-outline)] [&_svg]:!text-[var(--muted-foreground)]",
                isCurrent &&
                  "scale-110 shadow-[0_0_0_4px_color-mix(in_srgb,var(--noodle-accent)_25%,transparent),0_0_18px_color-mix(in_srgb,var(--noodle-accent)_55%,transparent)]",
              )}
            >
              <Icon size={16} aria-hidden="true" />
            </span>
            <span
              className={cn(
                "w-full hyphens-auto break-words text-center text-[11px] leading-[13px]",
                isCurrent ? "font-black text-[var(--foreground)]" : "text-[var(--muted-foreground)]",
              )}
            >
              {localizeUi(`ui.slurp.rapport.tier.${step}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const ESCALATION_BLOCK_TEXT: Record<
  Exclude<NonNullable<NonNullable<SlurpFanRelationship["escalation"]>["blockedBy"]>, "top">,
  string
> = {
  falling: "Comfort or desire has dropped below this step, so it is easing back one.",
  respect: "Not thinking well enough of this fan yet.",
  resentment: "Holding a grudge against this fan.",
  posture: "Gone guarded with this fan.",
  comfort: "Not comfortable enough with this fan yet.",
  desire: "Not wanting more from this conversation right now.",
};

const PICTURE_BLOCK_TEXT: Record<NonNullable<NonNullable<SlurpFanRelationship["pictures"]>["blockedBy"]>, string> = {
  support: "Slurp Support's chat never gets pictures.",
  cooling_off: "Taking space from this conversation.",
  images_off: "This Creator's Images switch is off.",
  stance: "Not warm enough toward this fan for a picture yet.",
  energy: "Too tired for a picture right now.",
  posture: "Guarded with this fan right now.",
  comfort: "Not comfortable enough with this fan for a spicy picture.",
  respect: "Not thinking well enough of this fan for a spicy picture.",
};

export function SlurpRelationshipPanel({
  relationship,
  threadId,
  personaId,
}: {
  relationship: NonNullable<SlurpFanRelationship>;
  threadId: string | null;
  personaId: string | null;
}) {
  const editKey = `slurp2:details-edit:${personaId}:${threadId}`;
  const [editable, setEditable] = useState(() => {
    try {
      return localStorage.getItem(editKey) === "true";
    } catch {
      return false;
    }
  });
  const [advanced, setAdvanced] = useState(editable);
  const changeEditable = (value: boolean) => {
    setEditable(value);
    try {
      localStorage.setItem(editKey, String(value));
    } catch {
      /* Editing still works without storage. */
    }
  };
  const { t: localizeUi } = useUiTranslation();
  const { creatorState, threadState, availability } = relationship;
  const cooling = Boolean(relationship.coolUntil && relationship.coolUntil > new Date().toISOString());
  const mood = relationship.mood ?? 0;
  // The server's verdicts (R1-012). "top" is not a block: there is simply no step left.
  const riseBlock = relationship.escalation?.blockedBy ?? null;
  const blockedBy = riseBlock && riseBlock !== "top" ? ESCALATION_BLOCK_TEXT[riseBlock] : null;
  const pictures = relationship.pictures ?? { mode: relationship.imageMode, blockedBy: null };
  const modifiers = creatorState.modifiers ?? [];

  return (
    <SlpMessageDetailsEditor
      relationship={relationship}
      threadId={threadId}
      personaId={personaId}
      enabled={advanced && editable}
    >
      <header className="shrink-0 border-b border-[var(--noodle-divider)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold text-[var(--slurp-muted)]">Conversation overview</h2>
            <p className="mt-0.5 text-xl font-extrabold capitalize leading-[26px]">
              {humanizeValue(relationship.tier)}
            </p>
            <p className="mt-0.5 text-xs text-[var(--slurp-muted)]">
              {advanced
                ? `Rapport ${relationship.score}/100 · mood ${mood > 0 ? `+${mood}` : mood}`
                : `Where you stand with them · ${moodWord(mood)} right now`}
            </p>
          </div>
          {/* Both words are on screen, one selected. A single button that swapped its own label
              left it ambiguous whether it named the current mode or the one it would switch to. */}
          <SlpSegment
            label="Detail level"
            value={advanced ? "advanced" : "basic"}
            onChange={(value) => setAdvanced(value === "advanced")}
            options={[
              { value: "basic", label: "Basic" },
              { value: "advanced", label: "Advanced" },
            ]}
            className="shrink-0"
          />
        </div>
        <div
          className="mt-4"
          role="meter"
          aria-label={localizeUi("ui.slurp.messages.relationshipLevel", { defaultValue: "Relationship level" })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={relationship.score}
          aria-valuetext={humanizeValue(relationship.tier)}
        >
          <SlurpTierLadder tier={relationship.tier as SlurpRapport["tier"]} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 [scrollbar-gutter:stable]">
        {advanced ? (
          <div className="flex flex-col">
            <PanelSection
              icon={MessageCircle}
              title="Creator right now"
              summary={`${humanizeValue(creatorState.emotion)} · ${bandWord(creatorState.energy)} energy`}
              defaultOpen
            >
              <div className="grid grid-cols-2 gap-2">
                <Field label="Emotion" value={humanizeValue(creatorState.emotion)} />
                <Field label="Intent" value={humanizeValue(creatorState.intent)} />
              </div>
              <Meter label="Energy" value={creatorState.energy} hint="Effort available for replies and pictures." />
              <Meter
                label="Arousal"
                value={creatorState.arousal}
                tone="warning"
                hint="Sexual attention. It is never permission on its own."
              />
              <Meter label="Emotion intensity" value={creatorState.emotionIntensity} />
              <Meter
                label="Exposure"
                value={creatorState.exposure}
                tone="warning"
                hint="How far out on a limb she is in public. It fades overnight."
              />
              <div>
                <p className="mb-1 text-[0.7rem] text-[var(--muted-foreground)]">True right now ({modifiers.length})</p>
                <SlpEditableDetail label="True right now">
                  {modifiers.length === 0 ? (
                    <p className="text-[0.68rem] text-[var(--muted-foreground)]">Nothing in particular today.</p>
                  ) : (
                    <ul className="flex flex-wrap gap-1.5">
                      {modifiers.map((modifier) => (
                        <li
                          key={`${modifier.kind}-${modifier.until}`}
                          title={modifier.source || undefined}
                          className="rounded-full bg-[color-mix(in_srgb,var(--noodle-accent)_15%,transparent)] px-2 py-0.5 text-[0.65rem] font-bold text-[var(--noodle-accent-foreground)]"
                        >
                          {humanizeValue(modifier.kind)}
                        </li>
                      ))}
                    </ul>
                  )}
                </SlpEditableDetail>
              </div>
            </PanelSection>

            <PanelSection
              icon={SlpSparkleGlyph}
              title="This conversation"
              summary={`${humanizeValue(threadState.posture)} · ${humanizeValue(threadState.adultLevel)}`}
              defaultOpen
            >
              <DivergingBar
                label="Mood"
                value={mood}
                max={100}
                negativeLabel="Cold"
                positiveLabel="Warm"
                reading={`${mood > 0 ? `+${mood}` : mood} · ${humanizeValue(moodWord(mood))}`}
              />
              <Stepper steps={ADULT_LEVELS} current={threadState.adultLevel} label="Adult level" />
              <p className="text-[0.65rem] leading-snug text-[var(--muted-foreground)]">
                {ADULT_LEVEL_HINT[threadState.adultLevel]} It rises one step at a time and never skips.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Posture" value={humanizeValue(threadState.posture)} />
                <Field label="Strikes" value={String(relationship.strikes)} />
              </div>
              <Meter label="Conversation desire" value={threadState.threadDesire} tone="warning" />
              <Meter label="Familiarity" value={threadState.familiarity} />
            </PanelSection>

            <PanelSection
              icon={ShieldCheck}
              title="Boundaries and trust"
              summary={blockedBy ? "Escalation blocked" : "Escalation allowed"}
              defaultOpen={Boolean(blockedBy) || cooling}
            >
              <StatusRow
                icon={ShieldCheck}
                tone={blockedBy ? "serious" : "good"}
                title={blockedBy ? "Adult escalation blocked" : "Adult escalation allowed"}
                detail={
                  blockedBy ??
                  (riseBlock === "top"
                    ? "Already at the top step."
                    : "Comfort, respect and posture all clear the bar she sets.")
                }
              />
              {cooling && (
                <StatusRow
                  icon={SlpLockGlyph}
                  tone="warning"
                  title="Taking space from this conversation"
                  detail="She is not answering until the cool-off ends."
                />
              )}
              <Field label="Cool-off until" value={relationship.coolUntil ?? "Not cooling off"} />
              <Meter
                label="Sexual comfort"
                value={threadState.sexualComfort}
                tone={threadState.sexualComfort < 36 ? "serious" : "accent"}
              />
              <Meter
                label="Respect"
                value={threadState.respect}
                tone={threadState.respect < 36 ? "serious" : "accent"}
              />
              <Meter label="Emotional trust" value={threadState.emotionalTrust} />
              <Meter
                label="Resentment"
                value={threadState.resentment}
                tone={threadState.resentment > 60 ? "serious" : "warning"}
              />
            </PanelSection>

            <PanelSection
              icon={BriefcaseBusiness}
              title="Rapport breakdown"
              summary={`${relationship.score}/100 · ${relationship.spentCoins} coins`}
            >
              <div className="grid grid-cols-2 gap-2">
                <Field label="Tier" value={humanizeValue(relationship.tier)} />
                <Field label="Spent" value={`${relationship.spentCoins} coins`} />
              </div>
              {relationship.contributions.length === 0 ? (
                <p className="text-[0.68rem] text-[var(--muted-foreground)]">Nothing has moved the score yet.</p>
              ) : (
                <div className="space-y-2">
                  {[...relationship.contributions]
                    .sort((left, right) => Math.abs(right.points) - Math.abs(left.points))
                    .map((entry) => (
                      <DivergingBar
                        key={entry.key}
                        fieldKey={`contribution:${entry.key}`}
                        label={entry.detail}
                        value={entry.points}
                        max={Math.max(...relationship.contributions.map((row) => Math.abs(row.points)), 1)}
                      />
                    ))}
                </div>
              )}
            </PanelSection>

            <PanelSection icon={Activity} title="Context" summary={availability.online ? "Available" : "Away"}>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Availability" value={availability.online ? "Available" : "Away"} />
                <Field label="Activity" value={availability.activity ?? "Nothing recorded"} />
                {(editable || (availability.minutesUntilOnline !== null && !availability.online)) && (
                  <Field
                    label="Back in"
                    value={
                      (availability.minutesUntilOnline ?? 0) < 60
                        ? `~${Math.round(availability.minutesUntilOnline ?? 0)}min`
                        : `~${Math.round((availability.minutesUntilOnline ?? 0) / 60)}hr`
                    }
                  />
                )}
                <Field label="Audience tone" value={humanizeValue(relationship.audienceTone)} />
                <Field
                  label="Pictures"
                  value={pictures.mode === "none" ? "Not now" : humanizeValue(pictures.mode)}
                  hint={pictures.blockedBy ? PICTURE_BLOCK_TEXT[pictures.blockedBy] : undefined}
                />
              </div>
              <Field label="Day vibe" value={relationship.dayVibe ?? "An ordinary day"} />
            </PanelSection>

            <PanelSection icon={Search} title="Exact values" summary="Every figure, as text">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 tabular-nums">
                {(
                  [
                    ["Rapport", `${relationship.score}/100`],
                    ["Mood", String(mood)],
                    ["Energy", String(creatorState.energy)],
                    ["Arousal", String(creatorState.arousal)],
                    ["Exposure", String(creatorState.exposure)],
                    ["Emotion intensity", String(creatorState.emotionIntensity)],
                    ["Familiarity", String(threadState.familiarity)],
                    ["Sexual comfort", String(threadState.sexualComfort)],
                    ["Emotional trust", String(threadState.emotionalTrust)],
                    ["Respect", String(threadState.respect)],
                    ["Resentment", String(threadState.resentment)],
                    ["Conversation desire", String(threadState.threadDesire)],
                    ["Strikes", String(relationship.strikes)],
                    ["Spent", `${relationship.spentCoins} coins`],
                  ] as const
                ).map(([term, value]) => (
                  <div
                    key={term}
                    className={cn(
                      "flex justify-between gap-2 border-b border-[var(--noodle-divider)] py-0.5",
                      editable && "flex-col",
                    )}
                  >
                    <dt className="text-[var(--muted-foreground)]">{term}</dt>
                    <dd className="min-w-0 flex-1 text-right font-bold">
                      <SlpEditableDetail label={term}>{value}</SlpEditableDetail>
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-[0.65rem] text-[var(--muted-foreground)]">
                Creator state updated{" "}
                <SlpEditableDetail label="Creator updated at">{creatorState.updatedAt}</SlpEditableDetail>. Conversation
                state updated{" "}
                <SlpEditableDetail label="Conversation updated at">{threadState.updatedAt}</SlpEditableDetail>.
              </p>
            </PanelSection>
            <Toggle
              compact
              label={localizeUi("ui.slurp.messages.editDetails")}
              value={editable}
              onChange={changeEditable}
              disabledReason={
                !threadId || !personaId ? localizeUi("ui.slurp.messages.editDetailsNeedsThread") : undefined
              }
            />
          </div>
        ) : (
          <div className="flex flex-col">
            <PanelSection icon={SlpSparkleGlyph} title="Right now" summary={humanizeValue(moodWord(mood))} defaultOpen>
              <DivergingBar
                label="How this conversation is going"
                value={mood}
                max={100}
                negativeLabel="Cold"
                positiveLabel="Warm"
                reading={humanizeValue(moodWord(mood))}
              />
              {cooling ? (
                <StatusRow
                  icon={SlpLockGlyph}
                  tone="warning"
                  title="Taking space from this conversation"
                  detail="Give them some time. They will pick it back up afterwards."
                />
              ) : (
                <StatusRow
                  icon={availability.online ? Check : Activity}
                  tone={availability.online ? "good" : "accent"}
                  title={availability.online ? "Around right now" : "Away right now"}
                  detail={
                    availability.activity ?? (availability.online ? undefined : "They will answer when they are back.")
                  }
                />
              )}
              {(modifiers.length > 0 || relationship.dayVibe) && (
                <div>
                  <p className="mb-1 text-[0.7rem] text-[var(--muted-foreground)]">What is going on for them today</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {modifiers.map((modifier) => (
                      <li
                        key={`${modifier.kind}-${modifier.until}`}
                        className="rounded-full bg-[color-mix(in_srgb,var(--noodle-accent)_15%,transparent)] px-2 py-0.5 text-[0.65rem] font-bold text-[var(--noodle-accent-foreground)]"
                      >
                        {humanizeValue(modifier.kind)}
                      </li>
                    ))}
                  </ul>
                  {relationship.dayVibe && (
                    <p className="mt-1.5 text-[0.68rem] leading-snug text-[var(--muted-foreground)]">
                      {relationship.dayVibe}
                    </p>
                  )}
                </div>
              )}
            </PanelSection>

            <PanelSection
              icon={ShieldCheck}
              title="What can happen here"
              summary={humanizeValue(threadState.adultLevel)}
              defaultOpen
            >
              <Stepper steps={ADULT_LEVELS} current={threadState.adultLevel} label="How far this has got" />
              <p className="text-[0.68rem] leading-snug text-[var(--muted-foreground)]">
                {ADULT_LEVEL_HINT[threadState.adultLevel]}
              </p>
              <StatusRow
                icon={blockedBy ? SlpLockGlyph : SlpHeartGlyph}
                tone={blockedBy ? "warning" : "good"}
                title={
                  blockedBy
                    ? "This is as far as it goes for now"
                    : riseBlock === "top"
                      ? "This has gone as far as it goes"
                      : "There is room for this to go further"
                }
                detail={
                  blockedBy
                    ? `${blockedBy} It moves when that does, and it never skips a step.`
                    : "It rises a step at a time, and only while they are somebody she wants and thinks well of."
                }
              />
              <StatusRow
                icon={Palette}
                tone={pictures.mode === "none" ? "accent" : "good"}
                title={pictures.mode === "none" ? "Not sending pictures right now" : "Open to sending pictures"}
                detail={
                  pictures.blockedBy
                    ? PICTURE_BLOCK_TEXT[pictures.blockedBy]
                    : pictures.mode === "none"
                      ? "This changes as the conversation warms up."
                      : "She will send one if the conversation calls for it."
                }
              />
            </PanelSection>

            <PanelSection
              icon={BriefcaseBusiness}
              title="Between you"
              summary={`${relationship.spentCoins} coins spent`}
            >
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="Where you stand"
                  value={humanizeValue(relationship.tier)}
                  hint="It moves with time, conversation and what you have spent."
                />
                <Field label="Spent with them" value={`${relationship.spentCoins} coins`} />
              </div>
              {relationship.strikes > 0 && (
                <StatusRow
                  icon={SlpLockGlyph}
                  tone="warning"
                  title={`${relationship.strikes} strike${relationship.strikes === 1 ? "" : "s"} on this conversation`}
                  detail="Two inside a fortnight and they stop answering for good."
                />
              )}
            </PanelSection>
          </div>
        )}
      </div>
    </SlpMessageDetailsEditor>
  );
}
