/** A native drag uses the same gesture for strip ordering and pane movement. */
export function tabStripInsertion(clientX: number, tabs: { id: string; left: number; right: number }[], draggedId: string) {
  const targets = tabs.filter(tab => tab.id !== draggedId);
  const before = targets.find(tab => clientX < (tab.left + tab.right) / 2);
  return { beforeId: before?.id ?? null, x: before?.left ?? targets.at(-1)?.right ?? tabs[0]?.left ?? 0 };
}

export function insertTabBefore(ids: string[], tabId: string, beforeId: string | null) {
  if (!ids.includes(tabId) || beforeId === tabId || (beforeId !== null && !ids.includes(beforeId))) return ids;
  const result = ids.filter(id => id !== tabId);
  result.splice(beforeId === null ? result.length : result.indexOf(beforeId), 0, tabId);
  return result;
}
