import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { connectorConfigVariables, connectorUsesOAuth } from "@legalwork/types/connector-config";
import { configuredConnectorEntry, connectorNeedsSetup, editableConnectorConfig, savedConnectorEditConfig } from "../src/app/mcp-configuration";
import { mcpAuthEntryFromServer, mcpConnectOutcome } from "../src/app/mcp-connect-state";
import { ConnectorVariableFields, McpConfigurationForm } from "../src/react-app/domains/connections/modals/mcp-configuration-form";
import type { McpServerEntry } from "../src/app/types";
import { MCP_QUICK_CONNECT } from "../src/app/constants";

const imported: McpServerEntry = { name: "github-2ecca5c9-plugin-global-github-c0b010", source: "config.remote", config: { type: "remote", enabled: false, url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" }, timeout: 45000 } };

test("Firecrawl quick connect uses native browser sign-in at the account OAuth endpoint", () => {
  const entry = MCP_QUICK_CONNECT.find(item => item.serverName === "firecrawl");
  expect(entry).toMatchObject({ name: "Firecrawl", type: "remote", kind: "mcp", oauth: true, url: "https://mcp.firecrawl.dev/v2/mcp-oauth" });
  if (!entry) throw new Error("Firecrawl quick connection is missing");
  expect(entry.command).toBeUndefined();
  expect(entry.headers).toBeUndefined();
  expect(entry.environment).toBeUndefined();
  expect(mcpConnectOutcome(entry, { status: "needs_auth" }, true)).toBe("auth");
});

test("GitHub setup resolves the required token, keeps the import identity, and connects without OAuth", () => {
  const config = editableConnectorConfig(imported.config);
  expect(connectorNeedsSetup(config)).toBe(true);
  const entry = configuredConnectorEntry(imported, config, { GITHUB_PERSONAL_ACCESS_TOKEN: "synthetic-pat" });
  expect(entry.id).toBe(imported.name);
  expect(entry.serverName).toBe(imported.name);
  expect(entry.name).not.toContain("2ecca5c9");
  expect(entry.headers).toEqual({ Authorization: "Bearer synthetic-pat" });
  expect(entry.timeout).toBe(45000);
  expect(entry.oauth).toBe(false);
  expect(mcpConnectOutcome(entry, { status: "connected" }, true)).toBe("connected");
  expect(mcpAuthEntryFromServer(imported).oauth).toBe(false);
});
test("setup fields hide credentials, and URL variables resolve without losing literal query values", () => {
  const config = { ...imported.config, url: "https://${user_config.tenant}.example.com/mcp?source=plugin" };
  const html = renderToStaticMarkup(<ConnectorVariableFields config={config} values={{}} onChange={() => {}} />);
  expect(html).toContain("Tenant");
  expect(html).toContain("Access token");
  expect(html).toContain('type="password"');
  expect(() => configuredConnectorEntry(imported, config, { "user_config.tenant": "firm" })).toThrow("Missing value");
  const entry = configuredConnectorEntry(imported, config, { "user_config.tenant": "firm", GITHUB_PERSONAL_ACCESS_TOKEN: "synthetic-pat" });
  expect(entry.url).toBe("https://firm.example.com/mcp?source=plugin");
  expect(connectorConfigVariables(entry.existingConfig)).toEqual([]);
});
test("legacy dummy URLs can be completed and local setup carries every launch field into hot-add", () => {
  const legacy = editableConnectorConfig({ type: "remote", url: "https://configure-before-connecting.invalid/mcp" });
  expect(connectorConfigVariables(legacy)).toEqual(["SERVER_URL"]);
  expect(configuredConnectorEntry(imported, legacy, { SERVER_URL: "http://localhost:8000/mcp" }).url).toBe("http://localhost:8000/mcp");
  const local: McpServerEntry = { name: "local", config: { type: "local", command: ["node", "/plugin/server.js", "", "two words"], cwd: "/plugin", timeout: 45000, environment: { KEY: "${KEY}", EMPTY: "" } } };
  const entry = configuredConnectorEntry(local, local.config, { KEY: "synthetic-key" });
  expect(entry.command).toEqual(local.config.command);
  expect(entry.cwd).toBe("/plugin");
  expect(entry.timeout).toBe(45000);
  expect(entry.environment).toEqual({ KEY: "synthetic-key", EMPTY: "" });
});
test("Basic authentication is encoded once, while non-credential headers can still use browser sign-in", () => {
  const basic = { ...imported.config, headers: { Authorization: "Basic ${BASIC_AUTH_CREDENTIALS}" }, oauth: false };
  expect(configuredConnectorEntry(imported, basic, { BASIC_AUTH_CREDENTIALS: "user:password" }).headers).toEqual({ Authorization: `Basic ${btoa("user:password")}` });
  const local = { type: "local", command: ["program"], environment: { BASIC_AUTH_CREDENTIALS: "${BASIC_AUTH_CREDENTIALS}" } } satisfies import("../src/app/types").McpServerConfig;
  expect(configuredConnectorEntry(imported, local, { BASIC_AUTH_CREDENTIALS: "raw:environment" }).environment).toEqual({ BASIC_AUTH_CREDENTIALS: "raw:environment" });
  expect(connectorUsesOAuth({ type: "remote", headers: { "X-Tenant": "firm" } })).toBe(true);
  const tenant = configuredConnectorEntry(imported, { type: "remote", url: "https://tenant.invalid/mcp", headers: { "X-Tenant": "firm" } }, {});
  expect(mcpConnectOutcome(tenant, { status: "needs_auth" }, true)).toBe("auth");
  expect(mcpConnectOutcome(tenant, { status: "connected" }, true)).toBe("connected");
  expect(connectorUsesOAuth({ type: "remote", headers: { "X-Key": "synthetic-key" } })).toBe(false);
  expect(connectorUsesOAuth({ type: "remote", headers: { Authorization: "Bearer token" }, oauth: { clientId: "client" } })).toBe(true);
});

test("metadata-only saved settings retain private values and submit setup answers separately", () => {
  const entry: McpServerEntry = { name: "saved", editable: true, source: "config.remote", config: { type: "remote", enabled: false, oauth: false },
    configured: { url: true, command: false, cwd: false, oauth: false, headers: ["Authorization"], environment: [], variables: ["ACCESS_TOKEN"] } };
  expect(connectorNeedsSetup(entry.config, entry.configured)).toBe(true);
  const draft = savedConnectorEditConfig(entry, { ...entry.config, url: "", headers: { Authorization: "" } });
  expect(draft.url).toBeUndefined(); expect(draft.headers).toEqual({});
  const submitted = configuredConnectorEntry(entry, draft, { ACCESS_TOKEN: "synthetic-new-token" });
  expect(submitted.url).toBeUndefined();
  expect(submitted.configEdit).toEqual({ variables: { ACCESS_TOKEN: "synthetic-new-token" } });
  expect(submitted.existingConfig).not.toHaveProperty("url");
  const html = renderToStaticMarkup(<McpConfigurationForm entry={entry} onBack={() => {}} onConnect={() => true} />);
  expect(html).toContain("Saved connection values stay private");
  expect(html).toContain("Access token");
  expect(html).not.toContain("synthetic-new-token");
  const authored = { ...entry, editable: false };
  expect(() => configuredConnectorEntry(authored, draft, {})).toThrow("authored OpenCode configuration");
  const readonly = renderToStaticMarkup(<McpConfigurationForm entry={authored} onBack={() => {}} onConnect={() => true} />);
  expect(readonly).toContain("original file");
  expect(readonly).not.toContain("<form");
});
