import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { classifyOpenTarget } from "../artifacts/open-target";
import type { ArtifactPanelTab } from "./panel-tab-store";

/** Keep the original intact and give every dropped file its own working copy. */
export async function importViewerFile(
  client: Pick<LegalworkServerClient, "writeWorkspaceBinaryFile">,
  workspaceId: string,
  file: File,
): Promise<ArtifactPanelTab> {
  const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_") || "file";
  const result = await client.writeWorkspaceBinaryFile(workspaceId, {
    path: `.legalwork/tmp/${crypto.randomUUID()}/${filename}`,
    data: await file.arrayBuffer(),
  });
  if (!result.ok || !result.path) throw new Error("The file could not be copied into the workspace.");
  return {
    id: `file:${result.path}`,
    type: "artifact",
    label: file.name,
    value: result.path,
    preview: classifyOpenTarget(result.path, "file"),
    size: result.bytes,
    updatedAt: result.updatedAt,
  };
}
