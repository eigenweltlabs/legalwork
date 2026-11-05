import { afterEach, expect, test } from "bun:test";
import type { HostApprovalRequest } from "@legalwork/types/desktop-ipc";
import type { PendingPermission } from "../src/app/types";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { hostApprovalScope, refreshHostApprovals } from "../src/react-app/shell/host-approval-feed";
import type { RouteWorkspace } from "../src/react-app/shell/route-workspaces";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { permissionKey, replyToPermission } from "../src/react-app/domains/session/sync/interaction-state";
import { createClient } from "../src/app/lib/opencode";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
const cache = getReactQueryClient();
const stops: Array<() => void> = [];
afterEach(() => { stops.splice(0).forEach(stop => stop()); cache.clear(); });
function host(name: string) {
  let failed = false;
  let items: HostApprovalRequest[] = [{ id: name, workspaceId: "same-id", sessionID: "same-chat", action: "sandbox.webfetch", paths: [], summary: name, createdAt: 1, actor: { type: "host" } }];
  const calls: Array<{ path: string; token: string | null; body: unknown }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname, token = request.headers.get("X-LegalWork-Host-Token");
    calls.push({ path, token, body: request.method === "POST" ? await request.json() : null });
    if (token !== name || failed) return new Response(null, { status: 403 });
    if (request.method === "POST") { items = []; return Response.json({ ok: true, allowed: true }); }
    return Response.json({ items });
  } });
  stops.push(() => server.stop(true));
  const workspace: RouteWorkspace = { id: "same-id", name, displayNameResolved: name, path: "", preset: "starter", workspaceType: "local", baseUrl: server.url.origin };
  return { workspace, calls, expire: () => { items = []; }, fail: () => { failed = true; }, scope: hostApprovalScope(server.url.origin, "same-id") };
}
const pending = (scope: string) => cache.getQueryData<PendingPermission[]>(permissionKey(scope, "same-chat")) ?? [];

test("a local reconciliation removes expired approvals and their waiting state", async () => {
  const fixture = host("local");
  const client = createLegalworkServerClient({ baseUrl: fixture.workspace.baseUrl!, token: "client", hostToken: "local" });
  const workspace: RouteWorkspace = { ...fixture.workspace, id: "same-id", workspaceType: "local" };
  await refreshHostApprovals(client, [workspace], () => true);
  expect(pending(fixture.scope)).toHaveLength(1);
  expect(useSessionActivityStore.getState().getStatus("same-id", "same-chat")).toBe("waiting");
  fixture.expire();
  await refreshHostApprovals(client, [workspace], () => true);
  expect(pending(fixture.scope)).toEqual([]);
  expect(useSessionActivityStore.getState().getStatus("same-id", "same-chat")).toBe("idle");
});

test("retired remote records cannot route requests or inherit desktop approval authority", () => {
  const legacy = { id: "rem_old", workspaceType: "remote", baseUrl: "https://retired.example", legalworkToken: "old" };
  const local = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:1", token: "local-client", hostToken: "local-secret" });
  expect(resolveWorkspaceEndpoint(legacy, { localClient: local, baseUrl: local.baseUrl, token: local.token })).toBeNull();
});

test("manual server selection still routes a local project with only the selected connection credentials", () => {
  const workspace = { id: "ws_project", workspaceType: "local", baseUrl: "https://obsolete-engine.example" };
  const selected = createLegalworkServerClient({ baseUrl: "https://selected-server.example", token: "selected-client" });
  const endpoint = resolveWorkspaceEndpoint(workspace, { localClient: selected, baseUrl: selected.baseUrl, token: selected.token });
  expect(endpoint?.client).toBe(selected);
  expect(endpoint?.mountedBaseUrl).toBe("https://selected-server.example/workspace/ws_project");
  expect(endpoint?.hostToken).toBeUndefined();
});
