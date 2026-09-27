import { searchTerms, type ContentSearchKind, type ContentSearchResult } from "@legalwork/types/search";

const recentOrder: Record<ContentSearchKind, number> = { sessions: 0, projects: 1, tasks: 2, files: 3 };
const typeBoost: Record<ContentSearchKind, number> = { projects: 30, tasks: 20, sessions: 0, files: 0 };

/** Rank relevance across types; corpus size and repeated body text confer no advantage. */
export function rankSearchResults(items: ContentSearchResult[], query: string): ContentSearchResult[] {
  const terms = searchTerms(query);
  const phrase = terms.join(" ");
  const ranked = items.map(item => {
    const title = item.title.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
    const titleMatch = !phrase ? 0 : title === phrase ? 4 : title.startsWith(phrase) ? 3
      : title.includes(phrase) ? 2 : terms.every(term => title.includes(term)) ? 1 : 0;
    // Type boosts can break ties within a match level, never overturn a better
    // title match. Shorter matching titles are more specific within that level.
    const score = !phrase ? -recentOrder[item.kind] : titleMatch * 100 + typeBoost[item.kind]
      + (titleMatch ? Math.min(1, phrase.length / title.length) * 10 : 0);
    // Completion breaks ties within a relevance tier. A precise completed-task
    // title still beats an incidental body match, and remains searchable.
    return { item, score: score - (item.kind === "tasks" && item.completed ? (phrase ? 45 : 1) : 0) };
  });
  ranked.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt
    || a.item.title.localeCompare(b.item.title) || a.item.workspaceId.localeCompare(b.item.workspaceId)
    || a.item.id.localeCompare(b.item.id));
  return ranked.map(({ item }) => item);
}
