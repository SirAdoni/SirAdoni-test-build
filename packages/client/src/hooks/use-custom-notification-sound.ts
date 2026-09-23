import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";

export interface CustomNotificationSoundStatus {
  configured: boolean;
  url: string | null;
  updatedAt: string | null;
}

export const customNotificationSoundKey = ["custom-notification-sound"] as const;

export function useCustomNotificationSoundStatus() {
  return useQuery<CustomNotificationSoundStatus>({
    queryKey: customNotificationSoundKey,
    queryFn: () => api.get("/notification-sound"),
    staleTime: 30_000,
  });
}

export function useUploadCustomNotificationSound() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api.upload<CustomNotificationSoundStatus>("/notification-sound/upload", formData);
    },
    onSuccess: (status) => {
      queryClient.setQueryData(customNotificationSoundKey, status);
    },
  });
}

export function useRemoveCustomNotificationSound() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>("/notification-sound"),
    onSuccess: () => {
      queryClient.setQueryData<CustomNotificationSoundStatus>(customNotificationSoundKey, {
        configured: false,
        url: null,
        updatedAt: null,
      });
    },
  });
}
