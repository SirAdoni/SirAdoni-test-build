import { DEFAULT_IMPERSONATE_PROMPT } from "@marinara-engine/shared";

interface BuildImpersonateInstructionArgs {
  customPrompt?: unknown;
  direction?: string | null;
  personaName?: string | null;
  personaDescription?: string | null;
}

const LEGACY_IMPERSONATION_DIRECTION_PREFIXES = [
  "[Impersonation instruction — write {{user}}'s next response, steering it toward the following:",
  "[Impersonation instruction - write {{user}}'s next response, steering it toward the following:",
] as const;

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDirection(direction: string | null | undefined): string {
  const rawDirection = normalizeText(direction);
  if (!rawDirection.endsWith("]")) return rawDirection;
  const prefix = LEGACY_IMPERSONATION_DIRECTION_PREFIXES.find((candidate) => rawDirection.startsWith(candidate));
  if (!prefix || rawDirection.length === prefix.length + 1) return rawDirection;
  const normalized = rawDirection.slice(prefix.length, -1).trim();
  return normalized || rawDirection;
}

function punctuateDirection(direction: string): string {
  const trimmed = direction.trim();
  if (!trimmed) return "";

  const lastChar = trimmed[trimmed.length - 1];
  return lastChar && ".!?)]}\"'".includes(lastChar) ? trimmed : `${trimmed}.`;
}

function buildCustomImpersonateInstruction(customPrompt: string, direction: string): string {
  if (!direction) return customPrompt;
  return `${customPrompt} ${punctuateDirection(direction)}`;
}

function renderImpersonateTemplate(
  template: string,
  {
    direction,
    personaName,
    personaDescription,
  }: {
    direction: string;
    personaName: string;
    personaDescription: string;
  },
): string {
  const lineIsEmptyPlaceholderOnly = (line: string): boolean => {
    let stripped = line;
    let removedEmpty = false;
    if (!personaDescription && stripped.includes("{{persona_description}}")) {
      stripped = stripped.replaceAll("{{persona_description}}", "");
      removedEmpty = true;
    }
    if (!direction && stripped.includes("{{impersonate_direction}}")) {
      stripped = stripped.replaceAll("{{impersonate_direction}}", "");
      removedEmpty = true;
    }
    return removedEmpty && stripped.replaceAll("{{user}}", personaName).trim() === "";
  };

  return template
    .split(/\r?\n/)
    .filter((line) => !lineIsEmptyPlaceholderOnly(line))
    .map((line) =>
      line
        .replaceAll("{{user}}", personaName)
        .replaceAll("{{persona_description}}", personaDescription)
        .replaceAll("{{impersonate_direction}}", direction),
    )
    .join("\n")
    .trim();
}

export function buildImpersonateInstruction({
  customPrompt,
  direction,
  personaName,
  personaDescription,
}: BuildImpersonateInstructionArgs): string {
  const normalizedCustomPrompt = normalizeText(customPrompt);
  const impersonationDirection = normalizeDirection(direction);
  const personaLabel = normalizeText(personaName) || "{{user}}";
  const description = normalizeText(personaDescription);

  if (normalizedCustomPrompt) {
    const resolvedCustomPrompt = renderImpersonateTemplate(normalizedCustomPrompt, {
      direction: impersonationDirection,
      personaName: personaLabel,
      personaDescription: description,
    });
    return normalizedCustomPrompt.includes("{{impersonate_direction}}")
      ? resolvedCustomPrompt
      : buildCustomImpersonateInstruction(resolvedCustomPrompt, impersonationDirection);
  }

  return renderImpersonateTemplate(DEFAULT_IMPERSONATE_PROMPT, {
    direction: impersonationDirection,
    personaName: personaLabel,
    personaDescription: description,
  });
}
