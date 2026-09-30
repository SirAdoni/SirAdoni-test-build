import { useRef, useState, type RefObject } from "react";
import { useSpatialMapTranslation } from "../localization";

export function MapConnectionHandle({
  id,
  name,
  position,
  canvasRef,
  disabled,
  onConnect,
  onStart,
}: {
  id: string;
  name: string;
  position: { x: number; y: number };
  canvasRef: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  onConnect: (from: string, to: string) => void;
  onStart?: (from: string) => void;
}) {
  const active = useRef<number | null>(null);
  const moved = useRef(false);
  const [end, setEnd] = useState<{ x: number; y: number } | null>(null);
  const { t } = useSpatialMapTranslation();
  const cancel = () => {
    active.current = null;
    setEnd(null);
  };
  return (
    <>
      {end && (
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 h-full w-full"
          data-map-connection-preview
          style={{ overflow: "visible" }}
        >
          <line
            x1={`${position.x}%`}
            y1={`${position.y}%`}
            x2={`${end.x}%`}
            y2={`${end.y}%`}
            stroke="var(--marinara-chat-chrome-accent)"
            strokeWidth="2"
            strokeDasharray="5 4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <button
        type="button"
        disabled={disabled}
        data-map-connection-handle={id}
        className="absolute z-20 flex h-[36px] w-[36px] touch-none select-none items-center justify-center rounded-full text-[var(--marinara-chat-chrome-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--marinara-chat-chrome-focus-ring)] disabled:opacity-30"
        style={{
          left: `${position.x}%`,
          top: `${position.y}%`,
          transform: "translate(-50%, -50%) scale(var(--map-marker-scale, 1)) translateX(46px)",
          cursor: "crosshair",
        }}
        aria-label={`${t("ui.worldMaps.live.dragFrom")} ${name}`}
        title={t("ui.worldMaps.live.dragHelp")}
        draggable={false}
        onDragStart={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          if (!moved.current) onStart?.(id);
          moved.current = false;
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
          event.preventDefault();
          if (disabled || event.button !== 0 || !event.isPrimary) return;
          event.currentTarget.focus({ preventScroll: true });
          active.current = event.pointerId;
          moved.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
          setEnd(position);
        }}
        onPointerMove={(event) => {
          if (active.current !== event.pointerId) return;
          moved.current = true;
          const bounds = canvasRef.current?.getBoundingClientRect();
          if (!bounds?.width || !bounds.height) return;
          setEnd({
            x: ((event.clientX - bounds.left) / bounds.width) * 100,
            y: ((event.clientY - bounds.top) / bounds.height) * 100,
          });
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          if (active.current !== event.pointerId) return;
          const viewport = canvasRef.current?.parentElement?.getBoundingClientRect();
          const inside =
            viewport &&
            event.clientX >= viewport.left &&
            event.clientX <= viewport.right &&
            event.clientY >= viewport.top &&
            event.clientY <= viewport.bottom;
          const target = inside
            ? Array.from(canvasRef.current?.querySelectorAll<HTMLElement>("[data-map-node-id]") ?? []).find((node) => {
                const bounds = node.getBoundingClientRect();
                return (
                  node.dataset.mapNodeId !== id &&
                  event.clientX >= bounds.left &&
                  event.clientX <= bounds.right &&
                  event.clientY >= bounds.top &&
                  event.clientY <= bounds.bottom
                );
              })
            : undefined;
          cancel();
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          if (target?.dataset.mapNodeId) onConnect(id, target.dataset.mapNodeId);
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            cancel();
          }
        }}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="7" fill="var(--background)" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 10h8m-4-4v8" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
    </>
  );
}
