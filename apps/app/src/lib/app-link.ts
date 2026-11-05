/** Navigation-only links in assistant answers and the bundled manual. */
export const APP_LINK_EVENT = "legalwork:open-app-link";

const pages = new Set(["home", "calendar", "projects", "workflows", "tasks", "scheduled", "recorder", "wikis", "evals"]);
const settings = new Set(["general", "account", "ai", "tabular-review", "workflows", "recorder", "office-addins", "extensions", "personalisation", "notifications", "safety", "shell", "environment", "preferences", "updates", "permissions"]);
const integrationSections = new Set(["mcp", "storage", "skills", "plugins"]);
const workflowSections = new Set(["skills", "prompts"]);

export function parseAppLink(href: string): string | null {
  // Match the authored form before URL normalization can hide traversal or escapes.
  const match = /^legalwork:\/\/app\/([a-z-]+(?:\/[a-z-]+){0,2})$/.exec(href.trim());
  if (!match) return null;
  const [page, section, detail] = match[1].split("/");
  if (pages.has(page) && !section) return `/${page}`;
  if (page !== "settings") return null;
  if (!section) return "/settings/general";
  if (!settings.has(section)) return null;
  if (detail && !(section === "extensions" && integrationSections.has(detail) || section === "workflows" && workflowSections.has(detail))) return null;
  return `/${match[1]}`;
}

export function appLinkDestination(href: string, pathname: string): string | null {
  const route = parseAppLink(href);
  if (!route) return null;
  const workspace = /^\/workspace\/([^/]+)\//.exec(pathname)?.[1];
  return workspace && route.startsWith("/settings/") ? `/workspace/${workspace}${route}` : route;
}

export function requestAppLink(href: string): void {
  if (parseAppLink(href)) window.dispatchEvent(new CustomEvent(APP_LINK_EVENT, { detail: href }));
}
