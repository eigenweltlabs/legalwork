import React from "react";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { useCalendarRefresh } from "../src/react-app/domains/calendar/calendar-queries";
import { useSavedViews } from "../src/react-app/domains/views/view-list";
import { createRoot } from "react-dom/client";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { useSyncEvents, useSyncEventsLive } from "../src/react-app/kernel/sync-events";
import { useSessionGroupSync } from "../src/react-app/shell/use-session-group-sync";
import { useSessionInbox } from "../src/react-app/shell/use-session-inbox";
import { useSessionManagementStore } from "../src/react-app/domains/session/sidebar/session-management-store";
import type { RouteWorkspace } from "../src/react-app/shell/route-workspaces";

const apiUrl = new URLSearchParams(location.search).get("api");
if (!apiUrl) throw new Error("Missing fixture API");
const client = createLegalworkServerClient({ baseUrl: apiUrl, token: "fixture-token" });
const workspaces: RouteWorkspace[] = Array.from({ length: 18 }, (_, index) => ({
  id: `ws_${index}`, name: `Project ${index}`, displayNameResolved: `Project ${index}`,
  path: `/fixture/${index}`, preset: "starter", workspaceType: "local",
}));
const endpointForWorkspace = (workspace: RouteWorkspace | null | undefined) => resolveWorkspaceEndpoint(workspace, { baseUrl: apiUrl, token: "fixture-token", localClient: client });
localStorage.clear();
useSessionManagementStore.setState({ groupsByWorkspace: { ws_0: { groups: [{ id: "local", label: "Preserved local group" }], assignments: {} } } });
const listed = {};
const reload = async (items: RouteWorkspace[]) => {
  await fetch(`${apiUrl}/test/reloads`, { method: "POST", body: JSON.stringify(items.map(item => item.id)) });
};
function Harness() {
  useSyncEvents(client);
  useCalendarRefresh();
  useQuery({ queryKey: ["calendar", client.baseUrl, "fixture"], queryFn: async () => (await fetch(`${apiUrl}/test/calendar`)).json(), staleTime: Infinity });
  useSessionGroupSync({ workspaces, endpointForWorkspace });
  useSessionInbox(client, workspaces, listed, reload);
  const groups = useSessionManagementStore(state => state.groupsByWorkspace);
  const sync = useSyncEventsLive();
  const views = useSavedViews(client, { kind: "workspace", id: "ws_0" });
  return <main style={{ fontFamily: "system-ui", padding: 30 }}>
    <h1>LegalWork request regression</h1>
    <p>{views.data?.items[0]?.title}</p>
    <p>{Object.keys(groups).length} projects synchronized · Events {sync.live ? "connected" : "reconnecting"}</p>
    {workspaces.map(workspace => <p key={workspace.id}>{workspace.name}: {groups[workspace.id]?.groups.map(group => group.label).join(", ") || "No groups"}</p>)}
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<React.StrictMode><QueryClientProvider client={getReactQueryClient()}><Harness /></QueryClientProvider></React.StrictMode>);
Object.assign(window, { requestPerformance: {
  snapshot: () => ({ calendarStatus: getReactQueryClient().getQueryState(["calendar", client.baseUrl, "fixture"])?.fetchStatus, groups: useSessionManagementStore.getState().groupsByWorkspace, sync: useSyncEventsLive.getState(), view: getReactQueryClient().getQueryData(["ui-views", client.baseUrl, "workspace", "ws_0"]) }),
  unmount: () => root.unmount(),
} });
