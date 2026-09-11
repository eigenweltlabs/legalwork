import { describe, expect, test } from "bun:test";

import {
  apiKeyHeaderValue,
  buildCustomConnectorEntry,
  defaultOAuthClient,
  probeVerdict,
  type CustomConnectorForm,
  type CustomConnectorProbe,
} from "../src/app/mcp-custom-connector";

const form: CustomConnectorForm = {
  name: "Fibery",
  url: "https://mcp.fibery.io/mcp",
  oauthClient: "automatic",
  clientId: "",
  clientSecret: "",
  apiKey: "",
  apiKeyHeader: "Authorization",
};

const probe = (patch: Partial<CustomConnectorProbe>): CustomConnectorProbe => ({
  url: form.url,
  reachable: true,
  transport: "streamable-http",
  auth: "unknown",
  steps: [],
  ...patch,
});

const oauth = (dynamicRegistration: boolean) =>
  probe({ auth: "oauth", oauth: { resourceMetadataUrl: null, authorizationServer: "https://auth.example", dynamicRegistration, clientIdMetadataDocuments: false } });

describe("custom connector: reading the check", () => {
  test("names what the server asked for", () => {
    expect(probeVerdict(oauth(true))).toBe("signin");
    expect(probeVerdict(probe({ auth: "none" }))).toBe("open");
    expect(probeVerdict(probe({ auth: "credentials" }))).toBe("credentials");
    expect(probeVerdict(probe({ reachable: false }))).toBe("unreachable");
    expect(probeVerdict(probe({ auth: "unknown" }))).toBe("unknown");
  });

  test("offers automatic registration only when the provider does", () => {
    expect(defaultOAuthClient(oauth(true))).toBe("automatic");
    expect(defaultOAuthClient(oauth(false))).toBe("own");
    expect(defaultOAuthClient(null)).toBe("own");
  });
});

describe("custom connector: what gets saved", () => {
  test("an OAuth server with automatic registration signs in with a fresh client", () => {
    expect(buildCustomConnectorEntry(form, oauth(true))).toEqual({
      name: "Fibery", description: "", type: "remote", url: form.url, oauth: true,
    });
  });

  test("the firm's own OAuth client is written into the connector, secret only when given", () => {
    const own = { ...form, oauthClient: "own" as const, clientId: "client-1", clientSecret: " " };
    expect(buildCustomConnectorEntry(own, oauth(true)).oauthConfig).toEqual({ clientId: "client-1" });
    expect(buildCustomConnectorEntry({ ...own, clientSecret: "s3cret" }, oauth(false)).oauthConfig).toEqual({ clientId: "client-1", clientSecret: "s3cret" });
    // Without automatic registration the own client is the only way, whatever was picked.
    expect(() => buildCustomConnectorEntry({ ...form, oauthClient: "automatic" }, oauth(false))).toThrow(/client ID/i);
  });

  test("a server that wants credentials without OAuth needs an API key, sent as a bearer token", () => {
    expect(() => buildCustomConnectorEntry(form, probe({ auth: "credentials" }))).toThrow(/API key/i);
    expect(buildCustomConnectorEntry({ ...form, apiKey: "abc123" }, probe({ auth: "credentials" })).headers).toEqual({ Authorization: "Bearer abc123" });
    expect(buildCustomConnectorEntry({ ...form, apiKey: "Token abc123" }, probe({ auth: "credentials" })).headers).toEqual({ Authorization: "Token abc123" });
    expect(buildCustomConnectorEntry({ ...form, apiKey: "abc123", apiKeyHeader: "X-API-Key" }, probe({ auth: "credentials" })).headers).toEqual({ "X-API-Key": "abc123" });
  });

  test("an open server, or one that could not be checked, is saved plainly and the engine decides", () => {
    const open = buildCustomConnectorEntry(form, probe({ auth: "none" }));
    expect(open).toEqual({ name: "Fibery", description: "", type: "remote", url: form.url });
    expect(buildCustomConnectorEntry(form, null)).toEqual(open);
    expect(buildCustomConnectorEntry(form, probe({ reachable: false }))).toEqual(open);
    // A key typed anyway rides along.
    expect(buildCustomConnectorEntry({ ...form, apiKey: "k" }, probe({ auth: "none" })).headers).toEqual({ Authorization: "Bearer k" });
  });

  test("name and address are required", () => {
    expect(() => buildCustomConnectorEntry({ ...form, name: " " }, null)).toThrow();
    expect(() => buildCustomConnectorEntry({ ...form, url: "" }, null)).toThrow();
  });

  test("bearer prefixing applies to the Authorization header only", () => {
    expect(apiKeyHeaderValue("Authorization", "abc")).toBe("Bearer abc");
    expect(apiKeyHeaderValue("authorization", "Basic abc")).toBe("Basic abc");
    expect(apiKeyHeaderValue("X-API-Key", "abc")).toBe("abc");
  });
});
