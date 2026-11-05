import type { LauncherFileFilter, LauncherFileSourceKind, LauncherSearchResult } from "@legalwork/types/launcher";
import { t } from "@/i18n";

type FilterSuggestion = { id: string; title: string; files?: Partial<LauncherFileFilter>; project?: { id: string; name: string } };
type FilterProject = { id: string; name: string; displayName?: string | null; preset?: string };
type ProjectOrder = { currentProjectId?: string; recentProjectIds?: string[] };
const words = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Match whole names or word prefixes. Context only breaks ties between equally good matches. */
export function matchingFilterProjects(raw: string, projects: FilterProject[], order: ProjectOrder = {}) {
  const terms = words(raw), query = terms.join(" ");
  if (terms.join("").length < 2) return [];
  const recent = new Map((order.recentProjectIds ?? []).map((id, index) => [id, index]));
  return projects.flatMap(project => {
    if (project.preset === "wiki" || project.preset === "main-assistant") return [];
    const name = project.displayName || project.name, tokens = words(name), normalized = tokens.join(" ");
    const rank = normalized === query ? 0 : normalized.startsWith(query) ? 1 : terms.every(term => tokens.some(token => token.startsWith(term))) ? 2 : null;
    return rank === null ? [] : [{ id: project.id, name, rank }];
  }).sort((a, b) => a.rank - b.rank
    || Number(b.id === order.currentProjectId) - Number(a.id === order.currentProjectId)
    || (recent.get(a.id) ?? Infinity) - (recent.get(b.id) ?? Infinity)
    || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .slice(0, 3).map(({ id, name }) => ({ id, name }));
}
const types = [
  { words: ["emails", "email", "mails", "mail", "e-mails", "e-mail"], extensions: ["eml", "msg"], name: "emails" },
  { words: ["documents", "document", "dokumente", "dokument"], extensions: ["docx", "doc", "pdf", "md", "txt", "rtf", "odt"], name: "documents" },
  { words: ["presentations", "presentation", "powerpoint", "präsentationen", "präsentation", "praesentationen"], extensions: ["pptx", "ppt"], name: "presentations" },
  { words: ["pdf", "pdfs", "pdf-dokumente"], extensions: ["pdf"], name: "pdf" },
  { words: ["images", "image", "bilder", "bild"], extensions: ["png", "jpg", "jpeg", "webp", "gif", "tiff", "tif", "heic", "heif", "avif", "bmp", "svg", "ico"], name: "images" },
  { words: ["spreadsheets", "spreadsheet", "excel", "tabellen", "tabelle"], extensions: ["xlsx", "xls", "csv"], name: "spreadsheets" },
];
export const FILE_TYPE_PRESETS: Record<string, string[]> = Object.fromEntries(types.map(type => [type.name, type.extensions]));
export function namedFileTypeFilter(raw: string) {
  const query = raw.trim().toLocaleLowerCase();
  return types.find(type => type.words.includes(query)) ?? null;
}
const fileSources: { kind: LauncherFileSourceKind; words: string[] }[] = [
  { kind: "project", words: ["projects", "project", "projects only", "project only", "only projects", "projekte", "projekt", "nur projekte"] },
  { kind: "wiki", words: ["wiki", "wikis", "wiki only", "wikis only", "only wikis", "nur wikis", "nur wiki"] },
  { kind: "folder", words: ["folders", "folder", "added folders", "search folders", "folders only", "added folders only", "only folders", "ordner", "suchordner", "zusätzliche ordner", "nur ordner", "nur zusätzliche ordner"] },
];
export function fileSourceSuggestions(raw: string): FilterSuggestion[] {
  const query = raw.trim().toLocaleLowerCase();
  return query ? fileSources.filter(source => source.words.some(word => word.startsWith(query))).map(source => ({
    id: `filter:source:${source.kind}`, title: t(`launcher.typed.source_${source.kind}`), files: { sourceKind: source.kind },
  })) : [];
}
export function matchesLauncherFileFilter(item: Pick<LauncherSearchResult, "fileType" | "updatedAt" | "path" | "title" | "sourceKind">, filter: LauncherFileFilter) {
  if (filter.sourceKind && item.sourceKind !== filter.sourceKind) return false;
  if (item.fileType === "folder") return !filter.types?.length;
  const extension = (item.fileType ?? (item.path ?? item.title).split(".").at(-1) ?? "").toLowerCase().replace(/^\./, "");
  return (!filter.types?.length || filter.types.includes(extension)) && (!filter.modifiedAfter || item.updatedAt >= filter.modifiedAfter);
}
const units = ["days", "weeks", "months", "years"];
const names = [["day", "days", "tag", "tage", "tagen"], ["week", "weeks", "woche", "wochen"], ["month", "months", "monat", "monate", "monaten"], ["year", "years", "jahr", "jahre", "jahren"]];
const rangeLabel = (count: number, unit: string) => count === 1 ? t(`launcher.typed.last_${unit}`) : t("launcher.typed.last", { count, unit: t(`launcher.typed.${unit}`) });
export function typedFilterSuggestions(raw: string, projects: FilterProject[], now = new Date(), order: ProjectOrder = {}): FilterSuggestion[] {
  const query = raw.trim().toLocaleLowerCase();
  if (!query) return [];
  const suggestions: FilterSuggestion[] = types.filter(type => type.words.some(word => word.startsWith(query))).map(type => ({ id: `filter:type:${type.name}`, title: t(`launcher.typed.${type.name}`), files: { types: type.extensions, modifiedAfter: null } }));
  const date = /^(?:last|past|letzte[nrs]?)\s+(?:(\d+)\s*)?([\p{L}]*)$/u.exec(query);
  const ranges = date ? names.flatMap((aliases, index) => (!date[2] || aliases.some(name => name.startsWith(date[2]))) ? [{ count: Number(date[1] ?? 1), unit: units[index] }] : []) : ["last", "letzte", "past"].some(word => word.startsWith(query)) ? [{ count: 1, unit: "weeks" }, { count: 1, unit: "months" }, { count: 1, unit: "years" }] : [];
  for (const { count, unit } of ranges) {
    if (!Number.isInteger(count) || count < 1 || count > 10000) continue;
    const since = new Date(now);
    if (unit === "years") since.setFullYear(since.getFullYear() - count);
    else if (unit === "months") since.setMonth(since.getMonth() - count);
    else since.setDate(since.getDate() - count * (unit === "weeks" ? 7 : 1));
    if (since.getTime() <= 0) continue;
    suggestions.push({ id: `filter:date:${count}:${unit}`, title: rangeLabel(count, unit), files: { types: null, modifiedAfter: since.getTime() } });
  }
  for (const project of matchingFilterProjects(raw, projects, order)) suggestions.push({ id: `filter:project:${project.id}`, title: t("launcher.typed.project", { name: project.name }), project });
  return suggestions.slice(0, 10);
}

export function dateFilterLabel(since: number, now = Date.now()) {
  const days = Math.max(1, Math.round((now - since) / 86_400_000));
  const [count, unit] = days >= 360 && Math.abs(days / 365.25 - Math.round(days / 365.25)) < .02 ? [Math.round(days / 365.25), "years"] : days >= 28 && Math.abs(days / 30.44 - Math.round(days / 30.44)) < .08 ? [Math.round(days / 30.44), "months"] : days % 7 === 0 ? [days / 7, "weeks"] : [days, "days"];
  return rangeLabel(count, unit);
}
