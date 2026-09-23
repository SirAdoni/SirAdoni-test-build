// ──────────────────────────────────────────────
// Game: Elemental Reaction Display
// ──────────────────────────────────────────────
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

interface ReactionDisplay {
  reaction: string;
  description: string;
  damageMultiplier: number;
  attackerName: string;
  defenderName: string;
  element?: string;
}

interface GameElementReactionProps {
  reaction: ReactionDisplay;
  onDismiss: () => void;
}

/** Element‐to‐color mapping used for the glow ring. */
const ELEMENT_COLORS: Record<string, string> = {
  fire: "#ff4500",
  pyro: "#ff4500",
  ice: "#00bfff",
  cryo: "#00bfff",
  lightning: "#8b5cf6",
  electro: "#9b59b6",
  hydro: "#4169e1",
  anemo: "#77dd77",
  wind: "#77dd77",
  geo: "#daa520",
  dendro: "#228b22",
  poison: "#9400d3",
  holy: "#fffacd",
  shadow: "#4a0080",
  physical: "#c0c0c0",
  quantum: "#6a0dad",
  imaginary: "#ffd700",
};

/** Element‐to‐emoji mapping. */
const ELEMENT_EMOJI: Record<string, string> = {
  fire: "🔥",
  pyro: "🔥",
  ice: "❄️",
  cryo: "❄️",
  lightning: "⚡",
  electro: "⚡",
  hydro: "💧",
  anemo: "🌪️",
  wind: "🌪️",
  geo: "🪨",
  dendro: "🌿",
  poison: "☠️",
  holy: "✨",
  shadow: "🌑",
  physical: "⚔️",
  quantum: "🔮",
  imaginary: "✦",
};

export function GameElementReaction({ reaction, onDismiss }: GameElementReactionProps) {
  const [animate, setAnimate] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    setAnimate(false);
    const raf = requestAnimationFrame(() => setAnimate(true));
    const timer = setTimeout(() => onDismissRef.current(), 6000);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [reaction]);

  const glowColor = reaction.element ? (ELEMENT_COLORS[reaction.element] ?? "#ffffff") : "#ffffff";
  const emoji = reaction.element ? (ELEMENT_EMOJI[reaction.element] ?? "💥") : "💥";
  const multiplierText =
    reaction.damageMultiplier > 1
      ? `${reaction.damageMultiplier}x DMG`
      : reaction.damageMultiplier < 1
        ? `${reaction.damageMultiplier}x DMG`
        : "";

  return (
    <div
      className={`absolute bottom-36 left-1/2 z-50 -translate-x-1/2 transition-all duration-500 ${
        animate ? "translate-y-0 scale-100 opacity-100" : "translate-y-6 scale-90 opacity-0"
      }`}
    >
      <div
        className="flex flex-col items-center gap-1.5 rounded-xl bg-black/85 px-6 py-3 shadow-lg shadow-black/40 backdrop-blur-md"
        style={{ boxShadow: `0 0 24px 4px ${glowColor}40, inset 0 0 12px ${glowColor}20` }}
      >
        {/* Reaction name with emoji */}
        <div className="flex items-center gap-2">
          <span className="text-2xl game-dice-animate">{emoji}</span>
          <span className="text-lg font-bold text-white tracking-wide">{reaction.reaction}</span>
          {multiplierText && (
            <span
              className="rounded-md px-2 py-0.5 text-xs font-bold"
              style={{ backgroundColor: `${glowColor}30`, color: glowColor }}
            >
              {multiplierText}
            </span>
          )}
        </div>

        {/* Description */}
        <p className="max-w-xs text-center text-xs text-white/70 leading-tight italic">{reaction.description}</p>

        {/* Target info */}
        <div className="text-[10px] text-white/40">
          {reaction.attackerName} → {reaction.defenderName}
        </div>

        <button onClick={onDismiss} className="absolute right-2 top-2 rounded p-0.5 text-white/30 hover:text-white">
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
