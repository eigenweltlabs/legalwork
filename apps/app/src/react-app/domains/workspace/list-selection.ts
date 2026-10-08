export function changeListSelection(selected: string[], visible: string[], anchor: string | null, id: string, range = false) {
  const next = new Set(selected.filter(key => visible.includes(key)));
  const start = anchor ? visible.indexOf(anchor) : -1;
  const end = visible.indexOf(id);
  if (end < 0) return { ids: [...next], anchor };
  if (range && start >= 0) {
    for (const key of visible.slice(Math.min(start, end), Math.max(start, end) + 1)) next.add(key);
  } else if (next.has(id)) next.delete(id);
  else next.add(id);
  return { ids: [...next], anchor: range && start >= 0 ? anchor : id };
}
