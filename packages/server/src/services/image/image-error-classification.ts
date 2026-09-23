/**
 * Provider rejections caused by image safety/content policy are request-local.
 * They must remain visible to the caller without poisoning the shared endpoint's
 * background failure circuit or activating a configured fallback retry.
 */
export function isImageContentPolicyRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = message.match(/image generation failed\s*\((\d{3})\)/iu)?.[1];
  if (status && /^[45]\d\d$/u.test(status) && (Number(status) >= 500 || [401, 403, 429].includes(Number(status)))) {
    return false;
  }
  return /(?:safety[_\s-]*(?:violation|violations|filter|system|policy)|content\s+policy|moderation\s+(?:policy|blocked|rejected))/iu.test(
    message,
  );
}
