import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import {
  PROFESSOR_MARI_FLOATING_HIDE_EVENT,
  PROFESSOR_MARI_FLOATING_SHOW_EVENT,
  rememberProfessorMariFloatingEnabled,
} from "./professor-mari-floating-events";
import { useChatStore } from "../../stores/chat.store";

const ProfessorMariFloatingAssistant = lazy(() =>
  import("./HomeProfessorMariChat").then((module) => ({ default: module.ProfessorMariFloatingAssistant })),
);

interface ProfessorMariFloatingAssistantHostProps {
  active: boolean;
}

export function ProfessorMariFloatingAssistantHost({ active }: ProfessorMariFloatingAssistantHostProps) {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(active);
  const hasActiveGeneration = useChatStore((state) => state.abortControllers.size > 0);

  const dismissFloating = useCallback(() => {
    rememberProfessorMariFloatingEnabled(false);
    setVisible(false);
  }, []);

  useEffect(() => {
    if (active) {
      setMounted(true);
      setVisible(true);
    } else {
      setVisible(false);
    }
  }, [active]);

  useEffect(() => {
    const showFloating = () => {
      rememberProfessorMariFloatingEnabled(true);
      setMounted(true);
      setVisible(true);
    };
    const hideFloating = () => {
      setVisible(false);
    };

    window.addEventListener(PROFESSOR_MARI_FLOATING_SHOW_EVENT, showFloating);
    window.addEventListener(PROFESSOR_MARI_FLOATING_HIDE_EVENT, hideFloating);
    return () => {
      window.removeEventListener(PROFESSOR_MARI_FLOATING_SHOW_EVENT, showFloating);
      window.removeEventListener(PROFESSOR_MARI_FLOATING_HIDE_EVENT, hideFloating);
    };
  }, []);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    if (!mounted || hasActiveGeneration) return;
    const timeout = window.setTimeout(() => setMounted(false), 300);
    return () => window.clearTimeout(timeout);
  }, [hasActiveGeneration, mounted, visible]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (visible) {
      document.documentElement.dataset.professorMariFloating = "true";
      return () => {
        delete document.documentElement.dataset.professorMariFloating;
      };
    }
    delete document.documentElement.dataset.professorMariFloating;
  }, [visible]);

  if (!mounted) return null;

  return (
    <div className={visible ? undefined : "hidden"} aria-hidden={!visible}>
      <Suspense fallback={null}>
        <ProfessorMariFloatingAssistant onDismiss={dismissFloating} />
      </Suspense>
    </div>
  );
}
