// ──────────────────────────────────────────────
// React Query: Connection Folder hooks
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import type {
  ConnectionFolder,
  CreateConnectionFolderInput,
  ReorderConnectionsInFolderInput,
  ReorderFoldersInput,
  UpdateFolderInput,
} from "@marinara-engine/shared";
import { connectionKeys } from "./use-connections";

export const connectionFolderKeys = {
  all: ["connection-folders"] as const,
  list: () => [...connectionFolderKeys.all, "list"] as const,
};

export function useConnectionFolders() {
  return useQuery({
    queryKey: connectionFolderKeys.list(),
    queryFn: () => api.get<ConnectionFolder[]>("/connection-folders"),
    staleTime: 2 * 60_000,
  });
}

export function useCreateConnectionFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateConnectionFolderInput) => api.post<ConnectionFolder>("/connection-folders", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionFolderKeys.list() }),
  });
}

export function useUpdateConnectionFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateFolderInput & { id: string }) =>
      api.patch<ConnectionFolder>(`/connection-folders/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionFolderKeys.list() }),
  });
}

export function useDeleteConnectionFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/connection-folders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionFolderKeys.list() });
      qc.invalidateQueries({ queryKey: connectionKeys.list() });
    },
  });
}

export function useReorderConnectionFolders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: ReorderFoldersInput["orderedIds"]) =>
      api.post("/connection-folders/reorder", { orderedIds } satisfies ReorderFoldersInput),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionFolderKeys.list() }),
  });
}

export function useReorderConnections() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ReorderConnectionsInFolderInput) => api.post("/connection-folders/reorder-connections", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: connectionKeys.list() }),
  });
}
