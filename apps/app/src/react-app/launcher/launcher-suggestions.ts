export function matchesAssistantSuggestion(raw: string, name?: string | null) {
  const query = raw.trim().toLocaleLowerCase();
  return query.length >= 2 && ["assistant", "ask", "fragen", name].some(word => word?.toLocaleLowerCase().startsWith(query));
}

export function matchesSortSuggestion(raw: string) {
  const query = raw.trim().toLocaleLowerCase();
  return query.length >= 2 && ["sort", "sorted", "sort by", "sorting", "sortieren", "sortierung", "sortiert", "reihenfolge"].some(word => word.startsWith(query));
}

/** Explicit Assistant intent always precedes filters, shortcuts, history and result matches. */
export function prioritizeLauncherSuggestions<T extends { id: string }>(rows: T[], shortcutCategory?: string) {
  const rank = (id: string) => id === "search:assistant" ? 0 : id === "search:sort" ? 1 : id.startsWith("filter:source:") ? 2 : id === "action:browser" ? 3 : id === `category:${shortcutCategory}` ? 4 : 5;
  return [...rows].sort((a, b) => rank(a.id) - rank(b.id));
}
