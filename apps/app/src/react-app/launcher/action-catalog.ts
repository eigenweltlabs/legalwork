import { resultKey } from "./launcher-search-session";
import { launcherResultActions } from "@legalwork/types/launcher";
import type { LauncherCatalogEntry, LauncherInvocationAction, LauncherSearchResult } from "@legalwork/types/launcher";
import { t } from "@/i18n";

/** App actions live beside engine commands and saved quick actions in one catalog with one dispatcher. */
export type AppActionId = "app.new-conversation" | "app.resume" | "app.search-files" | "app.search-projects" | "app.search-chats" | "app.search-tasks" | "app.search-recordings" | "app.ask" | "app.speak" | "app.dictate" | "app.record" | "app.capture-region" | "app.capture-window" | "app.add-selection" | "app.paste-clipboard" | "app.attach-file" | "app.show-work" | "app.open-home" | "app.open-settings" | "app.new-project";
const APP_ACTIONS: { id: AppActionId; kind: LauncherCatalogEntry["kind"]; invocation: LauncherInvocationAction | null; aliases: string[]; desktopOnly?: boolean }[] = [
  { id: "app.new-conversation", kind: "navigation", invocation: "new-conversation", aliases: ["new", "neu"] },
  { id: "app.resume", kind: "navigation", invocation: "resume", aliases: ["resume", "weiter"] },
  { id: "app.search-files", kind: "navigation", invocation: "files", aliases: ["files", "dateien"] },
  { id: "app.search-projects", kind: "navigation", invocation: "projects", aliases: ["projects", "projekte"] },
  { id: "app.search-chats", kind: "navigation", invocation: "chats", aliases: ["chats"] },
  { id: "app.search-tasks", kind: "navigation", invocation: "tasks", aliases: ["tasks", "aufgaben"] },
  { id: "app.search-recordings", kind: "navigation", invocation: "recordings", aliases: ["recordings", "aufnahmen"] },
  { id: "app.ask", kind: "agent", invocation: "ask", aliases: ["ask", "fragen"] },
  { id: "app.speak", kind: "native", invocation: "speak", aliases: ["speak", "sprechen"], desktopOnly: true },
  { id: "app.dictate", kind: "native", invocation: "dictate", aliases: ["dictate", "diktieren"], desktopOnly: true },
  { id: "app.record", kind: "native", invocation: "record", aliases: ["record", "aufnehmen"], desktopOnly: true },
  { id: "app.capture-region", kind: "native", invocation: "capture-region", aliases: ["region", "screenshot"], desktopOnly: true },
  { id: "app.capture-window", kind: "native", invocation: "capture-window", aliases: ["window", "fenster"], desktopOnly: true },
  { id: "app.add-selection", kind: "native", invocation: null, aliases: ["selection", "auswahl"], desktopOnly: true },
  { id: "app.paste-clipboard", kind: "native", invocation: null, aliases: ["clipboard", "zwischenablage"] },
  { id: "app.attach-file", kind: "native", invocation: null, aliases: ["attach", "anhängen"] },
  { id: "app.show-work", kind: "navigation", invocation: "work", aliases: ["work", "arbeit"] },
  { id: "app.open-home", kind: "navigation", invocation: "open", aliases: ["home"] },
  { id: "app.open-settings", kind: "navigation", invocation: null, aliases: ["settings", "einstellungen"] },
  { id: "app.new-project", kind: "navigation", invocation: null, aliases: ["project", "projekt"] },
];
export function appActionEntries(options: { desktop: boolean; favorites: Set<string>; recent: Map<string, number>; shortcuts: Record<string, string> }): LauncherCatalogEntry[] {
  return APP_ACTIONS.filter(action => options.desktop || !action.desktopOnly).map(action => ({
    id: action.id, label: t(`launcher.action.${action.id.slice(4)}`), description: null, aliases: action.aliases, kind: action.kind, source: "app", requires: action.id === "app.add-selection" ? ["selection"] : [],
    target: "none", outputs: [], workspaceId: null, shortcut: options.shortcuts[action.id] ?? null, favorite: options.favorites.has(action.id), usedAt: options.recent.get(action.id) ?? null, command: null, quickAction: null,
  }));
}
export function invocationForAppAction(id: string): LauncherInvocationAction | null {
  return APP_ACTIONS.find(action => action.id === id)?.invocation ?? null;
}

/** Catalog lookup for the command menu: `/` plus text matches labels, aliases and descriptions. */
export function filterCatalog(entries: LauncherCatalogEntry[], query: string, limit = 40): LauncherCatalogEntry[] {
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  const scored = entries.map(entry => {
    const label = entry.label.toLowerCase().replace(/^\//, "");
    const aliases = entry.aliases.map(alias => alias.toLowerCase().replace(/^\//, ""));
    let score = 0;
    if (!needle) score = 1;
    else if (label === needle || aliases.includes(needle)) score = 100;
    else if ([label, ...aliases].some(alias => needle.startsWith(`${alias} `))) score = 110;
    else if (label.startsWith(needle) || aliases.some(alias => alias.startsWith(needle))) score = 80;
    else if (label.includes(needle) || aliases.some(alias => alias.includes(needle))) score = 50;
    else if (entry.description?.toLowerCase().includes(needle)) score = 20;
    return { entry, score: score ? score + (entry.favorite ? 5 : 0) + Math.min(4, (entry.usedAt ?? 0) > 0 ? 2 : 0) : 0 };
  }).filter(item => item.score > 0);
  return scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label)).slice(0, limit).map(item => item.entry);
}
export function catalogArguments(entry: LauncherCatalogEntry, query: string) {
  const value = query.trim().replace(/^\//, "");
  const names = [entry.label, ...entry.aliases].map(name => name.replace(/^\//, "")).sort((a, b) => b.length - a.length);
  const matched = names.find(name => value.toLowerCase() === name.toLowerCase() || value.toLowerCase().startsWith(`${name.toLowerCase()} `));
  return matched ? value.slice(matched.length).trim() : "";
}

/** Enter always opens the item; the action menu never duplicates it. */
export function primaryResultAction(_result: LauncherSearchResult): "open" { return "open"; }

/** Actions apply to the focused result, or to every member of its explicit selection. */
export function launcherActionSelection(result: LauncherSearchResult, results: LauncherSearchResult[], selected: Set<string>) {
  const items = selected.has(resultKey(result)) ? results.filter(item => selected.has(resultKey(item))) : [];
  return items.some(item => resultKey(item) === resultKey(result)) ? items : [result];
}
export function resultActionMenu(result: LauncherSearchResult, selection: LauncherSearchResult[] = [result], localExternal = false): LauncherSearchResult["actions"] {
  const actions = launcherResultActions(result).filter(action => action !== "open"
    && selection.every(item => launcherResultActions(item).includes(action))
    && (action !== "compare" || selection.length >= 2));
  if (localExternal && result.kind === "files" && result.folderId && selection.length === 1) {
    if (result.fileType === "folder") actions.push("open-external");
    actions.push("reveal");
  }
  return actions;
}
