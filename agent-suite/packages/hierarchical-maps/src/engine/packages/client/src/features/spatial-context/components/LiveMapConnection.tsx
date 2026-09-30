import { useState } from "react";
import type { SpatialContextDefinition } from "@marinara-engine/shared";
import type { MapsSpatialContextResponse } from "../../../../../maps-shared/src/maps-model";
import { useUpdateSpatialContext } from "../../../hooks/use-spatial-context";
import { useSpatialMapTranslation } from "../localization";
import { useMapConfirmation } from "./use-map-confirmation";

export function LiveMapConnection({
  onSaveDefinition,
  chatId,
  spatial,
  fromId,
  toId,
  onClose,
}: {
  onSaveDefinition?: (definition: SpatialContextDefinition) => Promise<void>;
  chatId: string;
  spatial: MapsSpatialContextResponse;
  fromId: string;
  toId: string;
  onClose: () => void;
}) {
  const definition = spatial.definition!;
  const from = definition.locations.find((location) => location.id === fromId)!;
  const to = definition.locations.find((location) => location.id === toId)!;
  const forward = from.links.find((link) => link.targetId === toId);
  const reverse = to.links.find((link) => link.targetId === fromId);
  const existing = forward ?? reverse;
  const [label, setLabel] = useState(existing?.label ?? "");
  const [direction, setDirection] = useState(
    !existing || existing.bidirectional ? "both" : reverse && !forward ? "reverse" : "forward",
  );
  const [failed, setFailed] = useState(false);
  const update = useUpdateSpatialContext();
  const { t } = useSpatialMapTranslation();
  const { confirmAction, confirmationDialog } = useMapConfirmation();
  const save = async (remove = false) => {
    if (
      remove &&
      !(await confirmAction({
        title: t("ui.worldMaps.live.remove"),
        message: `${from.name} ↔ ${to.name}`,
        tone: "destructive",
      }))
    )
      return;
    const sourceId = direction === "reverse" ? toId : fromId;
    const targetId = direction === "reverse" ? fromId : toId;
    const originalSourceId = forward ? fromId : reverse ? toId : null;
    // Preserve an independently authored opposite-direction connection.
    if (!remove && forward && reverse && sourceId !== originalSourceId) {
      setFailed(true);
      return;
    }
    setFailed(false);
    try {
      const request = {
        chatId,
        expectedRevision: definition.revision,
        expectedCurrentLocationId: spatial.currentLocationId,
        definition: {
          ...definition,
          locations: definition.locations.map((location) => {
            if (location.id !== fromId && location.id !== toId) return location;
            const links = location.links.filter(
              (link) => location.id !== originalSourceId || link.targetId !== (location.id === fromId ? toId : fromId),
            );
            if (!remove && location.id === sourceId)
              links.push({
                targetId,
                bidirectional: direction === "both",
                state: existing?.state ?? "available",
                ...(label.trim() ? { label: label.trim() } : {}),
              });
            return { ...location, links };
          }),
        },
      };
      if (onSaveDefinition) await onSaveDefinition(request.definition);
      else await update.mutateAsync(request);
      onClose();
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="my-2 space-y-2 rounded border border-[var(--border)] bg-[var(--background)] p-2 text-xs">
      {confirmationDialog}
      <div>
        {from.name} ↔ {to.name}
      </div>
      <label className="block">
        {t("ui.worldMaps.live.label")}
        <input
          className="w-full rounded border border-[var(--border)] bg-[var(--background)] p-2"
          value={label}
          maxLength={200}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      <select
        disabled={Boolean(onSaveDefinition)}
        aria-label={t("ui.worldMaps.live.direction")}
        className="w-full rounded border border-[var(--border)] bg-[var(--background)] p-2"
        value={direction}
        onChange={(event) => setDirection(event.target.value)}
      >
        <option value="both">{t("ui.worldMaps.live.both")}</option>
        <option value="forward">
          {from.name} → {to.name}
        </option>
        <option value="reverse">
          {to.name} → {from.name}
        </option>
      </select>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={update.isPending} onClick={() => void save()}>
          {t("ui.worldMaps.live.save")}
        </button>
        {existing && (
          <button type="button" disabled={update.isPending} onClick={() => void save(true)}>
            {t("ui.worldMaps.live.remove")}
          </button>
        )}
        <button type="button" disabled={update.isPending} onClick={onClose}>
          {t("ui.worldMaps.live.cancel")}
        </button>
      </div>
      {failed && <p role="alert">{t("ui.worldMaps.layout.failed")}</p>}
    </div>
  );
}
