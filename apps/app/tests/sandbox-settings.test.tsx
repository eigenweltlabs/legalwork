import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient, LegalworkServerError } from "../src/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { SandboxStatus } from "../src/react-app/domains/settings/panels/sandbox-status";

const client = createLegalworkServerClient({ baseUrl: "http://localhost:1234", token: "test", hostToken: "test-host" });
test("local workspace routing preserves host authority and rejects retired workers", () => {
  const local = { id: "workspace", workspaceType: "local" };
  expect(resolveWorkspaceEndpoint(local, { baseUrl: client.baseUrl, token: "test", localClient: client })?.client.canApprove).toBe(true);
  const remote = { id: "rem_workspace", workspaceType: "remote", baseUrl: "https://worker.example", legalworkToken: "remote" };
  expect(resolveWorkspaceEndpoint(remote, { baseUrl: client.baseUrl, token: "test", localClient: client })).toBeNull();
  expect(resolveWorkspaceEndpoint(local, { baseUrl: "http://localhost:9999", token: "other", localClient: client })?.client.canApprove).toBe(false);
});
test("the off application default remains visible and hides inactive network controls", () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  cache.setQueryData(["sandbox-default", client.baseUrl], { enabled: false, supported: true, available: null, networkMode: "approve", sync: "local" });
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}><SandboxStatus client={client} canWrite /></QueryClientProvider>);
  expect(html).toContain("Application default");
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("Commands run directly on this computer");
  expect(html).not.toContain("Sandbox network traffic");
  cache.clear();
});

test("enforced firm sandbox settings remain locked, whether on or off", () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  for (const enabled of [true, false]) {
    const state = { enabled, supported: true, available: true, networkMode: "block", source: "organization", policy: { mode: "enforced", locked: true, orgName: "Example Firm" } };
    cache.setQueryData(["sandbox-default", client.baseUrl], state);
    const settings = renderToStaticMarkup(<QueryClientProvider client={cache}><SandboxStatus client={client} canWrite /></QueryClientProvider>);
    expect(settings).toContain("Managed by Example Firm");
    expect(settings).toContain('<fieldset disabled=""');
    expect(settings).not.toContain("Chats can override");
    if (enabled) expect(settings).toContain("Block all network traffic");
  }
  cache.clear();
});
test("unreadable execution settings display the blocking error and protected recovery in settings", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false, retryOnMount: false } } });
  const message = "Saved execution settings could not be read. Commands and web access are blocked.";
  const queryFn = async () => { throw new LegalworkServerError(409, "execution_settings_invalid", message, { settingsScope: "application" }); };
  await cache.fetchQuery({ queryKey: ["sandbox-default", client.baseUrl], queryFn }).catch(() => {});
  const settings = renderToStaticMarkup(<QueryClientProvider client={cache}><SandboxStatus client={client} canWrite /></QueryClientProvider>);
  expect(settings).toContain('role="alert"');
  expect(settings).toContain(message);
  expect(settings).toContain("Block all network traffic");
  cache.clear();
});
