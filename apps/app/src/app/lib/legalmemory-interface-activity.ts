import type { LegalMemoryPermissions, LegalMemoryPermissionReply } from "@legalwork/types/legalmemory";

export type LegalMemoryInterfaceActivity = {
  id: string;
  workspaceId: string;
  permissions: (signal?: AbortSignal) => Promise<LegalMemoryPermissions>;
  reply: (input: LegalMemoryPermissionReply, signal?: AbortSignal) => Promise<{ replied: boolean }>;
  cancel: () => void;
};
const active = new Map<string, { activity: LegalMemoryInterfaceActivity; controllers: Set<AbortController> }>();
const listeners = new Set<() => void>();
let activitySequence = 0;
let snapshot: readonly LegalMemoryInterfaceActivity[] = [];
function changed() { snapshot = Array.from(active.values(), item => item.activity); for (const listener of listeners) listener(); }
export const legalMemoryInterfaceActivities = () => snapshot;
export function subscribeLegalMemoryInterfaceActivities(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Only actual in-flight human reads activate permission observation. */
export function trackLegalMemoryInterfaceRead(activity: Omit<LegalMemoryInterfaceActivity, "cancel">, controller: AbortController) {
  let item = active.get(activity.id);
  if (!item) {
    const controllers = new Set<AbortController>();
    item = { controllers, activity: { ...activity, id: `${activity.id}:${++activitySequence}`, cancel: () => { for (const controller of controllers) controller.abort(); } } };
    active.set(activity.id, item); changed();
  }
  item.controllers.add(controller);
  return () => {
    item.controllers.delete(controller);
    if (item.controllers.size === 0) { active.delete(activity.id); changed(); }
  };
}
export function cancelLegalMemoryInterfaceReads() { for (const item of active.values()) item.activity.cancel(); }
