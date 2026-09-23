// ──────────────────────────────────────────────
// Game: Travel/Rest View (camping, travel, downtime)
// ──────────────────────────────────────────────

interface GameTravelViewProps {
  /** Ambient overlay for the travel/rest state. */
  children: React.ReactNode;
}

export function GameTravelView({ children }: GameTravelViewProps) {
  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      {/* Ambient overlay with warm tones */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-amber-900/10 via-transparent to-amber-950/20" />

      {/* Content (narration + input) */}
      {children}
    </div>
  );
}
