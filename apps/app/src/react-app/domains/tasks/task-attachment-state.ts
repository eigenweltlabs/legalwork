import type { ArtifactPanelTab } from "../session/panel/panel-tab-store";
import { artifactDocumentKey, discardDocumentsThen } from "../session/artifacts/docx-document-state";

type Attachment = { taskId: string; tab: ArtifactPanelTab };

/** Inline attachments use the same discard decision as workspace document tabs. */
export function createTaskAttachmentState(workspaceId: string, scope: string) {
  let attachment: Attachment | null = null;
  const listeners = new Set<() => void>();
  const change = (next: Attachment | null, after: () => void) => {
    const previous = attachment;
    const apply = () => {
      // Ignore a stale dialog decision after another transition or unmount.
      if (!listeners.size || attachment !== previous) return;
      attachment = next;
      listeners.forEach(listener => listener());
      after();
    };
    if (previous) discardDocumentsThen(apply, artifactDocumentKey(workspaceId, scope, previous.tab.id));
    else apply();
  };
  return {
    getSnapshot: () => attachment,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    open: (next: Attachment) => change(next, () => {}),
    closeThen: (after: () => void = () => {}) => change(null, after),
  };
}
