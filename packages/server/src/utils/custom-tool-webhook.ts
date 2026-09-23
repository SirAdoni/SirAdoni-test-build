import { decryptApiKey, encryptApiKey } from "./crypto.js";

export const ENCRYPTED_WEBHOOK_PREFIX = "enc:v1:";

export function encryptCustomToolWebhookUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith(ENCRYPTED_WEBHOOK_PREFIX)) return value;
  return `${ENCRYPTED_WEBHOOK_PREFIX}${encryptApiKey(value)}`;
}

export function decryptCustomToolWebhookUrl(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith(ENCRYPTED_WEBHOOK_PREFIX)
    ? decryptApiKey(value.slice(ENCRYPTED_WEBHOOK_PREFIX.length)) || null
    : value;
}
