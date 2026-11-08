import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createLegalworkServerClient, type RisIntegrationStatus } from "../src/app/lib/legalwork-server";
import { MCP_QUICK_CONNECT } from "../src/app/constants";
import { RisConfig, risStatusQuery } from "../src/react-app/domains/settings/ris-config";
import { connectorCategory } from "../src/react-app/domains/settings/pages/connector-categories";
import { getExtensionConnected } from "../src/react-app/domains/settings/extension-registry";

const client = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:9999", hostToken: "test-host" });
function render(state: Partial<RisIntegrationStatus> = {}, owner = true) {
  const selected = owner ? client : createLegalworkServerClient({ baseUrl: client.baseUrl, token: "test-client" });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(risStatusQuery(selected).queryKey, { enabled: false, allowed: true, readOnly: false,
    source: "https://www.ris.bka.gv.at", requiresAuthentication: false, ...state });
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}><RisConfig legalworkServerClient={selected} /></QueryClientProvider>);
  cache.clear(); return html;
}

test("RIS is a legal-database native integration with activation, without MCP installation or OAuth", () => {
  const entry = MCP_QUICK_CONNECT.find(value => value.id === "ris");
  expect(entry).toBeDefined();
  if (!entry) throw new Error("RIS is absent from the integration catalogue");
  expect(entry.kind).toBe("extension");
  expect(connectorCategory("ris", entry.name)).toBe("legal");
  expect(entry.extensionManifest?.resources.some(value => value.type === "mcp")).toBe(false);
  expect(getExtensionConnected(entry, { extensionConnections: { ris: true } })).toBe(true);
  expect(getExtensionConnected(entry, { extensionConnections: { ris: false } })).toBe(false);
});

test("the disabled state explains activation without showing credential inputs", () => {
  const html = render();
  expect(html).toContain("Enable RIS");
  expect(html).toContain("No account, API key or separate installation");
  expect(html).not.toContain("<input");
  expect(html).toContain("Test connection");
});

test("server policy and owner access control the settings instead of trusting a local UI toggle", () => {
  expect(render({ enabled: true })).toContain("Disable RIS");
  const blocked = render({ enabled: true, allowed: false });
  expect(blocked).toContain("Your organization has disabled");
  expect(blocked.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
  const viewer = render({}, false);
  expect(viewer).toContain("Only the server owner");
  expect(viewer.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
});
