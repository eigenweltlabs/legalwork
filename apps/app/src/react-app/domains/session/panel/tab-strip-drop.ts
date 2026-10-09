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

/** Coordinates come from the unchanged slots, never the animated tab surfaces. */
export function tabStripPreview(tabs: { id: string; left: number; right: number }[], draggedId: string, beforeId: string | null, draggedWidth: number, gap: number) {
  const remaining = tabs.filter(tab => tab.id !== draggedId);
  const index = beforeId === null ? remaining.length : remaining.findIndex(tab => tab.id === beforeId);
  const order = [...remaining];
  order.splice(Math.max(0, index), 0, { id: draggedId, left: 0, right: draggedWidth });
  let x = tabs[0]?.left ?? 0, placeholder = x;
  const offsets = new Map<string, number>();
  for (const tab of order) {
    if (tab.id === draggedId) placeholder = x;
    else offsets.set(tab.id, x - tab.left);
    x += tab.right - tab.left + gap;
  }
  return { offsets, placeholder };
}
