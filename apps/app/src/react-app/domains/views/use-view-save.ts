import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ViewOwner, ViewPreview, ViewRecord, ViewSaveSource } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { saveViewPreview } from "./view-save";
import { useViewCopyStore, type ViewSaveScope } from "./view-save-locations";

export function useViewSave(client: LegalworkServerClient, preview: ViewPreview, savedFrom: ViewSaveSource | undefined, onSaved: (view: ViewRecord) => void, scope: ViewSaveScope) {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (options: { owner?: ViewOwner; title?: string; copy?: boolean }) => saveViewPreview(client, preview, { ...options, savedFrom }),
    onSuccess: view => {
      useViewCopyStore.getState().remember(client.baseUrl, scope, view);
      const owner = view.owner;
      void cache.invalidateQueries({ queryKey: ["ui-views", client.baseUrl, owner.kind, owner.id] });
      void cache.invalidateQueries({ queryKey: ["ui-view", client.baseUrl, owner.kind, owner.id] });
      if (owner.kind === "wiki") void cache.invalidateQueries({ queryKey: ["wiki-snapshot", client.baseUrl, owner.id] });
      else {
        void cache.invalidateQueries({ queryKey: ["workspace-files", owner.id] });
        void cache.invalidateQueries({ queryKey: ["workspace-view-files", client.baseUrl, owner.id] });
      }
      onSaved(view);
    },
  });
}
