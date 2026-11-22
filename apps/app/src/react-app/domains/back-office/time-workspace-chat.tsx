import { useContext, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { CaptureState } from "@legalwork/types/time-capture";
import type { ModelRef } from "@/app/types";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { ChatWorkspaceContext } from "@/components/chat/chat-workspace-context";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { EmbeddedWorkspaceChat } from "../session/chat/embedded-workspace-chat";
import { useControlScope } from "@/react-app/shell/control/control-provider";
import { calendarClientScope } from "../calendar/calendar-cache";

export function TimeWorkspaceChat({ client, identity, date, data, visible }: {
  client: LegalworkServerClient;
  identity: { profileId?: string; scope: string; principal: string; user: string };
  date: string;
  data?: CaptureState;
  visible: boolean;
}) {
  const host = useContext(EmbeddedWorkspaceChat);
  const focused = useControlScope();
  const cache = useQueryClient();
  const profileId = identity.profileId;
  const chat = useQuery<Awaited<ReturnType<LegalworkServerClient["privateTimeConversation"]>>>({
    queryKey: ["timekeeping-conversation", ...calendarClientScope(client), profileId],
    enabled: Boolean(visible && host && profileId), retry: false, staleTime: 30_000,
    refetchInterval: visible ? 60_000 : false,
    queryFn: ({ signal }) => {
      if (!profileId) throw new Error(t("timeWorkspace.chatUnavailable"));
      return client.privateTimeConversation(profileId, signal);
    },
  });
  const selectWorkspace = host?.selectWorkspace;
  const workspace = chat.data?.workspace;
  useEffect(() => {
    if (!visible || !workspace || !selectWorkspace) return;
    selectWorkspace(workspace);
    return () => selectWorkspace(null);
  }, [workspace, selectWorkspace, visible]);
  const persist = useRef<Promise<void>>(Promise.resolve());
  const requested = useRef("");
  const [saveError, setSaveError] = useState<{ message: string; model: ModelRef } | null>(null);
  const saved = data?.settings.model;
  function modelChanged(model: ModelRef, retry = false) {
    if (!workspace || !data || !profileId) return;
    const next = { workspaceId: workspace.id, providerID: model.providerID, modelID: model.modelID };
    const key = JSON.stringify([profileId, next]);
    if (!retry && (requested.current === key || (!requested.current && saved?.workspaceId === workspace.id && saved?.modelID === model.modelID && saved?.providerID === model.providerID))) return;
    requested.current = key;
    setSaveError(null);
    persist.current = persist.current.then(async () => {
      if (requested.current !== key) return;
      const nextDay = await client.privateWorkday({ ...identity, date }, { type: "settings-patch", change: { field: "model", value: next } });
      cache.setQueriesData<CaptureState>({ queryKey: ["back-office", ...calendarClientScope(client), "workday"], predicate: item => item.queryKey.includes("day") && item.queryKey.some(part => typeof part === "object" && part !== null && "profileId" in part && part.profileId === profileId) },
        previous => previous ? { ...previous, settings: nextDay.settings } : previous);
    }).catch(error => { if (requested.current === key) { setSaveError({ message: error instanceof Error ? error.message : String(error), model }); } });
  }
  if (!visible) return null;
  if (!profileId || !host) return <p className="p-4 text-sm text-muted-foreground">{t("timeWorkspace.chatUnavailable")}</p>;
  if (chat.error) return <p role="alert" className="p-4 text-sm">{chat.error.message} <Button variant="ghost" size="xs" onClick={() => void chat.refetch()}>{t("timesheets.retry")}</Button></p>;
  if (!chat.data || host.workspaceId !== workspace?.id) return <div role="status" className="grid h-full place-items-center" aria-label={t("timeWorkspace.chat")}><Loader2 className="size-4 animate-spin" /></div>;
  return <ChatWorkspaceContext.Provider value="timekeeping">
    {saveError && <p className="px-4 text-sm text-destructive" role="alert">{saveError.message} <Button variant="ghost" size="xs" onClick={() => modelChanged(saveError.model, true)}>{t("timesheets.retry")}</Button></p>}
    {host.render(chat.data.day.sessionId, focused, {
      date: chat.data.day.date, model: saved, modelChanged,
      history: (before, limit, after) => client.privateTimeHistory(profileId, before, limit, after),
      context: "The selected workday is " + date + ". Use legalwork_timekeeping_workday to read the day log, existing entries and drafts. Read guidelines for each assigned matter, then publish grounded, client-ready drafts as you prepare them. When requested, save reusable billing preferences through normal project instructions or a project version of the workflow-suggest-timesheet skill. Reconstructions use that skill and these project instructions.",
    })}
  </ChatWorkspaceContext.Provider>;
}
