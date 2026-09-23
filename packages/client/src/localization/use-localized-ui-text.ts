import { useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { findEnglishMessageKey } from "./i18n";

export function useLocalizedUiText() {
  const { t, i18n } = useTranslation();

  return useCallback(
    (englishText: string): string => {
      const key = findEnglishMessageKey(englishText, i18n.resolvedLanguage ?? i18n.language);
      return key ? t(key) : englishText;
    },
    [i18n.language, i18n.resolvedLanguage, t],
  );
}

export function localizeStringNode(node: ReactNode, localize: (englishText: string) => string): ReactNode {
  return typeof node === "string" ? localize(node) : node;
}
