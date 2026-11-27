import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useDetachedWindow } from "@/react-app/shell/use-detached-window";

const NAVIGATE_EVENT = "legalwork:navigate";

/** The main window follows routes the quick panel hands over: expand into Home, open a file, resume a chat. */
export function DesktopNavigateListener() {
  const navigate = useNavigate();
  const detached = useDetachedWindow();
  useEffect(() => {
    if (detached) return;
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== "string" || !event.detail.startsWith("/")) return;
      navigate(event.detail);
    };
    window.addEventListener(NAVIGATE_EVENT, listener);
    return () => window.removeEventListener(NAVIGATE_EVENT, listener);
  }, [navigate, detached]);
  return null;
}
