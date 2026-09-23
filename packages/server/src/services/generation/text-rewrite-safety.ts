function hasHtmlOrXmlTag(text: string): boolean {
  return /<\/?[a-zA-Z][^>]*>/.test(text);
}

function hasFencedBlock(text: string): boolean {
  return /```/.test(text);
}

/** Break a line-leading frame marker without changing the surrounding user-authored text. */
export function escapeTextRewriteFrameDelimiter(text: string, marker: string): string {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^([\\t ]*)${escapedMarker}`, "gimu");
  const safeMarker = marker.replace(/([<>]+)$/u, " $1");
  return text.replace(pattern, (_match, indentation: string) => {
    return `${indentation}${safeMarker}`;
  });
}

/** Keep user/import-authored metadata on the single prompt line assigned to it. */
export function normalizeTextRewriteFrameLabel(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/**
 * Remove model-added response padding while preserving the excerpt's exact
 * original boundary whitespace (including CRLFs and indentation).
 */
export function normalizeTextRewriteResponse(original: string, response: string): string {
  const boundaryMatch = original.match(/^(\s*)([\s\S]*?)(\s*)$/u);
  const leadingWhitespace = boundaryMatch?.[1] ?? "";
  const trailingWhitespace = boundaryMatch?.[3] ?? "";
  const trimmedResponse = response.trim();
  const fenceMatch = trimmedResponse.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/u);
  const responseBody = (!hasFencedBlock(original) && fenceMatch ? fenceMatch[1]! : trimmedResponse).trim();
  return `${leadingWhitespace}${responseBody}${trailingWhitespace}`;
}

export function textRewriteDropsProtectedMarkup(original: string | null | undefined, edited: string): boolean {
  if (!original) return false;

  const originalHasTags = hasHtmlOrXmlTag(original);
  const originalHasFences = hasFencedBlock(original);
  if (!originalHasTags && !originalHasFences) return false;

  return (originalHasTags && !hasHtmlOrXmlTag(edited)) || (originalHasFences && !hasFencedBlock(edited));
}
