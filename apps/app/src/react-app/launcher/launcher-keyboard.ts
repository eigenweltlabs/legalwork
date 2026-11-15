import type { LauncherResultAction, LauncherSearchResult } from "@legalwork/types/launcher";

export type LauncherSelection = { id: string | null; source: "auto" | "keyboard" | "pointer" };
export type SelectableItem = { id: string; primaryAction?: LauncherResultAction | "run" | "open-conversation" | "resume" | null };

/** Arriving results never move a selection the user made; a vanished item requires a new selection. */
export function reconcileSelection(previous: LauncherSelection, items: SelectableItem[]): LauncherSelection {
  if (previous.source !== "auto") {
    if (previous.id && items.some(item => item.id === previous.id)) return previous;
    return { id: null, source: previous.source };
  }
  return { id: items[0]?.id ?? null, source: "auto" };
}
export function moveSelection(current: LauncherSelection, items: SelectableItem[], delta: 1 | -1): LauncherSelection {
  if (!items.length) return { id: null, source: "keyboard" };
  const index = current.id ? items.findIndex(item => item.id === current.id) : -1;
  const next = index < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, index + delta));
  return { id: items[next].id, source: "keyboard" };
}
/** Hovering only expands at the lower edge, while more content is still out of sight. */
export function shouldExpandLauncherList(body: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">, distanceToBottom?: number) {
  if (distanceToBottom === undefined) return body.scrollTop > 48;
  return distanceToBottom >= 0 && distanceToBottom <= 12 && body.scrollHeight - body.clientHeight - body.scrollTop > 1;
}

/** Enter runs the selected row's visible primary action. No selection means no implicit request. */
export function enterTarget(selection: LauncherSelection, items: SelectableItem[]): SelectableItem | null {
  return selection.id ? items.find(item => item.id === selection.id) ?? null : null;
}

export const RESULT_KIND_ORDER = ["projects", "files", "chats", "tasks", "recordings"] as const;
export function orderLauncherResults(items: LauncherSearchResult[]) {
  return RESULT_KIND_ORDER.flatMap(kind => items.filter(item => item.kind === kind));
}
// Result keys contain NUL separators, which cannot be addressed by CSS selectors.
export function optionId(key: string) { return `launcher-option-${encodeURIComponent(key)}`; }

export type EscapeLayer = "overlay" | "view" | "query" | "filter" | "panel";
/** Back out of the innermost surface before dismissing the launcher. */
export function escapeAction(state: { overlayOpen: boolean; category: boolean; query: boolean; detail: boolean }): EscapeLayer {
  if (state.overlayOpen) return "overlay";
  if (state.detail) return "view";
  if (state.query) return "query";
  if (state.category) return "filter";
  return "panel";
}

/** IME composition never submits (isComposing, keyCode 229 on some engines). */
export function isComposingKeyEvent(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }) {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229);
}

/** The primary confirmation key across launcher forms and their nested pickers. */
export function isLauncherConfirmKey(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } }, mac: boolean) {
  return !isComposingKeyEvent(event) && !event.altKey && event.key === "Enter" && (mac ? event.metaKey : event.ctrlKey);
}

export type FooterVerb = "open" | "run" | "attach" | "ask" | "resume" | "answer" | "none";
export function footerVerb(target: SelectableItem | null, mode: "search" | "command" | "ask" | "conversation"): FooterVerb {
  if (mode === "ask" || mode === "conversation") return "ask";
  if (!target) return "none";
  switch (target.primaryAction) {
    case "run": return "run";
    case "attach": return "attach";
    case "ask": return "ask";
    case "resume": case "open-conversation": return "resume";
    case "complete": return "answer";
    default: return "open";
  }
}

/** Search can become a question directly; explicit chat/Ask keeps Shift+Enter for newlines. */
export function isAskShortcut(input: { key: string; modifier: boolean; shift: boolean; mode: "search" | "command" | "ask" | "conversation"; command: boolean }) {
  return input.key === "Enter" && !input.command && (input.modifier || input.shift && input.mode === "search");
}
