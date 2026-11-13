import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { beginProjectRemoval } from "@/app/lib/project-removal-state";

export async function removeProjectFromSidebar(
  client: Pick<LegalworkServerClient, "baseUrl" | "deleteWorkspace">,
  workspaceId: string,
  applyRemoval: () => void,
  forgetDesktop: () => Promise<void>,
  refresh: () => Promise<unknown>,
) {
  const removal = beginProjectRemoval(client.baseUrl, workspaceId);
  if (!removal) return;
  try {
    await client.deleteWorkspace(workspaceId).catch(error => {
      if (!(error instanceof LegalworkServerError && error.status === 404 && error.code === "workspace_not_found")) throw error;
    });
    removal.confirmed = true;
    applyRemoval();
    // Supersede older registry reads before awaiting desktop I/O. Their stale
    // response must not restore the removed row while cleanup is still running.
    await Promise.all([refresh(), forgetDesktop()]);
  } finally {
    removal.finish(removal.confirmed);
  }
}
