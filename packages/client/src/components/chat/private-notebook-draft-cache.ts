import type { PrivateNotebookDocument, PrivateNotebookTarget } from "@marinara-engine/shared";

export type PrivateNotebookSaveStatus = "saved" | "unsaved" | "saving" | "error" | "conflict";

export type PrivateNotebookDraft = {
  target: PrivateNotebookTarget;
  content: string;
  savedContent: string;
  revision: number;
  status: PrivateNotebookSaveStatus;
  conflictDocument: PrivateNotebookDocument | null;
};

export type PrivateNotebookDraftMap = Record<string, PrivateNotebookDraft>;

export const PRIVATE_NOTEBOOK_DRAFTS_QUERY_KEY = ["private-notebook-drafts"] as const;

export function getPrivateNotebookDraftQueryKey(chatId: string) {
  return [...PRIVATE_NOTEBOOK_DRAFTS_QUERY_KEY, chatId] as const;
}

export function getDirtyPrivateNotebookDrafts(drafts: PrivateNotebookDraftMap): PrivateNotebookDraftMap {
  return Object.fromEntries(
    Object.entries(drafts).filter(([, draft]) => draft.content !== draft.savedContent || draft.conflictDocument),
  );
}

export function restorePrivateNotebookDrafts(drafts: PrivateNotebookDraftMap): PrivateNotebookDraftMap {
  return Object.fromEntries(
    Object.entries(drafts).map(([key, draft]) => [
      key,
      draft.status === "saving" ? { ...draft, status: "unsaved" } : draft,
    ]),
  );
}

export function reconcilePrivateNotebookDrafts(
  drafts: PrivateNotebookDraftMap,
  documents: PrivateNotebookDocument[],
  getTargetKey: (target: PrivateNotebookTarget) => string,
): PrivateNotebookDraftMap {
  const reconciled = { ...drafts };
  const serverKeys = new Set<string>();

  for (const document of documents) {
    const key = getTargetKey(document.target);
    serverKeys.add(key);
    const existing = drafts[key];
    if (!existing || (existing.content === existing.savedContent && !existing.conflictDocument)) {
      reconciled[key] = {
        target: document.target,
        content: document.content,
        savedContent: document.content,
        revision: document.revision,
        status: "saved",
        conflictDocument: null,
      };
      continue;
    }

    if (existing.content === document.content) {
      reconciled[key] = {
        target: document.target,
        content: document.content,
        savedContent: document.content,
        revision: document.revision,
        status: "saved",
        conflictDocument: null,
      };
      continue;
    }

    if (existing.conflictDocument) {
      reconciled[key] = { ...existing, revision: document.revision, status: "conflict", conflictDocument: document };
      continue;
    }

    if (existing.savedContent === document.content) {
      reconciled[key] = {
        ...existing,
        target: document.target,
        savedContent: document.content,
        revision: document.revision,
        status: "unsaved",
        conflictDocument: null,
      };
      continue;
    }

    reconciled[key] = {
      ...existing,
      savedContent: document.content,
      revision: document.revision,
      status: "conflict",
      conflictDocument: document,
    };
  }

  for (const key of serverKeys) {
    const draft = reconciled[key];
    if (draft?.status === "saving") reconciled[key] = { ...draft, status: "unsaved" };
  }

  return reconciled;
}
