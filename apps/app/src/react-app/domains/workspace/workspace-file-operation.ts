import type { QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient, LegalworkWorkspaceFileOperation } from "@/app/lib/legalwork-server";
import { documentIdentityKey } from "../session/artifacts/document-identity";
import { changePinnedPaths } from "../session/panel/file-pins";
import { t } from "@/i18n";

export type WorkspaceFile = { client: LegalworkServerClient; workspaceId: string; path: string; isRemoteWorkspace: boolean };

/** Hold the editor's identity lock so a move/delete cannot race an autosave. */
export async function operateWorkspaceFile(file: WorkspaceFile, operation: LegalworkWorkspaceFileOperation, queryClient: QueryClient) {
  const within = (path: unknown) => typeof path === "string" && (path === file.path || path.startsWith(`${file.path}/`));
  const perform = async () => {
    const [result] = await file.client.applyWorkspaceFileOperations(file.workspaceId, [operation]);
    if (!result?.ok) throw new Error(result?.message ?? t("storage.failed"));
    if (operation.type === "rename") changePinnedPaths(file.workspaceId, "local", operation.from, operation.to);
    if (operation.type === "delete") changePinnedPaths(file.workspaceId, "local", operation.path);
    const filter = { predicate: (query: { queryKey: readonly unknown[] }) =>
      (query.queryKey[0] === "markdown-editor" && query.queryKey[1] === file.workspaceId && within(query.queryKey[2])) ||
      (query.queryKey[0] === "document-identity" && query.queryKey[1] === file.client.baseUrl && query.queryKey[2] === file.workspaceId && within(query.queryKey[3])) };
    await queryClient.cancelQueries(filter);
    queryClient.removeQueries(filter);
    await queryClient.invalidateQueries({ queryKey: ["project-file-links", file.client.baseUrl, file.workspaceId] });
  };
  try {
    if (typeof navigator === "undefined" || !navigator.locks) { await perform(); return; }
    // Folder mutations must also hold every descendant's lock. Canonical IDs
    // deduplicate aliases and stop directory-symlink cycles during traversal.
    const keys = new Set<string>();
    const collect = async (path: string) => {
      const stat = await file.client.statWorkspaceFile(file.workspaceId, path);
      if (!stat.exists || !stat.fileId) throw new Error(t("project_browser.file_change_unavailable"));
      const key = documentIdentityKey(file.client.baseUrl, stat.fileId, !file.isRemoteWorkspace);
      if (keys.has(key)) return;
      keys.add(key);
      if (stat.kind === "dir") {
        const listing = await file.client.listWorkspaceDirectory(file.workspaceId, path);
        if (listing.truncated) throw new Error(t("project_browser.file_change_unavailable"));
        for (const entry of listing.entries) await collect(entry.path);
      }
    };
    await collect(file.path);
    const ordered = [...keys].sort();
    const acquire = async (index: number): Promise<void> => {
      if (index === ordered.length) { await perform(); return; }
      await navigator.locks.request(`legalwork:document:${ordered[index]}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error(t("project_browser.close_before_file_change"));
        await acquire(index + 1);
      });
    };
    await acquire(0);
  } finally {
    for (const key of ["workspace-files", "project-files", "project-notes", "project-file-search"]) void queryClient.invalidateQueries({ queryKey: [key, file.workspaceId] });
  }
}
