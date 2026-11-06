const ACTIONS = new Set(["open", "search", "files", "projects", "chats", "tasks", "recordings", "ask", "speak", "dictate", "record", "capture-region", "capture-window", "quick-action", "work", "new-conversation", "resume"]);

/**
 * `legalwork://assistant/<action>?invocation=…&q=…&context=…`: identifiers only, never content. Mirrors the app's parser.
 * @returns {import("@legalwork/types/launcher").LauncherInvocation | null}
 */
export function parseAssistantLink(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl)); } catch { return null; }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "legalwork:" && protocol !== "legalwork-dev:") return null;
  const segments = [url.hostname, ...url.pathname.split("/")].map(segment => segment.trim().toLowerCase()).filter(Boolean);
  if (segments[0] !== "assistant") return null;
  const action = segments[1] ?? "open";
  if (!ACTIONS.has(action)) return null;
  const read = (key, max) => { const value = url.searchParams.get(key)?.trim(); return value && value.length <= max ? value : undefined; };
  return { id: read("invocation", 100) ?? `link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`, action: /** @type {import("@legalwork/types/launcher").LauncherInvocationAction} */ (action), query: read("q", 2000), conversationId: read("conversation", 100), projectId: read("project", 200), actionId: read("action", 200), contextId: read("context", 100), source: "deep-link" };
}
export function isAssistantLink(rawUrl) { return parseAssistantLink(rawUrl) !== null; }
