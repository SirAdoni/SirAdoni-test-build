import { Braces, CircleHelp, SquareTerminal, X } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  NEUTRAL_PANEL_CLOSE_BUTTON,
  NEUTRAL_PANEL_CLOSE_ICON_SIZE,
  NEUTRAL_PANEL_HEADER,
  NEUTRAL_PANEL_SCROLL_AREA,
  NEUTRAL_PANEL_SHELL,
  NEUTRAL_PANEL_TITLE,
} from "../ui/neutral-surface-styles";
import { useTranslation as useUiTranslation } from "react-i18next";

interface SlashCommandFeedbackProps {
  feedback: string;
  onDismiss: () => void;
  className?: string;
}

function splitDetail(line: string): { label: string; detail: string } {
  const match = /\s(?:\u2014|-)\s/.exec(line);
  if (!match) return { label: line.trim(), detail: "" };
  return {
    label: line.slice(0, match.index).trim(),
    detail: line.slice(match.index + match[0].length).trim(),
  };
}

function renderLine(line: string, index: number) {
  const trimmed = line.trim();
  if (!trimmed) return <div key={index} className="h-1" />;

  if (trimmed.startsWith("Tip:")) {
    return (
      <p
        key={index}
        className="rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--marinara-chat-chrome-highlight-bg)] px-2.5 py-2 text-[0.6875rem] leading-relaxed text-[var(--marinara-chat-chrome-highlight-text)] [overflow-wrap:anywhere]"
      >
        {trimmed}
      </p>
    );
  }

  if (trimmed.endsWith(":") && !trimmed.startsWith("/") && !trimmed.startsWith("{{")) {
    return (
      <div key={index} className="pt-1 text-[0.6875rem] font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
        {trimmed.slice(0, -1)}
      </div>
    );
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("{{")) {
    const { label, detail } = splitDetail(trimmed);
    return (
      <div
        key={index}
        className="min-w-0 rounded-lg border border-[var(--marinara-chat-chrome-panel-divider)] bg-[var(--marinara-chat-chrome-highlight-bg)] px-2.5 py-2"
      >
        <code className="block min-w-0 break-all font-mono text-[0.6875rem] font-semibold text-[var(--marinara-chat-chrome-highlight-text)]">
          {label}
        </code>
        {detail && (
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--marinara-chat-chrome-panel-muted)] [overflow-wrap:anywhere]">
            {detail}
          </p>
        )}
      </div>
    );
  }

  return (
    <p
      key={index}
      className="text-[0.6875rem] leading-relaxed text-[var(--marinara-chat-chrome-panel-text)] [overflow-wrap:anywhere]"
    >
      {trimmed}
    </p>
  );
}

export function SlashCommandFeedback({ feedback, onDismiss, className }: SlashCommandFeedbackProps) {
  const { t: localizeUi } = useUiTranslation();
  const lines = feedback.split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  const title = firstContentIndex >= 0 ? lines[firstContentIndex]!.trim().replace(/:$/, "") : "Slash command";
  const bodyLines = firstContentIndex >= 0 ? lines.slice(firstContentIndex + 1) : [];
  const TitleIcon =
    title === "Available Commands" ? CircleHelp : title === "Supported Macros" ? Braces : SquareTerminal;

  return (
    <section className={cn(NEUTRAL_PANEL_SHELL, "mari-chrome-token-scope min-w-0 overflow-hidden text-xs", className)}>
      <div className={cn(NEUTRAL_PANEL_HEADER, "flex items-center gap-2")}>
        <h3 className={cn(NEUTRAL_PANEL_TITLE, "flex-1 truncate text-[0.75rem]")}>
          <TitleIcon size="0.875rem" className="shrink-0 text-[var(--marinara-chat-chrome-highlight-text)]" />
          <span className="truncate">{title}</span>
        </h3>
        <button
          type="button"
          onClick={onDismiss}
          className={cn(NEUTRAL_PANEL_CLOSE_BUTTON, "shrink-0")}
          aria-label={localizeUi("ui.chat.slashcommandfeedback.dismiss")}
        >
          <X size={NEUTRAL_PANEL_CLOSE_ICON_SIZE} />
        </button>
      </div>
      {bodyLines.length > 0 && (
        <div
          className={cn(
            NEUTRAL_PANEL_SCROLL_AREA,
            "flex max-h-[min(26rem,58dvh)] flex-col gap-1.5 overflow-y-auto px-3 py-2.5 [-webkit-overflow-scrolling:touch]",
          )}
        >
          {bodyLines.map(renderLine)}
        </div>
      )}
    </section>
  );
}
