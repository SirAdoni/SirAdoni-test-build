import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  TEXT_SNIPPET_CATALOG_VERSION,
  TEXT_SNIPPETS_SETTINGS_KEY,
  type TextSnippet,
  type TextSnippetCatalog,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { translate } from "../localization/i18n";

const CATALOG_PATH = `/app-settings/${TEXT_SNIPPETS_SETTINGS_KEY}`;

export const textSnippetKeys = {
  catalog: [TEXT_SNIPPETS_SETTINGS_KEY, "catalog"] as const,
};

export function useTextSnippets() {
  return useQuery<TextSnippetCatalog>({
    queryKey: textSnippetKeys.catalog,
    queryFn: () => api.get<TextSnippetCatalog>(CATALOG_PATH),
    staleTime: 5 * 60_000,
  });
}

export function useSaveTextSnippets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (snippets: TextSnippet[]) =>
      api.put<TextSnippetCatalog>(CATALOG_PATH, { version: TEXT_SNIPPET_CATALOG_VERSION, snippets }),
    onSuccess: async (catalog) => {
      await queryClient.cancelQueries({ queryKey: textSnippetKeys.catalog });
      queryClient.setQueryData<TextSnippetCatalog>(textSnippetKeys.catalog, catalog);
    },
    onError: () => {
      toast.error(translate("snippets.saveFailed"));
    },
  });
}
