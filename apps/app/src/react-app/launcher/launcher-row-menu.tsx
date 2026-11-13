import { useEffect, useRef } from "react";
import { Check } from "lucide-react";
import { handleLauncherFocusKey } from "./launcher-focus";

export function LauncherRowMenu({ title, actions, onClose }: { title: string; actions: { id: string; title: string; checked?: boolean; run: () => void }[]; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector("button"))?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape" || event.key === "ArrowLeft") { event.preventDefault(); event.stopImmediatePropagation(); close.current(); return; }
      if (handleLauncherFocusKey(event, menu.current, true)) event.stopImmediatePropagation();
    };
    const pointer = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target)) close.current(); };
    document.addEventListener("keydown", key, true); document.addEventListener("pointerdown", pointer, true);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", pointer, true); };
  }, []);
  return <div ref={menu} className="launcher-actions-menu" role="menu" aria-label={title}>{actions.map(action => <button key={action.id} type="button" role={action.checked === undefined ? "menuitem" : "menuitemradio"} aria-checked={action.checked} onMouseMove={event => event.currentTarget.focus()} onClick={action.run}>{action.checked !== undefined && <span className="inline-flex w-4 shrink-0">{action.checked && <Check className="size-3.5" />}</span>}{action.title}</button>)}</div>;
}
