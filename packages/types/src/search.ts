export type ContentSearchKind = "sessions" | "projects" | "tasks" | "files";

export type SearchSourceReference = {
  path: string;
  hash: string;
  page: number | null;
  source: "native" | "ocr";
  quote: string;
  preparationPath?: string;
  regions?: Array<{ x: number; y: number; width: number; height: number }>;
};

export type SearchSourcePage = {
  path: string; name: string; page: number; quote: string; image: string;
  regions: Array<{ x: number; y: number; width: number; height: number }>;
};

export type ContentSearchResult = {
  kind: ContentSearchKind;
  id: string;
  workspaceId: string;
  title: string;
  excerpt: string;
  updatedAt: number;
  messageId?: string;
  path?: string;
  sources?: SearchSourceReference[];
  sourcesLimited?: boolean;
  incomplete?: boolean;
  completed?: boolean;
};

export type ContentSearchResponse = {
  items: ContentSearchResult[];
  limited?: boolean;
  skipped?: number;
  preparing?: number;
  incomplete?: number;
  issues?: Array<{ path: string; reason: string }>;
  retryable?: boolean;
};

export function searchTerms(query: string): string[] {
  return query.normalize("NFC").trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
}

export function matchesSearch(text: string, query: string): boolean {
  const value = text.normalize("NFC").toLowerCase();
  return searchTerms(query).every(term => value.includes(term));
}

export function searchExcerpt(text: string, query: string): string {
  const value = text.normalize("NFC").replace(/\s+/g, " ").trim();
  const indices = searchTerms(query).map(term => value.toLowerCase().indexOf(term)).filter(index => index >= 0);
  const start = Math.max(0, (indices.length ? Math.min(...indices) : 0) - 65);
  return `${start ? "…" : ""}${value.slice(start, start + 240)}${value.length > start + 240 ? "…" : ""}`;
}
