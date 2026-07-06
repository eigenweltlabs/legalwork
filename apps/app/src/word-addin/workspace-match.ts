/**
 * Match an open Office document path to the LegalWork workspace whose folder
 * contains it. Pure and framework-free so it can be unit-tested.
 */

export type WorkspaceLike = { id: string; path?: string | null };

function stripTrailingSep(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

/**
 * The workspace whose folder contains `docPath` (deepest/most-specific match
 * wins when workspaces nest). Case-insensitive — macOS and Windows default
 * filesystems are. Returns null for cloud (http) URLs, empty input, remote
 * workspaces without a local path, or no match.
 */
export function matchWorkspaceForDocument<T extends WorkspaceLike>(
  docPath: string | null | undefined,
  workspaces: readonly T[],
): T | null {
  const doc = typeof docPath === "string" ? docPath.trim() : "";
  if (!doc || /^https?:\/\//i.test(doc)) return null;
  const docLower = doc.toLowerCase();

  let best: { workspace: T; length: number } | null = null;
  for (const workspace of workspaces) {
    const root = stripTrailingSep((workspace.path ?? "").trim());
    if (!root) continue;
    const rootLower = root.toLowerCase();
    if (docLower === rootLower || docLower.startsWith(`${rootLower}/`)) {
      if (!best || root.length > best.length) best = { workspace, length: root.length };
    }
  }
  return best?.workspace ?? null;
}
