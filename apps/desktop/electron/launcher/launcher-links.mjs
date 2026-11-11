const ACTIONS = new Set(["open", "search", "files", "projects", "chats", "tasks", "recordings", "ask", "speak", "dictate", "record", "capture-region", "capture-window", "quick-action", "work", "new-conversation", "resume"]);
const KINDS = new Set(["files", "projects", "chats", "tasks", "recordings"]);

/** Mirrors LauncherResultReferenceSchema without loading TypeScript in Electron. */
function resultReference(raw) {
  if (!raw || raw.length > 12000) throw new Error("Invalid result reference");
  const value = JSON.parse(raw);
  const text = (key, max) => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= max;
  if (!value || typeof value !== "object" || Array.isArray(value) || !KINDS.has(value.kind)
    || !text("id", 4096) || !text("sourceId", 300) || value.workspaceId !== null && !text("workspaceId", 200)
    || value.folderId !== undefined && !text("folderId", 100) || value.sessionId !== undefined && !text("sessionId", 200)
    || value.path !== undefined && (typeof value.path !== "string" || value.path.length > 4096)
    || value.fileType !== undefined && value.fileType !== "folder"
    || value.kind !== "files" && (value.path !== undefined || value.folderId !== undefined || value.fileType !== undefined)
    || value.kind !== "chats" && value.sessionId !== undefined
    || Object.keys(value).some(key => !["kind", "id", "sourceId", "workspaceId", "folderId", "sessionId", "path", "fileType"].includes(key))) throw new Error("Invalid result reference");
  return value;
}

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
  let result;
  if (url.searchParams.has("result")) {
    try { result = resultReference(url.searchParams.get("result")); } catch { return null; }
  }
  const resultAction = url.searchParams.get("resultAction");
  if (resultAction !== null && (!result || !["open", "chat-with-assistant", "ask", "summarize"].includes(resultAction))) return null;
  return { id: read("invocation", 100) ?? `link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`, action: /** @type {import("@legalwork/types/launcher").LauncherInvocationAction} */ (action), query: read("q", 2000), conversationId: read("conversation", 100), projectId: read("project", 200), actionId: read("action", 200), contextId: read("context", 100), ...(result ? { result } : {}), ...(resultAction ? { resultAction: /** @type {NonNullable<import("@legalwork/types/launcher").LauncherInvocation["resultAction"]>} */ (resultAction) } : {}), source: "deep-link" };
}
export function isAssistantLink(rawUrl) { return parseAssistantLink(rawUrl) !== null; }
