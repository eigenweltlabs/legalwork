import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient, LegalworkServerError } from "../src/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { SessionSandbox } from "../src/react-app/domains/session/surface/session-sandbox";
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

test("enforced firm sandbox settings hide the chat control, whether on or off", () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  for (const enabled of [true, false]) {
    const state = { enabled, supported: true, available: true, networkMode: "block", source: "organization", policy: { mode: "enforced", locked: true, orgName: "Example Firm" } };
    cache.setQueryData(["session-sandbox", client.baseUrl, "workspace", "chat"], state);
    expect(renderToStaticMarkup(<QueryClientProvider client={cache}><SessionSandbox client={client} workspaceId="workspace" sessionId="chat" /></QueryClientProvider>)).toBe("");
    cache.setQueryData(["sandbox-default", client.baseUrl], state);
    const settings = renderToStaticMarkup(<QueryClientProvider client={cache}><SandboxStatus client={client} canWrite /></QueryClientProvider>);
    expect(settings).toContain("Managed by Example Firm");
    expect(settings).toContain('<fieldset disabled=""');
    expect(settings).not.toContain("Chats can override");
    if (enabled) expect(settings).toContain("Block all network traffic");
  }
  cache.clear();
});
test("firm defaults and released policies leave the chat control available", () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  for (const policy of [null, { mode: "default", locked: false, orgName: "Example Firm" }, { mode: "enforced", locked: false, orgName: "Example Firm" }]) {
    cache.setQueryData(["session-sandbox", client.baseUrl, "workspace", "chat"], { enabled: true, supported: true, networkMode: "approve", source: "application", policy });
    const html = renderToStaticMarkup(<QueryClientProvider client={cache}><SessionSandbox client={client} workspaceId="workspace" sessionId="chat" /></QueryClientProvider>);
    expect(html).toContain('aria-label="Sandboxing for this chat"');
    expect(html).toContain("Sandbox on");
  }
  cache.clear();
});


test("unreadable execution settings display the blocking error and explicit protected recovery", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false, retryOnMount: false } } });
  const message = "Saved execution settings could not be read. Commands and web access are blocked.";
  const queryFn = async () => { throw new LegalworkServerError(409, "execution_settings_invalid", message, { settingsScope: "application" }); };
  await cache.fetchQuery({ queryKey: ["sandbox-default", client.baseUrl], queryFn }).catch(() => {});
  await cache.fetchQuery({ queryKey: ["session-sandbox", client.baseUrl, "workspace", "chat"], queryFn }).catch(() => {});
  const settings = renderToStaticMarkup(<QueryClientProvider client={cache}><SandboxStatus client={client} canWrite /></QueryClientProvider>);
  expect(settings).toContain('role="alert"');
  expect(settings).toContain(message);
  expect(settings).toContain("Block all network traffic");
  const session = renderToStaticMarkup(<QueryClientProvider client={cache}><SessionSandbox client={client} workspaceId="workspace" sessionId="chat" /></QueryClientProvider>);
  expect(session).toContain(message);
  expect(session).toContain('role="alert"');
  expect(session).toContain("restore the application settings");
  expect(session).not.toContain("Block all network traffic");
  await cache.fetchQuery({ queryKey: ["session-sandbox", client.baseUrl, "workspace", "chat"], queryFn: async () => {
    throw new LegalworkServerError(409, "execution_settings_invalid", message, { settingsScope: "session" });
  } }).catch(() => {});
  const sessionRecovery = renderToStaticMarkup(<QueryClientProvider client={cache}><SessionSandbox client={client} workspaceId="workspace" sessionId="chat" /></QueryClientProvider>);
  expect(sessionRecovery).toContain("Block all network traffic");
  expect(sessionRecovery).not.toContain("restore the application settings");
  cache.clear();
});
