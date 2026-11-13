import { DEFAULT_LAUNCHER_ALIASES, LAUNCHER_SEARCH_KINDS, type LauncherSearchKind } from "@legalwork/types/launcher";
import { LANGUAGES, t } from "@/i18n";

export type LauncherAliases = Record<LauncherSearchKind, string>;
export type LauncherEntryMode = "search" | "command" | "ask";
export type ParsedLauncherEntry = { mode: LauncherEntryMode; text: string };

const ALIAS_PATTERN = /^[a-z0-9]{1,3}$/;
const normalize = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().trim();
const browseLabels = (kind: LauncherSearchKind) => LANGUAGES.map(lng => t("launcher.suggest.browse", { lng, category: t(`launcher.kind.${kind}`, lng) }));
export const CATEGORY_WORDS: Record<LauncherSearchKind, string[]> = {
  files: ["files", "file", "dateien", "datei", "doc", "docs", "document", "documents", "dokument", "dokumente"], projects: ["projects", "project", "projekte", "projekt"],
  chats: ["chats", "chat", "conversations", "gespräche"], tasks: ["tasks", "task", "aufgaben", "aufgabe", "todos"],
  recordings: ["recordings", "recording", "aufnahmen", "aufnahme"],
};

/** Full category names browse immediately; partial names and aliases complete first. */
export function namedCategoryQuery(raw: string): { category: LauncherSearchKind; rest: string } | null {
  const text = raw.trim().replace(/^(?:browse|anzeigen|durchsuchen)\s+/i, "").replace(/\s+(?:anzeigen|durchsuchen)$/i, "");
  const [word] = text.toLocaleLowerCase().split(/\s+/);
  const category = LAUNCHER_SEARCH_KINDS.find(kind => CATEGORY_WORDS[kind].includes(word));
  return category ? { category, rest: text.split(/\s+/).slice(1).join(" ") } : null;
}
export function isBrowseActionQuery(raw: string) {
  const query = normalize(raw);
  return Boolean(query) && (["browse", "anzeigen", "durchsuchen"].some(word => word.startsWith(query) || query.startsWith(`${word} `)) || /\s+(anzeigen|durchsuchen)$/.test(query));
}
export function matchesOpenBrowser(raw: string) {
  const query = normalize(raw);
  return Boolean(query) && ["browser", "open browser", "browser öffnen", "browser oeffnen", "öffnen", "oeffnen", ...LANGUAGES.map(lng => t("launcher.browser.open", lng))].some(label => normalize(label).startsWith(query));
}
export function categorySuggestions(raw: string, aliases: LauncherAliases): LauncherSearchKind[] {
  const query = raw.trim().toLocaleLowerCase();
  if (!query) return [...LAUNCHER_SEARCH_KINDS];
  const named = namedCategoryQuery(raw);
  const labelled = LAUNCHER_SEARCH_KINDS.filter(kind => browseLabels(kind).some(label => normalize(label).startsWith(normalize(query))));
  if (named && !labelled.length) return named.rest ? [] : [named.category];
  return LAUNCHER_SEARCH_KINDS.filter(kind => aliases[kind] === query || labelled.includes(kind) || CATEGORY_WORDS[kind].some(word => [word, `browse ${word}`, `anzeigen ${word}`, `durchsuchen ${word}`].some(label => normalize(label).startsWith(normalize(query)))))
    .sort((a, b) => Number(aliases[b] === query) - Number(aliases[a] === query));
}

/** Aliases are configurable; collisions are reported, never silently resolved. */
export function normalizeLauncherAliases(input: Partial<Record<string, string>> | null | undefined): LauncherAliases {
  const aliases = { ...DEFAULT_LAUNCHER_ALIASES };
  for (const kind of LAUNCHER_SEARCH_KINDS) {
    const value = input?.[kind]?.trim().toLowerCase();
    if (value && ALIAS_PATTERN.test(value)) aliases[kind] = value;
  }
  return aliases;
}
export function launcherAliasCollisions(aliases: LauncherAliases): { alias: string; kinds: LauncherSearchKind[] }[] {
  const byAlias = new Map<string, LauncherSearchKind[]>();
  for (const kind of LAUNCHER_SEARCH_KINDS) byAlias.set(aliases[kind], [...(byAlias.get(aliases[kind]) ?? []), kind]);
  return [...byAlias].filter(([, kinds]) => kinds.length > 1).map(([alias, kinds]) => ({ alias, kinds }));
}

/**
 * Whether typing turned the start of the query into a category chip. Only an
 * exact alias followed by its delimiter counts: `f` alone, pasted prose and
 * text inside an active conversation stay ordinary text.
 */
export function activateCategoryAlias(raw: string, aliases: LauncherAliases, delimiter: "space" | "tab" = "space"): { category: LauncherSearchKind; rest: string } | null {
  const match = delimiter === "space" ? /^(\S+) ([\s\S]*)$/.exec(raw) : /^(\S+)$/.exec(raw);
  if (!match) return null;
  const kind = LAUNCHER_SEARCH_KINDS.find(kind => aliases[kind] === match[1].toLowerCase() || CATEGORY_WORDS[kind].includes(match[1].toLowerCase()));
  return kind ? { category: kind, rest: match[2] ?? "" } : null;
}

/** Commands start with `/`; `?` plus a space enters a conversation. Everything else searches. */
export function parseLauncherEntry(raw: string): ParsedLauncherEntry {
  if (raw.startsWith("/")) return { mode: "command", text: raw.slice(1) };
  if (/^\? /.test(raw)) return { mode: "ask", text: raw.slice(2) };
  if (raw === "?") return { mode: "ask", text: "" };
  return { mode: "search", text: raw };
}

/** A question-shaped search remains a search until the user chooses Ask. */
export function looksLikeQuestion(text: string) {
  return /\?\s*$/.test(text.trim()) || /^(wer|was|wann|wo|wie|warum|welche[rs]?|who|what|when|where|why|how|which)\b/i.test(text.trim());
}
