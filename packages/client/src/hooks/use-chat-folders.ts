// ──────────────────────────────────────────────
// React Query: Chat Folder hooks
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import type {
  ChatFolder,
  CreateChatFolderInput,
  MoveChatToFolderInput,
  ReorderFoldersInput,
  UpdateFolderInput,
} from "@marinara-engine/shared";
import { chatKeys } from "./use-chats";

export const folderKeys = {
  all: ["chat-folders"] as const,
  list: () => [...folderKeys.all, "list"] as const,
};

export function useChatFolders() {
  return useQuery({
    queryKey: folderKeys.list(),
    queryFn: () => api.get<ChatFolder[]>("/chat-folders"),
    placeholderData: (previousData) => previousData,
    staleTime: 2 * 60_000,
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateChatFolderInput) => api.post<ChatFolder>("/chat-folders", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: folderKeys.list() }),
  });
}

export function useUpdateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateFolderInput & { id: string }) =>
      api.patch<ChatFolder>(`/chat-folders/${id}`, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: folderKeys.list() }),
  });
}

export function useDeleteFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/chat-folders/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: folderKeys.list() });
      qc.invalidateQueries({ queryKey: chatKeys.list() });
    },
  });
}

export function useReorderFolders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (orderedIds: ReorderFoldersInput["orderedIds"]) =>
      api.post("/chat-folders/reorder", { orderedIds } satisfies ReorderFoldersInput),
    onSuccess: () => qc.invalidateQueries({ queryKey: folderKeys.list() }),
  });
}

export function useMoveChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: MoveChatToFolderInput) => api.post("/chat-folders/move-chat", data),
    onSuccess: () => qc.invalidateQueries({ queryKey: chatKeys.list() }),
  });
}
