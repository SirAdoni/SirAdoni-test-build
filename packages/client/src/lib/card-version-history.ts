import type { TFunction } from "i18next";

type CardVersionLabel = {
  isCurrent?: boolean;
  revision: number;
  version: string;
};

export function formatCardVersionTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function getCardVersionTitle(version: CardVersionLabel, localizeUi: TFunction): string {
  const cardVersion = version.version.trim();
  if (version.isCurrent) {
    return cardVersion
      ? localizeUi("ui.cardversionhistory.currentRevisionWithCardVersion", { version: cardVersion })
      : localizeUi("ui.cardversionhistory.currentRevision");
  }
  return cardVersion
    ? localizeUi("ui.cardversionhistory.revisionWithCardVersion", {
        revision: version.revision,
        version: cardVersion,
      })
    : localizeUi("ui.cardversionhistory.revision", { revision: version.revision });
}
