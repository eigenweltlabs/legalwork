import { z } from "zod";
import { resolveWorkspaceId, serverToken, serverUrl, type OpenCodeContext } from "./office-plugin-shared.js";

/** Project chats keep their scope. The main Assistant can manage accessible projects. */
export async function assistantWorkspace(context: OpenCodeContext, projectId?: string) {
  const current = await resolveWorkspaceId(context, { requireDirectory: true });
  if (!projectId || projectId === current) return current;
  await requireMainAssistant(current);
  await assertAssistantProjectAccess(projectId);
  return projectId;
}

export async function assertAssistantProjectAccess(projectId: string) {
  const response = await fetch(`${serverUrl()}/assistant/access/${encodeURIComponent(projectId)}`, {
    headers: { Authorization: `Bearer ${serverToken()}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("This project is outside the Assistant's allowed projects or is unavailable. Change access in Settings → Assistant.");
}

export async function assistantProjectIds() {
  const response = await fetch(`${serverUrl()}/assistant/access`, {
    headers: { Authorization: `Bearer ${serverToken()}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Could not verify Assistant project access.");
  return new Set(z.object({ projectIds: z.array(z.string()) }).parse(await response.json()).projectIds);
}

export async function requireMainAssistant(current: string) {
  const response = await fetch(`${serverUrl()}/assistant`, {
    headers: { Authorization: `Bearer ${serverToken()}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Could not verify Assistant access.");
  const data = z.object({ workspace: z.object({ id: z.string() }).nullable() }).parse(await response.json());
  if (data.workspace?.id !== current) throw new Error("Manage other projects from the main Assistant.");
}
