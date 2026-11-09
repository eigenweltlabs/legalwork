import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient, LegalworkServerError } from "../src/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { SandboxStatus } from "../src/react-app/domains/settings/panels/sandbox-status";
import { SessionSandbox } from "../src/react-app/domains/session/surface/session-sandbox";

const client = createLegalworkServerClient({ baseUrl: "http://localhost:1234", token: "test", hostToken: "test-host" });
const sessionKey = ["session-sandbox", client.baseUrl, "workspace", "chat"];
const renderSessionSandbox = (cache: QueryClient) => renderToStaticMarkup(<QueryClientProvider client={cache}><SessionSandbox client={client} workspaceId="workspace" sessionId="chat" /></QueryClientProvider>);

test("the chat shield remains available for sandbox on, off and inherited settings", () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  for (const enabled of [true, false]) {
    for (const source of ["application", "session", "parent"]) {
      for (const policy of [null, { mode: "default", locked: false }, { mode: "enforced", locked: false }]) {
        cache.setQueryData(sessionKey, { enabled, supported: true, networkMode: "approve", source, policy });
        const html = renderSessionSandbox(cache);
        expect(html).toContain('aria-label="Sandboxing for this chat"');
        expect(html).toContain(`title="Sandboxing for this chat: Sandbox ${enabled ? "on" : "off"}"`);
        expect(html).not.toContain('role="alert"');
      }
    }
  }
  cache.clear();
});

test("firm policy and unsupported servers still hide the chat control", () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  for (const enabled of [true, false]) {
    cache.setQueryData(sessionKey, { enabled, supported: true, policy: { mode: "enforced", locked: true } });
    expect(renderSessionSandbox(cache)).toBe("");
  }
  cache.setQueryData(sessionKey, { enabled: false, supported: false });
  expect(renderSessionSandbox(cache)).toBe("");
  cache.clear();
});

test("a pending status keeps the shield without claiming sandbox on or off", () => {
  const cache = new QueryClient();
  const html = renderSessionSandbox(cache);
  expect(html).toContain('aria-label="Sandboxing for this chat"');
  expect(html).toContain('title="Sandboxing for this chat"');
  expect(html).not.toContain('role="alert"');
  cache.clear();
});

test("status failures keep the shield and never print background errors in the chat", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false, retryOnMount: false } } });
  for (const failure of [
    new Error("Request timed out: sandbox status"),
    new LegalworkServerError(409, "execution_settings_invalid", "Saved execution settings could not be read", { settingsScope: "application" }),
    new LegalworkServerError(409, "execution_settings_invalid", "Saved execution settings could not be read", { settingsScope: "session" }),
  ]) {
    for (const cached of [false, true]) {
      cache.clear();
      if (cached) cache.setQueryData(sessionKey, { enabled: false, supported: true, networkMode: "approve", source: "application" });
      await cache.fetchQuery({ queryKey: sessionKey, queryFn: async () => { throw failure; } }).catch(() => {});
      const html = renderSessionSandbox(cache);
      expect(html).toContain('aria-label="Sandboxing for this chat"');
      expect(html).not.toContain(failure.message);
      expect(html).not.toContain('role="alert"');
      expect(html).toContain('title="Sandboxing for this chat"');
    }
  }
  cache.clear();
});

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
