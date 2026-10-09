import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A stable portal host follows its document between panes. Changing the
 * destination does not recreate the editor, its undo stack or its draft. */
export function DocumentPane({ destination, children }: { destination: HTMLElement | null; children: ReactNode }) {
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "h-full min-h-0 min-w-0";
    return element;
  });
  useLayoutEffect(() => {
    if (!destination) { host.remove(); return; }
    if (host.parentElement === destination) return;
    // A state-preserving move avoids blur/focus and selection teardown in
    // native editors when both panes are connected (supported by Electron).
    if (host.isConnected && destination.isConnected && "moveBefore" in destination && typeof destination.moveBefore === "function") {
      destination.moveBefore(host, null); return;
    }
    const focused = host.contains(document.activeElement) && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    destination.appendChild(host);
    focused?.focus({ preventScroll: true });
  }, [destination, host]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return createPortal(children, host);
}
