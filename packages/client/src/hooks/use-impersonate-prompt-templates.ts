import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  IMPERSONATE_PROMPT_TEMPLATE_CATALOG_VERSION,
  IMPERSONATE_PROMPT_TEMPLATES_SETTINGS_KEY,
  impersonatePromptTemplateCatalogSchema,
  type ImpersonatePromptTemplate,
  type ImpersonatePromptTemplateCatalog,
} from "@marinara-engine/shared";
import { api } from "../lib/api-client";
import { translate } from "../localization/i18n";

const CATALOG_PATH = `/app-settings/${IMPERSONATE_PROMPT_TEMPLATES_SETTINGS_KEY}`;

export const impersonatePromptTemplateKeys = {
  catalog: [IMPERSONATE_PROMPT_TEMPLATES_SETTINGS_KEY, "catalog"] as const,
};

const IMPERSONATE_PROMPT_TEMPLATE_CATALOG_MUTATION_KEY = [
  IMPERSONATE_PROMPT_TEMPLATES_SETTINGS_KEY,
  "catalog",
  "save",
] as const;

type ImpersonatePromptTemplateValidationError = "count" | "name" | "prompt" | "catalog";

export function validateImpersonatePromptTemplates(
  templates: ImpersonatePromptTemplate[],
): ImpersonatePromptTemplateValidationError | null {
  const validation = impersonatePromptTemplateCatalogSchema.safeParse({
    version: IMPERSONATE_PROMPT_TEMPLATE_CATALOG_VERSION,
    templates,
  });
  if (validation.success) return null;

  if (validation.error.issues.some((issue) => issue.path.at(-1) === "name")) return "name";
  if (validation.error.issues.some((issue) => issue.path.at(-1) === "prompt")) return "prompt";
  if (validation.error.issues.some((issue) => issue.path.length === 1 && issue.path[0] === "templates")) return "count";
  return "catalog";
}

export function showImpersonatePromptTemplateValidationError(error: ImpersonatePromptTemplateValidationError): void {
  toast.error(translate(`ui.chatSettings.impersonatesection.validation.${error}`));
}

export function useImpersonatePromptTemplates() {
  return useQuery<ImpersonatePromptTemplateCatalog>({
    queryKey: impersonatePromptTemplateKeys.catalog,
    queryFn: () => api.get<ImpersonatePromptTemplateCatalog>(CATALOG_PATH),
  });
}

export function useIsSavingImpersonatePromptTemplates() {
  return useIsMutating({ mutationKey: IMPERSONATE_PROMPT_TEMPLATE_CATALOG_MUTATION_KEY }) > 0;
}

export function useSaveImpersonatePromptTemplates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: IMPERSONATE_PROMPT_TEMPLATE_CATALOG_MUTATION_KEY,
    mutationFn: (templates: ImpersonatePromptTemplate[]) =>
      api.put<ImpersonatePromptTemplateCatalog>(CATALOG_PATH, {
        version: IMPERSONATE_PROMPT_TEMPLATE_CATALOG_VERSION,
        templates,
      }),
    onSuccess: async (catalog) => {
      await queryClient.cancelQueries({ queryKey: impersonatePromptTemplateKeys.catalog });
      queryClient.setQueryData<ImpersonatePromptTemplateCatalog>(impersonatePromptTemplateKeys.catalog, catalog);
    },
    onError: () => {
      toast.error(translate("ui.chatSettings.impersonatesection.mutationFailed"));
    },
  });
}
