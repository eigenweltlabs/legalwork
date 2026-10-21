import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ViewOwner, ViewPreview, ViewRecord, ViewSaveSource } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { viewPanelTab } from "./view-reference";
import { sameViewOwner, saveViewPreview } from "./view-save";
import { useViewSaveDestinations } from "./view-save-destinations";

export function useViewSave(client: LegalworkServerClient, preview: ViewPreview, savedFrom: ViewSaveSource | undefined, onSaved: (view: ViewRecord) => void) {
  const cache = useQueryClient();
  const requestTab = useRequestPanelTab();
  const destinations = useViewSaveDestinations(client);
  return useMutation({
    mutationFn: (options: { owner?: ViewOwner; title?: string; copy?: boolean }) => saveViewPreview(client, preview, { ...options, savedFrom }),
    onSuccess: view => {
      const owner = view.owner;
      void cache.invalidateQueries({ queryKey: ["ui-views", client.baseUrl, owner.kind, owner.id] });
      void cache.invalidateQueries({ queryKey: ["ui-view", client.baseUrl, owner.kind, owner.id] });
      if (owner.kind === "wiki") void cache.invalidateQueries({ queryKey: ["wiki-snapshot", client.baseUrl, owner.id] });
      else {
        void cache.invalidateQueries({ queryKey: ["workspace-files", owner.id] });
        void cache.invalidateQueries({ queryKey: ["workspace-view-files", client.baseUrl, owner.id] });
      }
      const destination = destinations.data?.find(item => sameViewOwner(item.owner, owner))?.name ?? t(owner.kind === "wiki" ? "views.current_wiki" : "views.current_project");
      toast.success(t("views.saved_to", { destination }), { action: {
        label: t("session.open"),
        onClick: () => requestTab(viewPanelTab(client.baseUrl, { owner, viewId: view.id }, view.title)),
      } });
      onSaved(view);
    },
  });
}
