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

const creationTerms = {
  "project-chat": ["chat", "conversation", "project chat", "chat in project", "chat in app", "projektchat", "unterhaltung", "chat in eigenwelt"],
  "mini-chat": ["chat", "conversation", "mini-bar", "mini bar", "mini chat", "chat in mini-bar", "assistant", "unterhaltung", "chat in der mini-bar"],
  document: ["file", "document", "markdown", "md", "datei", "dokument"],
  docx: ["docx", "word", "word document", "word-dokument"],
  text: ["txt", "text", "text file", "textdatei"],
  task: ["task", "aufgabe"],
  project: ["project", "projekt"],
  recording: ["recording", "meeting", "aufnahme", "besprechung"],
};
export type LauncherCreationAction = keyof typeof creationTerms;

/** Match an explicit creation prefix; ordinary searches such as “New York” still search normally. */
export function launcherCreationActions(raw: string, inProject: boolean): LauncherCreationAction[] {
  const match = /^(?:n|ne|new|neu|neue|neuer|neues|neuen)(?:\s+(.+))?$/u.exec(raw.trim().toLocaleLowerCase());
  if (!match) return [];
  const actions: LauncherCreationAction[] = inProject ? ["project-chat", "mini-chat"] : ["mini-chat", "project-chat"];
  actions.push("document", "docx", "text", "task", "project", "recording");
  const term = match[1];
  return term ? actions.filter(action => creationTerms[action].some(alias => alias.startsWith(term))) : actions;
}
