import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ViewSaveDialog } from "./view-save-dialog";
import { viewPanelTab } from "./view-reference";
import { Loader2 } from "lucide-react";
import { useSessionActivityStore } from "../session/status/session-activity-store";
import { useViewGenerationStore, type ViewDraftTab, type ViewGeneration } from "./view-generation";
import type { ViewPreview, ViewRecord } from "@legalwork/types/views";
import { ViewSaveActions } from "./view-save-actions";
import { useViewSave } from "./use-view-save";
import { isViewSaveConflict } from "./view-save";
import { useCallback, useEffect, useState } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import type { ViewPanelTab } from "./view-reference";
import { SavedView, OpenUIView, PreviewView } from "./view-renderer";

export function ViewPanel({ client, tab, sessionId }: { client: LegalworkServerClient | null; tab: ViewPanelTab; sessionId: string }) {
  const title = useCallback((label: string) => usePanelTabStore.getState().updateTabLabel(sessionId, tab.id, label), [sessionId, tab.id]);
  return <div className="h-full overflow-auto" style={{ containerType: "inline-size" }}><SavedView client={client?.baseUrl === tab.serverUrl ? client : null} reference={tab} onTitle={title} /></div>;
}

export function ViewDraftPanel({ client, tab, sessionId: panelScope }: { client: LegalworkServerClient | null; tab: ViewDraftTab; sessionId: string }) {
  const generation = useViewGenerationStore(state => state.entries[tab.generationId]);
  const activity = useSessionActivityStore(state => generation ? state.statusesByWorkspaceId[generation.workspaceId]?.[generation.sessionId] : undefined);
  useEffect(() => {
    if (generation?.title) usePanelTabStore.getState().updateTabLabel(panelScope, tab.id, generation.title);
  }, [generation?.title, panelScope, tab.id]);
  useEffect(() => {
    if (generation?.status !== "streaming" || (activity !== "idle" && activity !== "error")) return;
    // Completion parts can follow session-idle in the same event batch.
    const timer = window.setTimeout(() => useViewGenerationStore.getState().fail(tab.generationId, activity === "error" ? t("views.generation_failed") : t("views.generation_stopped")), 1500);
    return () => window.clearTimeout(timer);
  }, [activity, generation?.status, tab.generationId]);
  if (generation?.preview && client?.baseUrl === tab.serverUrl) return <ViewDraftContent key={tab.generationId} client={client} generation={generation} preview={generation.preview} generationId={tab.generationId} />;
  const failed = !generation || generation.status === "failed";
  return <div className="h-full overflow-auto" style={{ containerType: "inline-size" }}><div className="lw-saved-view">
    <div className="lw-saved-view-toolbar" role={failed ? "alert" : "status"}>{failed ? generation?.error ?? t("views.generation_unavailable") : <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" />{t("views.creating_preview")}</span>}</div>
    {generation?.program ? <div inert><OpenUIView program={generation.program} streaming /></div> : !failed ? <p className="lw-view-data-note">{t("views.preview_building_hint")}</p> : null}
    {failed && generation?.program && <p className="lw-view-data-note">{t("views.preview_unfinished")}</p>}
  </div></div>;
}

function ViewDraftContent({ client, generation, preview, generationId }: { client: LegalworkServerClient; generation: ViewGeneration; preview: ViewPreview; generationId: string }) {
  const [saveAs, setSaveAs] = useState(false);
  const requestTab = useRequestPanelTab();
  const savedFrom = { workspaceId: generation.workspaceId, sessionId: generation.sessionId, callId: generation.toolCallId };
  const onSaved = (view: ViewRecord) => {
    useViewGenerationStore.getState().markSaved(generationId, view);
    usePanelTabStore.getState().resolveViewTab(generationId, viewPanelTab(client.baseUrl, { owner: view.owner, viewId: view.id }, view.title));
    setSaveAs(false);
  };
  const save = useViewSave(client, preview, savedFrom, onSaved);
  const conflict = isViewSaveConflict(save.error);
  return <div className="h-full overflow-auto" style={{ containerType: "inline-size" }}><div className="lw-saved-view">
    <div className="lw-saved-view-toolbar"><span>{t(generation.saved ? "views.original_preview" : "views.preview_unsaved")}</span><ViewSaveActions saved={Boolean(generation.saved)} busy={save.isPending} saveDisabled={conflict} onSave={() => { if (!save.isPending && !generation.saved) save.mutate({}); }} onSaveAs={() => setSaveAs(true)} /></div>
    {save.error && <div role="alert" className="lw-saved-view-error">{conflict ? t("views.direct_save_conflict") : save.error.message}{conflict && <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { if (preview.target) requestTab(viewPanelTab(client.baseUrl, { owner: preview.owner, viewId: preview.target.viewId }, preview.input.title)); }}>{t("views.open_latest")}</Button><Button size="sm" variant="outline" onClick={() => setSaveAs(true)}>{t("views.save_as")}</Button></div>}</div>}
    <PreviewView client={client} preview={preview} generationId={generationId} />
    {saveAs && <ViewSaveDialog copyTitle={Boolean(generation.saved || preview.target)} savedFrom={savedFrom} client={client} preview={preview} onClose={() => setSaveAs(false)} onSaved={onSaved} />}
  </div></div>;
}
