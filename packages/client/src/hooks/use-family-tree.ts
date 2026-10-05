import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { FamilyKind, FamilyTreeData } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { requireWikiFeatureEnabled, useWikiFeatureEnabled } from "./use-feature-settings";

export interface FamilyTreeEdit {
  action: "save" | "remove";
  id?: string;
  revision?: number;
  sourceId: string;
  targetId: string | null;
  kind: FamilyKind;
  note: string;
}

export function useFamilyTree(chatId: string) {
  const qc = useQueryClient();
  const enabled = useWikiFeatureEnabled("familyTree");
  const attempt = useRef<{ payload: string; operationId: string } | null>(null);
  const query = useQuery({
    queryKey: ["campaign-memory", "family-tree", chatId],
    queryFn: () => {
      requireWikiFeatureEnabled(qc, "familyTree");
      return api.get<FamilyTreeData>(`/family-tree/${encodeURIComponent(chatId)}`);
    },
    enabled: !!chatId && enabled,
  });
  const mutation = useMutation({
    mutationFn: ({ action, id, revision, sourceId, targetId, kind, note }: FamilyTreeEdit) => {
      requireWikiFeatureEnabled(qc, "familyTree");
      const edit = {
        action,
        id,
        revision,
        sourceId,
        targetId,
        kind,
        note,
      };
      const payload = JSON.stringify({ chatId, ...edit });
      if (attempt.current?.payload !== payload) attempt.current = { payload, operationId: crypto.randomUUID() };
      return api.post(`/family-tree/${encodeURIComponent(chatId)}`, {
        ...edit,
        operationId: attempt.current.operationId,
      });
    },
    // The wiki and family tree are two editors over the same canonical records.
    onSuccess: async () => {
      attempt.current = null;
      await qc.invalidateQueries({ queryKey: ["campaign-memory"] });
    },
  });
  return { ...query, save: mutation.mutateAsync, saving: mutation.isPending };
}
