import { useState } from "react";
import { useLocation } from "react-router-dom";

const STORAGE_KEY = "legalwork.detached-window";

/** Window identity must survive navigation, route remounts, and reloads. */
export function useDetachedWindow() {
  const { search } = useLocation();
  const [detached] = useState(() => {
    const requested = new URLSearchParams(search).get("detached") === "1";
    try {
      // sessionStorage is isolated per window; never persist this in the shared
      // sidebar preferences or localStorage, which also affect the main window.
      if (requested) window.sessionStorage.setItem(STORAGE_KEY, "1");
      return requested || window.sessionStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return requested;
    }
  });
  return detached;
}
