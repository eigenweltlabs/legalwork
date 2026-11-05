import { DashboardIcon } from "@/react-app/design-system/dashboard-icon";
import { t } from "@/i18n";
import { useMemo } from "react";
import type { DynamicToolUIPart } from "ai";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { useMessageList } from "@/components/chat/message-list-provider";
import { Button } from "@/components/ui/button";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { viewPanelTab } from "./view-reference";
import { viewProgramInput, viewToolOutcome, viewGenerationId, viewDraftTab, useViewGenerationStore } from "./view-generation";

export function ViewToolCard({ part }: { part: DynamicToolUIPart }) {
  const { legalworkClient, workspaceId, sessionId } = useMessageList();
  const request = useRequestPanelTab();
  const outcome = useMemo(() => part.state === "output-available" ? viewToolOutcome(part.output) : null, [part.state, part.output]);
  const input = useMemo(() => viewProgramInput(part.input), [part.input]);
  const generationId = legalworkClient ? viewGenerationId(legalworkClient.baseUrl, sessionId, part.toolCallId) : "";
  const generation = useViewGenerationStore(state => state.entries[generationId]);
  const remembered = useViewGenerationStore(state => state.savedResults[generationId]);
  const view = generation?.saved ?? remembered ?? (outcome && "view" in outcome ? outcome.view : null);
  const preview = outcome && "preview" in outcome ? outcome.preview : generation?.preview;
  const failure = view ? undefined : outcome && "error" in outcome ? outcome.error : part.state === "output-error" ? part.errorText : generation?.error;
  const pending = !view && !preview && !failure && (part.state === "input-streaming" || part.state === "input-available");
  const open = (originalPreview = false) => {
    if (!legalworkClient) return;
    if (view && !originalPreview) request(viewPanelTab(legalworkClient.baseUrl, { owner: view.owner, viewId: view.id }, view.title), { besideChat: true });
    else {
      let entry = useViewGenerationStore.getState().entries[generationId];
      if (preview && (!entry || !entry.preview)) {
        entry = { ...entry, serverUrl: legalworkClient.baseUrl, workspaceId: entry?.workspaceId ?? workspaceId, sessionId, toolCallId: part.toolCallId, title: preview.input.title, program: preview.input.program, status: view ? "saved" : "preview", saved: view ?? undefined, preview };
        useViewGenerationStore.getState().update(generationId, entry);
      }
      if (entry) request(viewDraftTab(generationId, entry), { besideChat: true });
    }
  };
  return <div className="my-3 overflow-hidden rounded-xl border bg-card"><div className="flex flex-wrap items-center gap-3 p-4"><DashboardIcon className="size-4 text-muted-foreground" /><div className="min-w-0 flex-1 basis-36"><p className="truncate text-sm font-medium">{view?.title ?? generation?.title ?? input.title}</p><p className="text-xs text-muted-foreground">{failure ? t("views.preview_failed", { error: failure }) : pending ? t("views.creating_preview") : preview && !view ? t("views.preview_unsaved") : view?.mode === "dashboard" ? "queries" in view && Object.keys(view.queries).length ? t("views.live_dashboard") : t("views.dashboard") : view ? t("views.report_snapshot") : t("views.preview_missing")}</p></div>{legalworkClient && view && preview && <Button size="sm" variant="ghost" onClick={() => open(true)}>{t("views.original_preview")}</Button>}{legalworkClient && (view || preview || pending) ? <Button size="sm" variant="outline" onClick={() => open()}>{pending ? <Loader2 className="size-4 animate-spin" /> : null}{t("session.open")}<ArrowUpRight /></Button> : null}</div></div>;
}
