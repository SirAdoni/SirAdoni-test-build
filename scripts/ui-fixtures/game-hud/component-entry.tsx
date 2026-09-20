import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HudWidget } from "@marinara-engine/shared";
import { activateLocale } from "../../../packages/client/src/localization/i18n";
import { FloatingGamePanel, GamePanelContext } from "../../../packages/client/src/components/game/FloatingGamePanel";
import { GameContactBookWidget } from "../../../packages/client/src/components/game/GameContactBookWidget";
import { GameWidgetPanel } from "../../../packages/client/src/components/game/GameWidgetPanel";
import { CharacterPhoto } from "../../../packages/client/src/components/ui/CharacterPhoto";
import { EditorAvatarTileActions } from "../../../packages/client/src/components/ui/EditorAvatarTileActions";
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const fixtureWidget: HudWidget = {
  id: "open-file",
  type: "list",
  label: "Open File",
  icon: "📄",
  position: "hud_right",
  config: { items: ["Read source file", "Edit layout"], autoSize: true },
};
function PhotoMenuFixture() {
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open portrait menu
      </button>
      {open && (
        <div ref={menu} data-photo-menu style={{ position: "fixed", top: 50, left: 400, zIndex: 500 }}>
          <CharacterPhoto src="/missing-portrait.png" fallbackSrc="/npc-silhouette.svg" name="Menu NPC">
            <img src="/npc-silhouette.svg" alt="Menu NPC" width={48} height={48} />
          </CharacterPhoto>
        </div>
      )}
    </>
  );
}
function Harness() {
  const surface = useRef<HTMLElement>(null);
  const [opened, setOpened] = useState(true);
  const [profile, setProfile] = useState("");
  const [editing, setEditing] = useState(true);
  const [statusRevision, setStatusRevision] = useState(0);
  const [photoUpdates, setPhotoUpdates] = useState(0);
  return (
    <QueryClientProvider client={queryClient}>
      <GamePanelContext.Provider value={{ chatId: "hud-chat", surface, layoutEditing: editing }}>
        <section
          ref={surface}
          data-chat-resource-drop-surface
          style={{ position: "relative", height: "100vh", overflow: "hidden" }}
        >
          <FloatingGamePanel id="narration" width={520} height={220} bottom autoGrow allowTuck>
            <div style={{ padding: 24 }}>
              <h1>HUD narration</h1>
              <p>Resize and bottom pin fixture content.</p>
            </div>
          </FloatingGamePanel>
          <FloatingGamePanel
            id="game-status"
            width={248}
            side="hud_left"
            slot={14}
            autoGrow
            autoWidth
            allowTuck
            revealOnValueChangeKey={`fixture-status-${statusRevision}`}
          >
            <div style={{ minHeight: 360, padding: 18 }}>
              <h2>Game status</h2>
              <p>Satiety 100 / 100</p>
              <p>Energy 100 / 100</p>
              <p>HP 100 / 100</p>
              <p>STR 26 DEX 24</p>
            </div>
          </FloatingGamePanel>
          <GameWidgetPanel widgets={[fixtureWidget]} position="hud_right" chatId="hud-chat" constraintsRef={surface} />
          <button type="button" data-status-update onClick={() => setStatusRevision((current) => current + 1)}>
            Update status
          </button>
          <div data-character-photo-fixture className="relative inline-flex items-center">
            <CharacterPhoto
              src="/npc-silhouette.svg"
              name="Real NPC"
              className="h-12 w-12 rounded-full"
              onUpdate={() => setPhotoUpdates((current) => current + 1)}
            >
              <span className="absolute inset-0 overflow-hidden rounded-full">
                <img src="/npc-silhouette.svg" alt="Real NPC" className="h-full w-full object-cover" />
              </span>
            </CharacterPhoto>
            <EditorAvatarTileActions
              generationAvailable
              onGenerate={() => setPhotoUpdates((current) => current + 10)}
            />
            <output data-photo-updates>{photoUpdates}</output>
          </div>
          <PhotoMenuFixture />
          <button type="button" data-editing-toggle onClick={() => setEditing((current) => !current)}>
            Toggle layout editing
          </button>
          {opened && (
            <GameContactBookWidget
              chatId="hud-chat"
              campaignKey="hud-campaign"
              open
              onClose={() => setOpened(false)}
              onOpenCharacter={setProfile}
            />
          )}
          {profile && <output data-profile-callback>{profile}</output>}
        </section>
      </GamePanelContext.Provider>
    </QueryClientProvider>
  );
}
await activateLocale("en");
createRoot(document.getElementById("root")!).render(<Harness />);
