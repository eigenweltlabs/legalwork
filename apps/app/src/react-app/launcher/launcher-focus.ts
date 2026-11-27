import { isComposingKeyEvent } from "./launcher-keyboard";

export function launcherControls(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]') ?? [])
    .filter(item => item.tabIndex >= 0 && !item.matches(':disabled, [aria-disabled="true"]') && !item.closest('[hidden], [inert]') && item.getClientRects().length > 0);
}

type FocusKey = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean; nativeEvent?: { isComposing?: boolean }; target: EventTarget | null; preventDefault: () => void; stopPropagation: () => void };

/** Forms retain native editing keys; action lists additionally support arrows, Home and End. */
export function handleLauncherFocusKey(event: FocusKey, root: HTMLElement | null, actions = false) {
  if (isComposingKeyEvent(event) || event.metaKey || event.ctrlKey || event.altKey) return false;
  const tab = event.key === "Tab";
  if (!tab && (!actions || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))) return false;
  if (!tab && event.target instanceof Element && event.target.closest('input, select, textarea, [contenteditable="true"]')) return false;
  const controls = launcherControls(root);
  if (!controls.length) return false;
  const index = controls.findIndex(item => item === document.activeElement);
  const backwards = tab ? event.shiftKey : event.key === "ArrowUp";
  const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : index < 0 ? backwards ? controls.length - 1 : 0 : (index + (backwards ? -1 : 1) + controls.length) % controls.length;
  event.preventDefault(); event.stopPropagation();
  controls[next].focus(); controls[next].scrollIntoView({ block: "nearest" });
  return true;
}
