type MessageRewriteExtra = {
  proseGuardianOriginalText?: unknown;
  proseGuardianRewrittenText?: unknown;
};

export type MessageRewriteVersions = {
  originalText: string | null;
  rewrittenText: string | null;
  hasVersions: boolean;
  showingOriginal: boolean;
  alternateText: string | null;
};

/** Resolve the two durable versions behind the message shield action. */
export function resolveMessageRewriteVersions(
  content: string,
  extra: MessageRewriteExtra,
  isUser: boolean,
): MessageRewriteVersions {
  const originalText =
    !isUser && typeof extra.proseGuardianOriginalText === "string" && extra.proseGuardianOriginalText.length > 0
      ? extra.proseGuardianOriginalText
      : null;
  const storedRewrittenText =
    !isUser && typeof extra.proseGuardianRewrittenText === "string" && extra.proseGuardianRewrittenText.length > 0
      ? extra.proseGuardianRewrittenText
      : null;
  // Legacy rewrites stored only the original. The currently displayed rewrite
  // is still enough to recover the pair on the first toggle.
  const rewrittenText = storedRewrittenText ?? (originalText && content !== originalText ? content : null);
  const hasVersions = !!originalText && !!rewrittenText && originalText !== rewrittenText;
  const showingOriginal = hasVersions && content === originalText;

  return {
    originalText,
    rewrittenText,
    hasVersions,
    showingOriginal,
    alternateText: hasVersions ? (showingOriginal ? rewrittenText : originalText) : null,
  };
}
