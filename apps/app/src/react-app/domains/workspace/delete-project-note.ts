import type { QueryClient } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";

export async function deleteProjectNote(
  client: Pick<LegalworkServerClient, "deleteWorkspaceFiles">,
  queryClient: QueryClient,
  workspaceId: string,
  path: string,
) {
  const results = await client.deleteWorkspaceFiles(workspaceId, [{ path }]);
  // The file operations endpoint can return HTTP 200 with an individual failure.
  if (!results.some((result) => result.path === path && result.ok)) {
    throw new Error(results[0]?.code ?? "delete_failed");
  }
  await queryClient.cancelQueries({ queryKey: ["markdown-editor", workspaceId, path], exact: true });
  queryClient.removeQueries({ queryKey: ["markdown-editor", workspaceId, path], exact: true });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["project-notes", workspaceId] }),
    queryClient.invalidateQueries({ queryKey: ["project-files", workspaceId] }),
    queryClient.invalidateQueries({ queryKey: ["workspace-files", workspaceId] }),
  ]);
}
