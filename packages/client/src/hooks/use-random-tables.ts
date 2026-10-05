// ──────────────────────────────────────────────
// Random tables and the yes/no oracle (server-stored, server-rolled)
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { OracleLikelihood, OracleResult, RandomTableRow, TableRollResult } from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { diceLogKeys } from "./use-game-tools";
import { getCachedFeatureEnabled, useFeatureEnabled } from "./use-feature-settings";
import { i18n } from "../localization/i18n";

function requireRandomTables(qc: QueryClient): void {
  if (!getCachedFeatureEnabled(qc, "randomTables")) throw new Error(i18n.t("settings.features.disabled"));
}

export type RandomTableScope = "global" | "game";

export interface RandomTableRecord {
  id: string;
  name: string;
  /** "" for a global table. */
  gameId: string;
  dice: string | null;
  description: string;
  rows: RandomTableRow[];
  createdAt: string;
  updatedAt: string;
}

export interface RandomTablesResponse {
  /** The campaign of the chat asked about; null outside Game Mode. */
  gameId: string | null;
  tables: RandomTableRecord[];
}

export interface RandomTableDraft {
  name: string;
  dice: string | null;
  description?: string;
  rows: RandomTableRow[];
}

export interface LorebookTableSources {
  entryCount: number;
  folders: Array<{ id: string; name: string; parentFolderId: string | null; entryCount: number }>;
  tags: Array<{ tag: string; count: number }>;
}

export const randomTableKeys = {
  all: ["random-tables"] as const,
  list: (chatId: string | null) => [...randomTableKeys.all, "list", chatId ?? ""] as const,
  lorebookSources: (lorebookId: string) => [...randomTableKeys.all, "lorebook-sources", lorebookId] as const,
};

export function useRandomTables(chatId: string | null | undefined) {
  const enabled = useFeatureEnabled("randomTables");
  return useQuery({
    queryKey: randomTableKeys.list(chatId ?? null),
    enabled,
    queryFn: () =>
      api.get<RandomTablesResponse>(`/random-tables${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ""}`),
    staleTime: 30_000,
  });
}

export function useLorebookTableSources(lorebookId: string | null) {
  const enabled = useFeatureEnabled("randomTables");
  return useQuery({
    queryKey: randomTableKeys.lorebookSources(lorebookId ?? ""),
    queryFn: () => api.get<LorebookTableSources>(`/random-tables/lorebook-sources/${encodeURIComponent(lorebookId!)}`),
    enabled: !!lorebookId && enabled,
    staleTime: 30_000,
  });
}

export function useRandomTableMutations(chatId: string | null | undefined) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: randomTableKeys.all });
  const chat = chatId ?? undefined;

  const save = useMutation({
    mutationFn: async (input: { id?: string; scope: RandomTableScope; table: RandomTableDraft }) => {
      requireRandomTables(qc);
      return input.id
        ? api.put<RandomTableRecord>(`/random-tables/${encodeURIComponent(input.id)}`, {
            chatId: chat,
            scope: input.scope,
            table: input.table,
          })
        : api.post<RandomTableRecord>("/random-tables", { chatId: chat, scope: input.scope, table: input.table });
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      requireRandomTables(qc);
      return api.delete<{ deleted: boolean }>(`/random-tables/${encodeURIComponent(id)}`);
    },
    onSuccess: invalidate,
  });

  const importTables = useMutation({
    mutationFn: async (input: { scope: RandomTableScope; data: unknown; skipExisting?: boolean }) => {
      requireRandomTables(qc);
      return api.post<{ created: RandomTableRecord[]; skipped: number; existing?: number }>("/random-tables/import", {
        chatId: chat,
        scope: input.scope,
        data: input.data,
        ...(input.skipExisting ? { skipExisting: true } : {}),
      });
    },
    onSuccess: invalidate,
  });

  const fromLorebook = useMutation({
    mutationFn: async (input: {
      scope: RandomTableScope;
      name: string;
      lorebookId: string;
      folderId?: string | null;
      includeSubfolders?: boolean;
      tag?: string | null;
    }) => {
      requireRandomTables(qc);
      return api.post<RandomTableRecord>("/random-tables/from-lorebook", { chatId: chat, ...input });
    },
    onSuccess: invalidate,
  });

  return { save, remove, importTables, fromLorebook };
}

export function useRandomTableRolls(chatId: string | null | undefined) {
  const qc = useQueryClient();
  const chat = chatId ?? undefined;
  const afterRoll = (logged: number) => {
    if (logged > 0) void qc.invalidateQueries({ queryKey: diceLogKeys.all });
  };

  const roll = useMutation({
    mutationFn: async (input: { tableId: string; log: boolean }) => {
      requireRandomTables(qc);
      return api.post<{ result: TableRollResult; line: string; logged: number }>("/random-tables/roll", {
        tableId: input.tableId,
        chatId: chat,
        log: input.log,
      });
    },
    onSuccess: (data) => afterRoll(data.logged),
  });

  const oracle = useMutation({
    mutationFn: async (input: { likelihood: OracleLikelihood; question?: string; log: boolean }) => {
      requireRandomTables(qc);
      return api.post<{ result: OracleResult; line: string; logged: number }>("/random-tables/oracle", {
        likelihood: input.likelihood,
        question: input.question || undefined,
        chatId: chat,
        log: input.log,
      });
    },
    onSuccess: (data) => afterRoll(data.logged),
  });

  return { roll, oracle };
}
