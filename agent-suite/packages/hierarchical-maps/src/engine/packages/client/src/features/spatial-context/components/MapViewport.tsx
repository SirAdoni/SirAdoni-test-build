import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useSpatialMapTranslation } from "../localization";

export function MapViewport({
  children,
  contentRef,
  compact,
  className,
}: {
  children: ReactNode;
  contentRef: RefObject<HTMLDivElement | null>;
  compact: boolean;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const pan = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const { t } = useSpatialMapTranslation();
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const box = element.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
      setView((old) => {
        const scale = Math.max(0.5, Math.min(4, old.scale * Math.exp(-delta * 0.002)));
        const ratio = scale / old.scale;
        return { scale, x: x - (x - old.x) * ratio, y: y - (y - old.y) * ratio };
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div
      ref={root}
      data-marinara-maps-world-canvas
      data-compact={compact ? "true" : "false"}
      className={`relative aspect-[16/9] min-h-[280px] w-full touch-none select-none overflow-hidden rounded-lg border border-[var(--marinara-chat-chrome-panel-border)] bg-[var(--background)] cursor-grab active:cursor-grabbing ${className ?? ""}`}
      style={{
        containerType: "inline-size",
        // Package canvases must have intrinsic height even when the host has not generated these utility classes.
        minHeight: 280,
        aspectRatio: "16 / 9",
        backgroundImage:
          "linear-gradient(to right, var(--marinara-chat-chrome-panel-divider) 1px, transparent 1px), linear-gradient(to bottom, var(--marinara-chat-chrome-panel-divider) 1px, transparent 1px)",
        backgroundSize: `${5 * view.scale}% ${5 * view.scale}%`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      onDragStart={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pan.current = { x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
      }}
      onPointerMove={(event) => {
        const start = pan.current;
        if (!start) return;
        setView((old) => ({
          ...old,
          x: start.originX + event.clientX - start.x,
          y: start.originY + event.clientY - start.y,
        }));
      }}
      onPointerUp={(event) => {
        pan.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        pan.current = null;
      }}
      onLostPointerCapture={() => {
        pan.current = null;
      }}
    >
      <div
        ref={contentRef}
        className="absolute inset-0"
        style={
          {
            transformOrigin: "0 0",
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            "--map-marker-scale": 1 / view.scale,
          } as CSSProperties
        }
      >
        {children}
      </div>
      <button
        type="button"
        className="absolute right-1 top-1 z-20 rounded bg-[var(--background)] px-2 py-1 text-xs text-[var(--foreground)]"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setView({ x: 0, y: 0, scale: 1 })}
        title={t("ui.worldMaps.layout.resetView")}
        aria-label={t("ui.worldMaps.layout.resetView")}
      >
        {Math.round(view.scale * 100)}% ↺
      </button>
    </div>
  );
}
