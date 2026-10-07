import type { LegalworkServerClient } from "@/app/lib/legalwork-server";

/** A discarded handoff draft is a normal, discoverable file, never an active
 * recovery draft that could silently replace the original on the next open. */
export async function keepHandoffCopy(client: LegalworkServerClient, workspaceId: string, path: string, data: ArrayBuffer | string) {
  const extension = /\.[^./]+$/.exec(path)?.[0] ?? "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copy = `${path.slice(0, path.length - extension.length)} (unsaved copy ${stamp}-${crypto.randomUUID().slice(0, 8)})${extension}`;
  if (typeof data === "string") await client.writeWorkspaceFile(workspaceId, { path: copy, content: data });
  else await client.writeWorkspaceBinaryFile(workspaceId, { path: copy, data });
  return copy;
}
