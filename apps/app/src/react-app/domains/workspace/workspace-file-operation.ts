import type { QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient, LegalworkWorkspaceFileOperation } from "@/app/lib/legalwork-server";
import { documentIdentityKey } from "../session/artifacts/document-identity";
import { changePinnedPaths } from "../session/panel/file-pins";
import { t } from "@/i18n";

export type WorkspaceFile = { client: LegalworkServerClient; workspaceId: string; path: string; isRemoteWorkspace: boolean };

/** Hold the editor's identity lock so a move/delete cannot race an autosave. */
export async function operateWorkspaceFile(file: WorkspaceFile, operation: LegalworkWorkspaceFileOperation, queryClient: QueryClient) {
  const perform = async () => {
    const [result] = await file.client.applyWorkspaceFileOperations(file.workspaceId, [operation]);
    if (!result?.ok) throw new Error(result?.message ?? t("storage.failed"));
    if (operation.type === "rename") changePinnedPaths(file.workspaceId, "local", operation.from, operation.to);
    if (operation.type === "delete") changePinnedPaths(file.workspaceId, "local", operation.path);
    const filter = { predicate: (query: { queryKey: readonly unknown[] }) =>
      (query.queryKey[0] === "markdown-editor" && query.queryKey[1] === file.workspaceId && query.queryKey[2] === file.path) ||
      (query.queryKey[0] === "document-identity" && query.queryKey[1] === file.client.baseUrl && query.queryKey[2] === file.workspaceId && query.queryKey[3] === file.path) };
    await queryClient.cancelQueries(filter);
    queryClient.removeQueries(filter);
  };
  try {
    const stat = await file.client.statWorkspaceFile(file.workspaceId, file.path);
    if (stat.fileId && typeof navigator !== "undefined" && navigator.locks) {
      const key = documentIdentityKey(file.client.baseUrl, stat.fileId, !file.isRemoteWorkspace);
      await navigator.locks.request(`legalwork:document:${key}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error(t("project_browser.close_before_file_change"));
        await perform();
      });
    } else await perform();
  } finally {
    for (const key of ["workspace-files", "project-files", "project-notes", "project-file-search"]) void queryClient.invalidateQueries({ queryKey: [key, file.workspaceId] });
  }
}
