import { isAbsolute, relative, resolve, sep } from "node:path";
import { ApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import type { Actor } from "./types.js";

/** Normalize routing segments once. File-read suffixes are filesystem paths. */
export function nativeProxyPath(input: string): string {
  const raw = input.trim().replace(/^\/opencode(?=\/|$)/, "").replace(/\/+$/, "") || "/";
  const file = raw.match(/^(?:\/api)?\/fs\/read\/(.*)$/);
  if (file) return `/fs/read/${file[1]}`;
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new ApiError(400, "invalid_path", "Invalid engine path."); }
  if (/\\|\/\/|(?:^|\/)\.{1,2}(?:\/|$)|%/.test(decoded)) throw new ApiError(400, "invalid_path", "Ambiguous engine path.");
  return decoded.replace(/^\/api(?=\/|$)/, "") || "/";
}

export function assertNativeProxyRoute(actor: Actor, method: string, input: string) {
  const path = nativeProxyPath(input);
  const write = !["GET", "HEAD"].includes(method.toUpperCase());
  if ((actor.scope ?? "viewer") === "viewer" && write) throw new ApiError(403, "forbidden", "Viewer tokens are read-only.");
  if (/^\/credential(?:\/|$)/.test(path)) throw new ApiError(403, "credential_metadata_only", "Use LegalWork connection metadata and disconnect controls; credential values stay inside the engine.");
  if (/^\/(?:pty|experimental\/persistent-pty)(?:\/|$)/.test(path) || /^\/experimental\/session\/[^/]+\/terminal(?:\/|$)/.test(path)) throw new ApiError(403, "engine_terminal_disabled", "Use the LegalWork terminal or sandboxed shell.");
  if (/^\/(?:debug|rpc)(?:\/|$)/.test(path) || path === "/pair") throw new ApiError(403, "engine_admin_owned", "This engine operation is managed by LegalWork.");
  if (/^\/worktree(?:\/|$)/.test(path) || write && path === "/vcs/init") throw new ApiError(403, "coding_workflow_unavailable", "Git worktrees and repository setup are outside LegalWork's legal workflows.");
  if (write && (path === "/experimental/config" || /^\/experimental\/mcp\/[^/]+$/.test(path) || path === "/experimental/integration/wellknown" || /^\/plugin(?:\/|$)/.test(path) || /^\/project(?:\/|$)/.test(path))) throw new ApiError(403, "settings_owned", "Change managed definitions through LegalWork settings.");
  if (write && path === "/experimental/session/import") throw new ApiError(403, "session_import_owned", "Import chats through the LegalWork session API.");
  if (method.toUpperCase() === "DELETE" && /^\/session\/[^/]+$/.test(path)) throw new ApiError(409, "session_delete_requires_review", "Delete chats through LegalWork so unsaved dashboards can be reviewed.");
}

export function nativeProxySessionID(path: string): string | undefined {
  const match = nativeProxyPath(path).match(/^\/(?:experimental\/)?session\/([^/]+)/);
  return match && !["active", "stats", "import"].includes(match[1]) ? match[1] : undefined;
}
export async function pathWithin(root: string, candidate: string) {
  const [base, actual] = await Promise.all([canonicalFilePath(root), canonicalFilePath(candidate)]);
  const suffix = relative(base, actual);
  return suffix === "" || !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`);
}
export async function assertNativeProxyDirectory(root: string, candidate: string) {
  if (!await pathWithin(root, candidate)) throw new ApiError(403, "workspace_location_mismatch", "The engine location does not belong to this project.");
  return canonicalFilePath(candidate);
}
export function nativeProxyFilePath(path: string, url: URL, directory: string): string | undefined {
  const normalized = nativeProxyPath(path);
  let file: string | undefined;
  if (normalized.startsWith("/fs/read/")) {
    try { file = decodeURIComponent(normalized.slice("/fs/read/".length)); } catch { throw new ApiError(400, "invalid_path", "Invalid file path."); }
  } else if (normalized === "/fs/list" || normalized === "/experimental/fs/write") file = url.searchParams.get("path") ?? undefined;
  if (file === undefined) return undefined;
  if (file.includes("\0")) throw new ApiError(400, "invalid_path", "Invalid file path.");
  return resolve(directory, file || ".");
}
