import { LauncherInvocationActionSchema, type LauncherInvocation } from "@legalwork/types/launcher";

/**
 * `legalwork://assistant/<action>?...` opens the quick panel. Only identifiers
 * travel in the URL: an opaque staged-context reference and an invocation ID.
 * Document contents, tokens and paths never do.
 */
export function parseAssistantDeepLink(rawUrl: string): LauncherInvocation | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "legalwork:" && protocol !== "legalwork-dev:") return null;
  const segments = [url.hostname, ...url.pathname.split("/")].map(segment => segment.trim().toLowerCase()).filter(Boolean);
  if (segments[0] !== "assistant") return null;
  const action = LauncherInvocationActionSchema.safeParse(segments[1] ?? "open");
  if (!action.success) return null;
  const read = (key: string, max: number) => { const value = url.searchParams.get(key)?.trim(); return value && value.length <= max ? value : undefined; };
  const id = read("invocation", 100) ?? `link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return { id, action: action.data, query: read("q", 2000), conversationId: read("conversation", 100), projectId: read("project", 200), actionId: read("action", 200), contextId: read("context", 100), source: "deep-link" };
}
export function buildAssistantDeepLink(invocation: Omit<LauncherInvocation, "source"> & { source?: LauncherInvocation["source"] }, scheme = "legalwork") {
  const url = new URL(`${scheme}://assistant/${invocation.action}`);
  url.searchParams.set("invocation", invocation.id);
  if (invocation.query) url.searchParams.set("q", invocation.query);
  if (invocation.conversationId) url.searchParams.set("conversation", invocation.conversationId);
  if (invocation.projectId) url.searchParams.set("project", invocation.projectId);
  if (invocation.actionId) url.searchParams.set("action", invocation.actionId);
  if (invocation.contextId) url.searchParams.set("context", invocation.contextId);
  return url.toString();
}
export function isAssistantDeepLink(rawUrl: string) { return parseAssistantDeepLink(rawUrl) !== null; }
