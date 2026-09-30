import type { ReactNode } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { SlurpStageProfileInput } from "../../base/state/slp-state-types";
import { textareaClass } from "../../modules/post/SlpPostHelpers";
import { SlpTextAssist } from "../assist/slp-assist-contract";
import type { SlpAssistField } from "../../../../../shared/src/slp/slp-actions.js";

/** A field's label with the AI assist beside it. A div, not a label: the assist has buttons. */
export function SlpAssistedField({
  label,
  field,
  value,
  onApply,
  accountId,
  context,
  className = "space-y-1",
  children,
}: {
  label: string;
  field: SlpAssistField;
  value: string;
  onApply: (text: string) => void;
  accountId?: string;
  context?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="text-xs font-semibold">{label}</span>
        <SlpTextAssist field={field} value={value} onApply={onApply} accountId={accountId} context={context} />
      </div>
      {children}
    </div>
  );
}

/**
 * What this Creator looks like and where her life happens.
 *
 * Its own component because the stage-profile form is at the size limit, and because these three
 * belong together: they are the facts that stay the same between posts, as opposed to the voice
 * and the bio, which are how she sounds.
 */
export function SlurpStageFactsFields({
  draft,
  disabled,
  onChange,
  accountId,
}: {
  draft: SlurpStageProfileInput;
  disabled: boolean;
  onChange: (patch: Partial<SlurpStageProfileInput>) => void;
  /** The Creator, when it exists already: the assist writes from who they are. */
  accountId?: string;
}) {
  const { t: localizeUi } = useUiTranslation();
  const who = draft.displayName.trim() ? `For ${draft.displayName.trim()}. ` : "";
  return (
    <>
      {/* What she looks like and where her life happens, stored on the Creator.
        Appearance is the one that stops her being a different person in every picture: it is
        sent with every image whether or not the source card is being used. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <SlpAssistedField
          className="space-y-1 sm:col-span-2"
          label={localizeUi("ui.slurp.stageProfile.appearance", { defaultValue: "Appearance" })}
          field="facts"
          value={draft.appearance ?? ""}
          accountId={accountId}
          context={`${who}This field is their appearance: body, face, hair, marks.`}
          onApply={(text) => onChange({ appearance: text })}
        >
          <textarea
            aria-label={localizeUi("ui.slurp.stageProfile.appearance", { defaultValue: "Appearance" })}
            rows={3}
            disabled={disabled}
            value={draft.appearance ?? ""}
            maxLength={2000}
            onChange={(event) => onChange({ appearance: event.target.value })}
            placeholder={localizeUi("ui.slurp.stageProfile.appearancePlaceholder", {
              defaultValue: "Body, face, hair, marks: the things that must look the same in every picture.",
            })}
            className={`${textareaClass} !min-h-0`}
          />
          <span className="block text-[0.7rem] leading-5 text-[var(--muted-foreground)]">
            {localizeUi("ui.slurp.stageProfile.appearanceDetail", {
              defaultValue: "Sent with every picture. Left empty, the image model invents somebody new each post.",
            })}
          </span>
        </SlpAssistedField>
        <SlpAssistedField
          label={localizeUi("ui.slurp.stageProfile.wardrobe", { defaultValue: "Usual wardrobe" })}
          field="facts"
          value={draft.wardrobe ?? ""}
          accountId={accountId}
          context={`${who}This field is what they usually wear, at home and out.`}
          onApply={(text) => onChange({ wardrobe: text })}
        >
          <textarea
            aria-label={localizeUi("ui.slurp.stageProfile.wardrobe", { defaultValue: "Usual wardrobe" })}
            rows={2}
            disabled={disabled}
            value={draft.wardrobe ?? ""}
            maxLength={2000}
            onChange={(event) => onChange({ wardrobe: event.target.value })}
            placeholder={localizeUi("ui.slurp.stageProfile.wardrobePlaceholder", {
              defaultValue: "What she actually wears, at home and out.",
            })}
            className={`${textareaClass} !min-h-0`}
          />
        </SlpAssistedField>
        <SlpAssistedField
          label={localizeUi("ui.slurp.stageProfile.locations", { defaultValue: "Where her life happens" })}
          field="facts"
          value={draft.locations ?? ""}
          accountId={accountId}
          context={`${who}This field is where their life happens: home, where they shoot, places they end up.`}
          onApply={(text) => onChange({ locations: text })}
        >
          <textarea
            aria-label={localizeUi("ui.slurp.stageProfile.locations", { defaultValue: "Where her life happens" })}
            rows={2}
            disabled={disabled}
            value={draft.locations ?? ""}
            maxLength={2000}
            onChange={(event) => onChange({ locations: event.target.value })}
            placeholder={localizeUi("ui.slurp.stageProfile.locationsPlaceholder", {
              defaultValue: "Her flat, where she shoots, the places she keeps ending up.",
            })}
            className={`${textareaClass} !min-h-0`}
          />
        </SlpAssistedField>
      </div>
    </>
  );
}
