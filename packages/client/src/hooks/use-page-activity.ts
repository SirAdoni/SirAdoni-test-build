import { useEffect, useState } from "react";

function getIsPageActive() {
  if (typeof document === "undefined") return true;
  // Native file dialogs temporarily blur the window while the document stays
  // visible. Treating that blur as inactivity rerenders the whole app shell in
  // the middle of file selection and can blank mounted editors in desktop
  // shells. Visibility is the lifecycle signal we actually need here.
  return document.visibilityState === "visible";
}

export function usePageActivity() {
  const [isPageActive, setIsPageActive] = useState(getIsPageActive);

  useEffect(() => {
    const updatePageActivity = () => setIsPageActive(getIsPageActive());

    updatePageActivity();
    document.addEventListener("visibilitychange", updatePageActivity);
    window.addEventListener("pageshow", updatePageActivity);

    return () => {
      document.removeEventListener("visibilitychange", updatePageActivity);
      window.removeEventListener("pageshow", updatePageActivity);
    };
  }, []);

  return isPageActive;
}
