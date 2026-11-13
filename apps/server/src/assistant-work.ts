import type { AssistantWorkItem, AssistantWorkStatus } from "@legalwork/types/launcher";
import type { DelegationResult, TrackedDelegation } from "./assistant-delegations.js";

export type WorkInspection = {
  available: boolean; busy: boolean; title: string; projectName: string; createdAt: number | null; updatedAt: number | null;
  result: DelegationResult | null; pendingAttention: number; queuedMessages: number;
};
export type WorkDeps = {
  inspect: (delegation: TrackedDelegation) => Promise<WorkInspection>;
  originConversationId: (sourceSessionId: string) => string | null;
};

export function workStatus(inspection: WorkInspection): AssistantWorkStatus {
  if (!inspection.available) return "unavailable";
  if (inspection.pendingAttention > 0 || inspection.result?.outcome === "input-required") return "input-required";
  if (inspection.busy) return "running";
  if (inspection.result?.outcome === "failed") return "failed";
  if (inspection.result?.outcome === "interrupted") return "stopped";
  if (inspection.result?.outcome === "reply") return "returned";
  return inspection.queuedMessages > 0 ? "queued" : "returned";
}

/** Work is addressable: every delegated job keeps its origin conversation, exact destination and current status. */
export async function listAssistantWork(delegations: TrackedDelegation[], deps: WorkDeps, filter: { status?: AssistantWorkStatus; projectId?: string } = {}): Promise<AssistantWorkItem[]> {
  const visible = delegations.filter(delegation => !delegation.inputOnly && (!filter.projectId || delegation.workspaceId === filter.projectId));
  const results: PromiseSettledResult<WorkInspection>[] = [];
  for (let offset = 0; offset < visible.length; offset += 8) results.push(...await Promise.allSettled(visible.slice(offset, offset + 8).map(delegation => deps.inspect(delegation))));
  const items: AssistantWorkItem[] = [];
  for (const [index, delegation] of visible.entries()) {
    const settled = results[index];
    const inspection: WorkInspection = settled.status === "fulfilled" ? settled.value
      : { available: false, busy: false, title: delegation.title, projectName: delegation.workspaceId, createdAt: null, updatedAt: null, result: null, pendingAttention: 0, queuedMessages: 0 };
    const status = workStatus(inspection);
    if (filter.status && status !== filter.status) continue;
    items.push({ id: `${delegation.workspaceId}:${delegation.sessionId}`, workspaceId: delegation.workspaceId, sessionId: delegation.sessionId, projectName: inspection.projectName, title: inspection.title || delegation.title, scope: delegation.scope,
      status, originConversationId: deps.originConversationId(delegation.sourceSessionId), originSessionId: delegation.sourceSessionId, createdAt: inspection.createdAt, updatedAt: inspection.updatedAt,
      pendingAttention: inspection.pendingAttention, queuedMessages: inspection.queuedMessages,
      result: inspection.result ? { outcome: inspection.result.outcome, preview: inspection.result.text.slice(0, 400), messageId: inspection.result.messageId } : null });
  }
  return items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id, "en"));
}
