import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CustomConnectorApiKeyFields,
  CustomConnectorCheck,
  CustomConnectorOAuthClientFields,
} from "../src/react-app/domains/connections/modals/add-mcp-modal";
import type { CustomConnectorForm, CustomConnectorProbe } from "../src/app/mcp-custom-connector";

const form: CustomConnectorForm = {
  name: "Fibery", url: "https://mcp.fibery.io/mcp", oauthClient: "automatic", clientId: "", clientSecret: "", apiKey: "", apiKeyHeader: "Authorization",
};

const oauthProbe = (dynamicRegistration: boolean): CustomConnectorProbe => ({
  url: form.url,
  reachable: true,
  transport: "streamable-http",
  auth: "oauth",
  oauth: { resourceMetadataUrl: `${form.url}/.well-known`, authorizationServer: "https://auth.fibery.io", dynamicRegistration, clientIdMetadataDocuments: false },
  steps: [
    { id: "connect", status: 401, ok: true, detail: "sign-in required" },
    { id: "resource_metadata", status: 200, ok: true },
    { id: "authorization_server", status: 200, ok: true },
  ],
});

describe("Add custom connector: the check", () => {
  test("lists every step with its status and says the server asks to sign in", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorCheck, { probe: oauthProbe(true) }));
    expect(html).toContain("Connecting to the server");
    expect(html).toContain("Looking up sign-in settings");
    expect(html).toContain("Checking the sign-in provider");
    expect(html).toContain(">401<");
    expect(html).toContain("Server found. It asks you to sign in.");
  });

  test("an unreachable server keeps the door open to add it anyway", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorCheck, {
      probe: { url: form.url, reachable: false, transport: null, auth: "unknown", steps: [{ id: "connect", status: null, ok: false, detail: "ECONNREFUSED" }], error: "ECONNREFUSED" },
    }));
    expect(html).toContain("Could not reach the server.");
    expect(html).toContain("could not be checked from here");
  });
});

describe("Add custom connector: the OAuth client", () => {
  test("offers automatic registration as detected, and the own client as the alternative", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorOAuthClientFields, { probe: oauthProbe(true), form, onChange: () => {} }));
    expect(html).toContain("Register automatically");
    expect(html).toContain("Detected");
    expect(html).toContain("Use your own OAuth client");
    // Never a sign-in question: it happens right after adding.
    expect(html).toContain("You sign in in your browser right after adding.");
    expect(html).not.toContain("Sign in when needed");
  });

  test("without automatic registration the own client is the way, with the redirect URL to register", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorOAuthClientFields, { probe: oauthProbe(false), form: { ...form, oauthClient: "own" }, onChange: () => {} }));
    expect(html).toContain("This server does not offer automatic registration.");
    expect(html).toContain("http://127.0.0.1:19876/mcp/oauth/callback");
    expect(html).toContain("OAuth client ID");
  });
});

describe("Add custom connector: the API key", () => {
  test("asks for the key and the header it travels in", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorApiKeyFields, { form, onChange: () => {} }));
    expect(html).toContain("API key or token");
    expect(html).toContain("Authorization");
  });
});
