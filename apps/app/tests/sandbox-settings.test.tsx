import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
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
  expect(html).toContain('aria-checked="false"');
  expect(html).toContain("Commands run directly on this computer");
  expect(html).not.toContain("Sandbox network traffic");
  cache.clear();
});
