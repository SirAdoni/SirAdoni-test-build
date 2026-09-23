// ──────────────────────────────────────────────
// Game: Scene Transition Manager
//
// Intercepts game state/location changes and plays
// CSS transitions between scenes. VN-style cuts,
// fades, flashes.
// ──────────────────────────────────────────────
import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import type { GameActiveState } from "@marinara-engine/shared";
import { AnimatedText } from "./AnimatedText";

export type TransitionType =
  | "none"
  | "fade-black"
  | "fade-white"
  | "flash-red"
  | "flash-white"
  | "dissolve"
  | "slide-left"
  | "slide-right"
  | "title-card";

interface TransitionManagerProps {
  gameState: GameActiveState;
  location?: string | null;
  children: ReactNode;
}

/** Map state changes to transition types. */
function getStateTransition(from: GameActiveState, to: GameActiveState): TransitionType {
  if (from === to) return "none";
  if (to === "combat") return "flash-red";
  if (to === "travel_rest") return "dissolve";
  if (to === "dialogue" && from === "exploration") return "fade-black";
  if (to === "exploration" && from === "combat") return "fade-white";
  return "fade-black";
}

const TRANSITION_DURATION = 800;
const TITLE_CARD_DURATION = 2000;

export function GameTransitionManager({ gameState, location, children }: TransitionManagerProps) {
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [transitionType, setTransitionType] = useState<TransitionType>("none");
  const [titleText, setTitleText] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const prevState = useRef(gameState);
  const prevLocation = useRef(location);

  const triggerTransition = useCallback((type: TransitionType, title?: string) => {
    if (type === "none") return;

    setTransitionType(type);
    setIsTransitioning(true);
    setShowOverlay(true);

    if (title) {
      setTitleText(title);
      // Show title card longer
      setTimeout(() => {
        setTitleText(null);
      }, TITLE_CARD_DURATION);
    }

    // Start fade-out after half transition
    setTimeout(() => {
      setShowOverlay(false);
    }, TRANSITION_DURATION / 2);

    // Clean up
    setTimeout(
      () => {
        setIsTransitioning(false);
        setTransitionType("none");
      },
      title ? TITLE_CARD_DURATION + TRANSITION_DURATION : TRANSITION_DURATION,
    );
  }, []);

  // State change transitions
  useEffect(() => {
    if (prevState.current !== gameState) {
      const type = getStateTransition(prevState.current, gameState);
      if (type !== "none") {
        triggerTransition(type);
      }
      prevState.current = gameState;
    }
  }, [gameState, triggerTransition]);

  // Location change transitions
  useEffect(() => {
    if (prevLocation.current && location && prevLocation.current !== location) {
      triggerTransition("fade-black", location);
    }
    prevLocation.current = location;
  }, [location, triggerTransition]);

  return (
    <div className="relative flex h-full w-full">
      {children}

      {/* Transition overlay */}
      {isTransitioning && (
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-50 transition-opacity",
            showOverlay ? "opacity-100" : "opacity-0",
          )}
          style={{ transitionDuration: `${TRANSITION_DURATION / 2}ms` }}
        >
          {/* Fade to black */}
          {transitionType === "fade-black" && <div className="h-full w-full bg-black" />}

          {/* Fade to white */}
          {transitionType === "fade-white" && <div className="h-full w-full bg-white" />}

          {/* Combat flash */}
          {transitionType === "flash-red" && <div className="h-full w-full animate-pulse bg-red-600/80" />}

          {/* Flash white */}
          {transitionType === "flash-white" && <div className="h-full w-full bg-white/90" />}

          {/* Dissolve effect */}
          {transitionType === "dissolve" && (
            <div className="h-full w-full bg-gradient-to-b from-amber-900/60 via-black/80 to-black" />
          )}

          {/* Title card */}
          {titleText && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/90">
              <div className="text-center">
                <h2 className="animate-fade-in text-3xl font-bold tracking-wide text-white/90">
                  <AnimatedText html={titleText} />
                </h2>
                <div className="mt-2 h-px w-32 mx-auto bg-gradient-to-r from-transparent via-white/50 to-transparent" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
