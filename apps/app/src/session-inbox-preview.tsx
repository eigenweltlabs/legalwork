// Development-only integration fixture using the production sidebar, inbox reconciliation,
// SSE, read tracking, HTTP routes, persisted scheduler and an isolated simulated engine.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceSessionGroup } from "@/app/types";
import { snapshotKey } from "@/react-app/domains/session/sync/session-sync";
import type { Session } from "@opencode-ai/sdk/v2/client";
import { createLegalworkServerClient } from "@/app/lib/legalwork-server";
import { AppSidebar } from "@/react-app/domains/session/sidebar/app-sidebar";
import { ProjectPersonalisationProvider } from "@/react-app/domains/workspace/project-personalisation-modal";
import { useSessionInbox } from "@/react-app/shell/use-session-inbox";
import { useSyncEvents } from "@/react-app/kernel/sync-events";
import { ReactSessionRuntime } from "@/react-app/domains/session/sync/runtime-sync";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { ShellConfigProvider } from "@/react-app/shell/shell-config";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { WorkspaceProvider } from "@/react-app/shell/workspace-provider";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Toaster, toast } from "@/components/ui/sonner";
import { initLocale, setLocale } from "@/i18n";
import "./app/index.css";

if (!import.meta.env.DEV) throw new Error("Development fixture only.");
initLocale(); setLocale("en");
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
const client = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:8798", token: "scheduled-preview" });
const cache = getReactQueryClient();
const noop = () => {};
const layoutPreview = new URLSearchParams(location.search).has("layout");
function Preview() {
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [listed, setListed] = useState<Record<string, Session[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState(false);
  useEffect(() => { void client.listWorkspaces().then(({ items }) => setWorkspaces(items.map(workspace => ({ ...workspace, displayNameResolved: workspace.name })))); }, []);
  useEffect(() => {
    if (selected) void client.getSessionSnapshot("preview", selected).then(({ item }) => cache.setQueryData(snapshotKey("preview", selected), item));
  }, [selected]);
  useSyncEvents(client);
  useSessionInbox(client, workspaces, listed, async targets => {
    for (const workspace of targets) {
      const response = await client.listSessions(workspace.id, { limit: 200 });
      setListed(current => ({ ...current, [workspace.id]: response.items }));
    }
  });
  const groups: WorkspaceSessionGroup[] = workspaces.map(workspace => ({ workspace: layoutPreview ? { ...workspace, name: "Northstar Legal · Acquisition and financing", displayNameResolved: "Northstar Legal · Acquisition and financing" } : workspace, sessions: listed[workspace.id] ?? [], status: "ready" }));
  if (layoutPreview && groups[0]) groups.push({ ...groups[0], workspace: { ...groups[0].workspace, id: "preview-short", name: "Northstar", displayNameResolved: "Northstar" } });
  const schedule = async () => {
    await client.createScheduledTask("preview", {
      title: layoutPreview ? "Daily morning deadline reminders" : "Morning matter brief", prompt: "Summarize upcoming work. This is an isolated preview.",
      sessionId: null, reuseChat: true, pinSession: true, projectAccess: "project", model: null,
      schedule: { kind: "once", startAt: new Date(Date.now() + 2000).toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    });
    setScheduled(true);
    toast.success("Scheduled in two seconds. The local scheduler checks every fifteen seconds.");
  };
  return <ProjectPersonalisationProvider groups={groups} client={client}><SidebarProvider style={{ ...{ "--sidebar-width": layoutPreview && !new URLSearchParams(location.search).has("narrow") ? "22rem" : "16rem" } }}>
    <AppSidebar accountClient={null} workspaceSessionGroups={groups} selectedWorkspaceId="preview" selectedSessionId={selected}
      developerMode={false} connectingWorkspaceId={null} workspaceConnectionStateById={{}} newChatDisabled={false}
      onOpenProjectFiles={noop} onSelectWorkspace={noop} onOpenSession={(_workspace, id) => setSelected(id)}
      onCreateChatInWorkspace={noop} onOpenRenameWorkspace={noop} onRevealWorkspace={noop} onForgetWorkspace={noop}
      onOpenCreateWorkspace={noop} onCreateChatInNewWorkspace={noop} />
    <main className="min-w-0 flex-1 space-y-6 bg-background p-10">
      <p className="text-xs text-muted-foreground">Isolated integration preview. No model calls or personal chats.</p>
      <h1 className="text-2xl font-semibold">{listed.preview?.find(session => session.id === selected)?.title ?? "Scheduled chat delivery"}</h1>
      {selected ? <p className="text-muted-foreground">The selected chat has loaded. Its unread indicator clears when this window is in the foreground.</p> : <p className="max-w-lg text-muted-foreground">Schedule a run and watch its chat appear under Pinned, with an unread dot and clock. Open the chat to clear the dot.</p>}
      <Button onClick={() => void schedule()} disabled={scheduled}>Schedule preview run</Button>
      <Button variant="outline" onClick={() => setSelected(null)}>Close chat</Button>
      {selected && <ReactSessionRuntime workspaceId="preview" sessionId={selected} opencodeBaseUrl={client.baseUrl} legalworkToken="scheduled-preview" />}
    </main>
  </SidebarProvider></ProjectPersonalisationProvider>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={cache}><TooltipProvider><LocalProvider><ShellConfigProvider><WorkspaceProvider client={null} selectedWorkspaceRoot=""><MemoryRouter><Preview /><Toaster /></MemoryRouter></WorkspaceProvider></ShellConfigProvider></LocalProvider></TooltipProvider></QueryClientProvider>);
