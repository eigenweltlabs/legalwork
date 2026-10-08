import { z } from "zod";
import { resolveWorkspaceId, serverToken, serverUrl, type OpenCodeContext } from "./office-plugin-shared.js";

/** Project chats keep their scope. The main Assistant can manage accessible projects. */
export async function assistantWorkspace(context: OpenCodeContext, projectId?: string) {
  const current = await resolveWorkspaceId(context, { requireDirectory: true });
  if (!projectId || projectId === current) return current;
  await requireMainAssistant(current);
  return projectId;
}

export async function requireMainAssistant(current: string) {
  const response = await fetch(`${serverUrl()}/assistant`, {
    headers: { Authorization: `Bearer ${serverToken()}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Could not verify Assistant access.");
  const data = z.object({ workspace: z.object({ id: z.string() }).nullable() }).parse(await response.json());
  if (data.workspace?.id !== current) throw new Error("Manage other projects from the main Assistant.");
}
