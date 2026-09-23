/** Environment-free Persona editor transition rules shared by the React editor
 * and the permanent contract regression. Keep this module limited to the pure
 * value/version precedence that already governs draft reconciliation. */

/** Order-independent structural key, so equivalent structured values do not
 * become dirty merely because their object keys were hydrated in another order. */
function stableValueKey(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
  });
}

export function personaEditorValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return stableValueKey(left) === stableValueKey(right);
}

function objectKeys<Value extends object>(value: Value): (keyof Value)[] {
  return Object.keys(value) as (keyof Value)[];
}

/** Select the sparse fields whose write-boundary values differ from baseline. */
export function personaEditorFieldsDifferingFromBaseline<Value extends object>(
  draft: Value,
  baseline: Value,
): (keyof Value)[] {
  return objectKeys(draft).filter((key) => !personaEditorValuesEqual(draft[key], baseline[key]));
}

/** Copy only selected write-boundary values into a sparse update. */
export function pickPersonaEditorFields<Value extends object>(
  values: Value,
  keys: Iterable<keyof Value>,
): Partial<Value> {
  return Object.fromEntries([...keys].map((key) => [key, values[key]])) as Partial<Value>;
}

interface AuthoritativeMergeDisposition<Field> {
  /** Submitted fields whose edit version is unchanged may adopt canonical output. */
  adopt?: ReadonlySet<Field>;
  /** Submitted fields edited after dispatch must preserve the current draft. */
  preserve?: ReadonlySet<Field>;
}

/**
 * Merge authoritative values into a draft. Explicit preservation is checked
 * first, before forced adoption and before old-baseline equality. That ordering
 * is what preserves `A → B → Save → A` when the response canonically contains B.
 */
export function mergeAuthoritativePersonaEditorDraft<Value extends object>(
  draft: Value,
  baseline: Value,
  authoritative: Value,
  disposition: AuthoritativeMergeDisposition<keyof Value> = {},
): Value {
  const adopt = disposition.adopt ?? new Set<keyof Value>();
  const preserve = disposition.preserve ?? new Set<keyof Value>();
  const next: Value = { ...draft };
  let changed = false;

  for (const key of objectKeys(draft)) {
    if (preserve.has(key)) continue;
    const locallyEdited = !personaEditorValuesEqual(draft[key], baseline[key]);
    if (locallyEdited && !adopt.has(key)) continue;
    if (personaEditorValuesEqual(draft[key], authoritative[key])) continue;
    Object.assign(next, { [key]: authoritative[key] });
    changed = true;
  }

  return changed ? next : draft;
}

/** Apply the real save-response version precedence and advance server truth. */
export function reconcileVersionedPersonaEditorSave<Value extends object>({
  draft,
  baseline,
  authoritative,
  submittedVersions,
  currentVersions,
}: {
  draft: Value;
  baseline: Value;
  authoritative: Value;
  submittedVersions: ReadonlyMap<keyof Value, number>;
  currentVersions: ReadonlyMap<keyof Value, number>;
}) {
  const adoptedFields = new Set<keyof Value>();
  const preservedFields = new Set<keyof Value>();

  for (const [key, submittedVersion] of submittedVersions) {
    if ((currentVersions.get(key) ?? 0) === submittedVersion) adoptedFields.add(key);
    else preservedFields.add(key);
  }

  return mergeAuthoritativePersonaEditorDraft(draft, baseline, authoritative, {
    adopt: adoptedFields,
    preserve: preservedFields,
  });
}
