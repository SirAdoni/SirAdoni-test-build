import { FileJson, ImageDown, Layers, X } from "lucide-react";
import { Modal } from "./Modal";
import { cn } from "../../lib/utils";
import { useTranslation as useUiTranslation } from "react-i18next";

export type ExportFormatChoice = "native" | "compatible" | "compatible-png";

/** Additional formats a caller can offer next to the standard ones. */
export interface ExportFormatExtraOption {
  id: string;
  label: string;
  icon: typeof Layers;
  description: string;
}

interface ExportFormatDialogProps {
  open: boolean;
  title: string;
  description?: string;
  nativeDescription?: string;
  compatibleDescription?: string;
  pngDescription?: string;
  showPngOption?: boolean;
  extraOptions?: ExportFormatExtraOption[];
  onClose: () => void;
  onSelect: (format: ExportFormatChoice) => void;
  onSelectExtra?: (id: string) => void;
}

export function ExportFormatDialog({
  open,
  title,
  description: descriptionProp,
  nativeDescription: nativeDescriptionProp,
  compatibleDescription: compatibleDescriptionProp,
  pngDescription: pngDescriptionProp,
  showPngOption = false,
  extraOptions = [],
  onClose,
  onSelect,
  onSelectExtra,
}: ExportFormatDialogProps) {
  const { t: localizeUi } = useUiTranslation();
  const description = descriptionProp ?? localizeUi("ui.ui.exportformatdialog.description");
  const nativeDescription = nativeDescriptionProp ?? localizeUi("ui.ui.exportformatdialog.nativeDescription");
  const compatibleDescription =
    compatibleDescriptionProp ?? localizeUi("ui.ui.exportformatdialog.compatibleDescription");
  const pngDescription = pngDescriptionProp ?? localizeUi("ui.ui.exportformatdialog.pngDescription");
  const options: Array<{
    id: ExportFormatChoice | string;
    label: string;
    icon: typeof Layers;
    description: string;
  }> = [
    {
      id: "native",
      label: localizeUi("ui.ui.exportformatdialog.native"),
      icon: Layers,
      description: nativeDescription,
    },
    {
      id: "compatible",
      label: localizeUi("ui.ui.exportformatdialog.compatibleJson"),
      icon: FileJson,
      description: compatibleDescription,
    },
    ...(showPngOption
      ? [
          {
            id: "compatible-png" as const,
            label: localizeUi("ui.ui.exportformatdialog.compatiblePngCard"),
            icon: ImageDown,
            description: pngDescription,
          },
        ]
      : []),
    ...extraOptions,
  ];
  const extraIds = new Set(extraOptions.map((option) => option.id));
  const gridColumns = options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";

  return (
    <Modal open={open} onClose={onClose} title={title} width="max-w-lg">
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{description}</p>
        <div className={cn("grid gap-2", gridColumns)}>
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() =>
                  extraIds.has(option.id) ? onSelectExtra?.(option.id) : onSelect(option.id as ExportFormatChoice)
                }
                className={cn(
                  "group flex min-h-[8.5rem] flex-col items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--secondary)]/55 p-4 text-left transition-all",
                  "hover:border-[var(--primary)]/45 hover:bg-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/35",
                )}
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--card)] text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors group-hover:text-[var(--primary)]">
                  <Icon size="1.05rem" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-[var(--foreground)]">{option.label}</span>
                  <span className="mt-1 block text-[0.6875rem] leading-relaxed text-[var(--muted-foreground)]">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          >
            <X size="0.875rem" />
            {localizeUi("chat.delete.dialog.cancel")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
