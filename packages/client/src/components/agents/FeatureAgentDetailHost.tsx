import { ArrowLeft, Box, MessageSquare, Settings2, Sparkles } from "lucide-react";
import type { BuiltInAgentManifest, InstalledCapabilityPackage } from "@marinara-engine/shared";
import { CapabilityElement } from "../capabilities/CapabilityElement";
import { useTranslation as useUiTranslation } from "react-i18next";

interface ActiveFeatureChat {
  id: string;
  name: string;
  mode: string;
}

interface FeatureAgentDetailHostProps {
  agent: BuiltInAgentManifest;
  installedPackage: InstalledCapabilityPackage | null;
  activeChat: ActiveFeatureChat | null;
  activeChatSupported: boolean;
  enabledForChat: boolean;
  onEnabledForChatChange?: (enabled: boolean) => void | Promise<void>;
  onClose: () => void;
  onManagePackage: () => void;
  capabilityProps?: Record<string, unknown>;
}

const MODE_LABEL_KEYS: Record<string, string> = {
  conversation: "home.recentChats.mode.conversation",
  roleplay: "home.recentChats.mode.roleplay",
  game: "home.recentChats.mode.game",
};

export function FeatureAgentDetailHost({
  agent,
  installedPackage,
  activeChat,
  activeChatSupported,
  enabledForChat,
  onEnabledForChatChange,
  onClose,
  onManagePackage,
  capabilityProps,
}: FeatureAgentDetailHostProps) {
  const { t: localizeUi } = useUiTranslation();
  const contributedAgentIds = installedPackage?.manifest.contributions?.agentDetail?.agentIds ?? [];
  const hasDetailContribution =
    Boolean(installedPackage?.manifest.entrypoints.client) && contributedAgentIds.includes(agent.id);

  if (installedPackage && hasDetailContribution) {
    return (
      <CapabilityElement
        packageId={installedPackage.id}
        view="detail"
        capabilityProps={{
          package: {
            id: installedPackage.id,
            name: installedPackage.manifest.name,
            version: installedPackage.version,
            status: installedPackage.status,
            readiness: installedPackage.readiness,
            readinessError: installedPackage.readinessError,
            error: installedPackage.error,
            restartRequired: installedPackage.manifest.restartRequired,
            description: installedPackage.manifest.description,
          },
          agent: {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            author: agent.author ?? null,
            modeAllowlist: agent.modeAllowlist ? [...agent.modeAllowlist] : [],
          },
          chatId: activeChatSupported ? (activeChat?.id ?? null) : null,
          chatName: activeChatSupported ? (activeChat?.name ?? null) : null,
          chatMode: activeChatSupported ? (activeChat?.mode ?? null) : null,
          enabledForChat: activeChatSupported && enabledForChat,
          onEnabledForChatChange: activeChatSupported ? onEnabledForChatChange : undefined,
          onClose,
          onManagePackage,
          ...capabilityProps,
        }}
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
      />
    );
  }

  const supportedModes = agent.modeAllowlist?.map((mode) => localizeUi(MODE_LABEL_KEYS[mode] ?? mode)) ?? [];
  const packageState = installedPackage
    ? installedPackage.status === "restart-required"
      ? localizeUi("ui.agents.featureagentdetailhost.packageStatus.restartRequired")
      : installedPackage.status === "error" || installedPackage.readiness === "error"
        ? localizeUi("ui.agents.featureagentdetailhost.packageStatus.needsAttention")
        : localizeUi("ui.agents.featureagentdetailhost.packageStatus.ready")
    : localizeUi("ui.agents.featureagentdetailhost.packageStatus.notInstalled");

  return (
    <section
      data-component="FeatureAgentDetailHost"
      className="mari-editor-shell mari-editor-legacy-bridge flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-labelledby="feature-agent-detail-title"
    >
      <header className="mari-editor-header">
        <button
          type="button"
          onClick={onClose}
          aria-label={localizeUi("capabilities.actions.backToAgents")}
          className="mari-editor-action inline-flex"
        >
          <ArrowLeft size="1.125rem" />
        </button>
        <div className="mari-editor-icon-tile">
          <Sparkles size="1.125rem" className="max-md:h-[0.875rem]! max-md:w-[0.875rem]!" />
        </div>
        <h1 id="feature-agent-detail-title" className="mari-editor-title min-w-0 flex-1 truncate">
          {agent.name}
        </h1>
      </header>

      <div className="mari-editor-content max-md:p-4">
        <div className="mari-editor-content-inner mari-editor-content-inner--wide flex flex-col gap-4">
          <div>
            <p className="text-sm leading-relaxed text-[var(--marinara-editor-muted)]">{agent.description}</p>
            {supportedModes.length > 0 ? (
              <div
                className="mt-3 flex flex-wrap gap-2"
                aria-label={localizeUi("ui.agents.featureagentdetailhost.supportedChatModes")}
              >
                {supportedModes.map((mode) => (
                  <span key={mode} className="mari-editor-chip px-2.5 py-1 text-[0.6875rem]">
                    {mode}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <article className="mari-editor-panel p-4">
              <div className="flex items-start gap-3">
                <Box size="1rem" className="mt-0.5 shrink-0 text-[var(--marinara-editor-accent)]" />
                <div className="min-w-0">
                  <h2 className="text-xs font-semibold">{localizeUi("ui.agents.featureagentdetailhost.package")}</h2>
                  <p className="mt-1 text-[0.6875rem] text-[var(--marinara-editor-muted)]">
                    {installedPackage
                      ? localizeUi("ui.agents.featureagentdetailhost.versionValue1Value2", {
                          value1: installedPackage.version,
                          value2: packageState,
                        })
                      : packageState}
                  </p>
                </div>
              </div>
            </article>
            <article className="mari-editor-panel p-4">
              <div className="flex items-start gap-3">
                <MessageSquare size="1rem" className="mt-0.5 shrink-0 text-[var(--marinara-editor-accent)]" />
                <div className="min-w-0">
                  <h2 className="text-xs font-semibold">
                    {localizeUi("ui.agents.featureagentdetailhost.currentChat")}
                  </h2>
                  <p className="mt-1 text-[0.6875rem] text-[var(--marinara-editor-muted)]">
                    {!activeChat
                      ? localizeUi("ui.agents.featureagentdetailhost.openASupportedChatToUseThisFeature")
                      : activeChatSupported
                        ? localizeUi("ui.agents.featureagentdetailhost.value1Value2", {
                            value1: activeChat.name,
                            value2: enabledForChat
                              ? localizeUi("ui.characters.lorebooktab.active")
                              : localizeUi("ui.agents.featureagentdetailhost.notActive"),
                          })
                        : localizeUi("ui.agents.featureagentdetailhost.value1IsNotASupportedMode", {
                            value1: activeChat.name,
                          })}
                  </p>
                </div>
              </div>
            </article>
          </div>

          <div className="mari-editor-panel mari-editor-panel--soft p-4">
            <div className="flex items-start gap-3">
              <Settings2 size="1rem" className="mt-0.5 shrink-0 text-[var(--marinara-editor-accent)]" />
              <div className="min-w-0">
                <h2 className="text-xs font-semibold">
                  {localizeUi("ui.agents.featureagentdetailhost.featureManagedSettings")}
                </h2>
                <p className="mt-1 text-[0.6875rem] leading-relaxed text-[var(--marinara-editor-muted)]">
                  {localizeUi("ui.agents.featureagentdetailhost.thisFeatureDoesNotUsePipelinePromptsToolsOr")}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onManagePackage}
              className="mari-editor-action mari-editor-action--accent inline-flex min-h-11 px-4"
            >
              <Settings2 size="0.875rem" /> {localizeUi("ui.agents.featureagentdetailhost.managePackage")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
