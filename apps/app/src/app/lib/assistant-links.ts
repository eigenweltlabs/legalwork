import { LauncherInvocationActionSchema, LauncherInvocationResultActionSchema, LauncherResultReferenceSchema, type LauncherInvocation } from "@legalwork/types/launcher";

/**
 * Public links can navigate and open a question draft. Raycast stages commands
 * using its paired local connection and passes only a single-use handoff ID.
 */
export function parseAssistantDeepLink(rawUrl: string): LauncherInvocation | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  const protocol = url.protocol.toLowerCase();
  if (protocol !== "legalwork:" && protocol !== "legalwork-dev:") return null;
  const segments = [url.hostname, ...url.pathname.split("/")].map(segment => segment.trim().toLowerCase()).filter(Boolean);
  if (segments[0] !== "assistant") return null;
  const action = LauncherInvocationActionSchema.safeParse(segments[1] ?? "open");
  if (!action.success || ["quick-action", "dictate", "record", "speak", "capture-region", "capture-window"].includes(action.data)) return null;
  const read = (key: string, max: number) => { const value = url.searchParams.get(key)?.trim(); return value && value.length <= max ? value : undefined; };
  const id = read("invocation", 100) ?? `link_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  let result: LauncherInvocation["result"];
  if (url.searchParams.has("result")) {
    try { result = LauncherResultReferenceSchema.parse(JSON.parse(read("result", 12000) ?? "")); } catch { return null; }
  }
  const resultAction = url.searchParams.has("resultAction") ? LauncherInvocationResultActionSchema.safeParse(url.searchParams.get("resultAction")) : null;
  if (resultAction && (!resultAction.success || !result)) return null;
  return { id, action: action.data, query: read("q", 2000), conversationId: read("conversation", 100), projectId: read("project", 200), ...(result ? { result } : {}), source: "deep-link" };
}
export function buildAssistantDeepLink(invocation: Omit<LauncherInvocation, "source"> & { source?: LauncherInvocation["source"] }, scheme = "legalwork") {
  const url = new URL(`${scheme}://assistant/${invocation.action}`);
  url.searchParams.set("invocation", invocation.id);
  if (["quick-action", "dictate", "speak", "record", "capture-region", "capture-window"].includes(invocation.action) || invocation.query || invocation.result || invocation.actionId || invocation.resultAction || invocation.contextId)
    throw new Error("Stage this command through the authenticated Raycast handoff.");
  if (invocation.conversationId) url.searchParams.set("conversation", invocation.conversationId);
  if (invocation.projectId) url.searchParams.set("project", invocation.projectId);
  return url.toString();
}
export function isAssistantDeepLink(rawUrl: string) { return parseAssistantDeepLink(rawUrl) !== null; }
