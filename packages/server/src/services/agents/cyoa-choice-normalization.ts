const SINGLE_QUOTED_SPAN_RE =
  /(^|[\s([{—–-])'((?:[^'\r\n]|(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}]))+)'(?=$|[\s)\]},.!?;:—–-])/gmu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCyoaDialogueQuotes(text: string): string {
  return text.replace(SINGLE_QUOTED_SPAN_RE, '$1"$2"');
}

export function normalizeCyoaChoiceOutput(data: unknown): unknown {
  if (!isRecord(data) || !Array.isArray(data.choices)) return data;

  let changed = false;
  const choices = data.choices.map((choice) => {
    if (!isRecord(choice) || typeof choice.text !== "string") return choice;
    const text = normalizeCyoaDialogueQuotes(choice.text);
    if (text === choice.text) return choice;
    changed = true;
    return { ...choice, text };
  });

  return changed ? { ...data, choices } : data;
}
