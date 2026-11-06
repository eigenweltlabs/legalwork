import type { AssistantContextItem } from "@legalwork/types/launcher";

/** Search-result references were deliberately attached; screen selections are transient. */
export function isCapturedSelection(item: AssistantContextItem) {
  return item.type === "selection" && !/^(rec|task|chat)_/.test(item.id);
}

/** Captured selections belong to one invocation, never to a saved chat draft. */
export function persistentContext(items: AssistantContextItem[]) {
  return items.filter(item => !isCapturedSelection(item));
}
