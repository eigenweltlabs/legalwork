import type { AssistantContextItem } from "@legalwork/types/launcher";

/** Search-result references were deliberately attached; screen selections are transient. */
export function isCapturedSelection(item: AssistantContextItem) {
  return item.type === "selection" && !/^(rec|task|chat)_/.test(item.id);
}

/** Captured selections belong to one invocation, never to a saved chat draft. */
export function persistentContext(items: AssistantContextItem[]) {
  return items.filter(item => !isCapturedSelection(item));
}

/** Explicit handoff preserves the selected passage as a deliberate draft attachment. */
export function handoffContext(items: AssistantContextItem[]): AssistantContextItem[] {
  return items.map(item => isCapturedSelection(item) && item.type === "selection" ? {
    id: item.id, type: "clipboard", capturedAt: item.capturedAt,
    text: [[item.sourceApp, item.sourceWindow].filter(Boolean).join(" · "), item.text].filter(Boolean).join("\n\n"),
  } : item);
}
