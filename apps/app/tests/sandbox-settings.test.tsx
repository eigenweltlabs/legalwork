import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { SessionSandbox } from "../src/react-app/domains/session/surface/session-sandbox";
import { SandboxStatus } from "../src/react-app/domains/settings/panels/sandbox-status";

const client = createLegalworkServerClient({ baseUrl: "http://localhost:1234", token: "test", hostToken: "test-host" });
test("local workspace routing preserves host authority without leaking it to remote workers", () => {
  const local = { id: "workspace", workspaceType: "local" };
  expect(resolveWorkspaceEndpoint(local, { baseUrl: client.baseUrl, token: "test", localClient: client })?.client.canApprove).toBe(true);
  const remote = { id: "rem_workspace", workspaceType: "remote", baseUrl: "https://worker.example", legalworkToken: "remote" };
  expect(resolveWorkspaceEndpoint(remote, { baseUrl: client.baseUrl, token: "test", localClient: client })?.client.canApprove).toBe(false);
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
