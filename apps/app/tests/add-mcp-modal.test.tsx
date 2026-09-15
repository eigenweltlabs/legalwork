import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CustomConnectorCheck,
  CustomConnectorHeaderFields,
  CustomConnectorOAuthClientFields,
} from "../src/react-app/domains/connections/modals/add-mcp-modal";
import type { CustomConnectorForm, CustomConnectorProbe } from "../src/app/mcp-custom-connector";

const form: CustomConnectorForm = {
  name: "Fibery", url: "https://mcp.fibery.io/mcp", oauthClient: "automatic", clientId: "", clientSecret: "", headers: [],
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
  test("says in one badge that the server asks to sign in, and nothing about how it found out", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorCheck, { probe: oauthProbe(true) }));
    expect(html).toContain("Server found. It asks you to sign in.");
    expect(html).not.toContain("Connecting to the server");
    expect(html).not.toContain("401");
    expect(html).not.toContain("sign-in required");
    expect(html).not.toContain("could not be checked");
  });

  test("an unreachable server says to check the address and try again, nothing about adding it", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorCheck, {
      probe: { url: form.url, reachable: false, transport: null, auth: "unknown", steps: [{ id: "connect", status: null, ok: false, detail: "ECONNREFUSED" }], error: "ECONNREFUSED" },
    }));
    expect(html).toContain("Could not reach the server.");
    expect(html).toContain("Check the address and that the server is running, then try again.");
    expect(html).not.toContain("anyway");
    expect(html).not.toContain("ECONNREFUSED");
  });

  test("an address that answers unlike an MCP server points back to the provider's page", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorCheck, {
      probe: { url: form.url, reachable: true, transport: null, auth: "unknown", steps: [{ id: "connect", status: 404, ok: false }], error: "HTTP 404" },
    }));
    expect(html).toContain("This address does not answer like an MCP server.");
    expect(html).toContain("Check the address on the provider");
  });
});

describe("Add custom connector: the OAuth client", () => {
  test("offers automatic registration as what the provider advertises, verified by registering, and the own client as the alternative", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorOAuthClientFields, { probe: oauthProbe(true), form, onChange: () => {} }));
    expect(html).toContain("Register automatically");
    expect(html).toContain("Offered");
    expect(html).not.toContain("Detected");
    expect(html).toContain("registers itself when you add the connector");
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

describe("Add custom connector: request headers", () => {
  test("starts as one link and grows into name and value rows, up to four", () => {
    const empty = renderToStaticMarkup(React.createElement(CustomConnectorHeaderFields, { form, onChange: () => {} }));
    expect(empty).toContain("Add custom header");
    expect(empty).not.toContain("Request headers");

    const one = renderToStaticMarkup(React.createElement(CustomConnectorHeaderFields, {
      form: { ...form, headers: [{ name: "Authorization", value: "Bearer k" }] }, onChange: () => {},
    }));
    expect(one).toContain("Request headers");
    expect(one).toContain("Add another header");
    expect(one).toContain("Remove header");

    const four = renderToStaticMarkup(React.createElement(CustomConnectorHeaderFields, {
      form: { ...form, headers: Array.from({ length: 4 }, (_, i) => ({ name: `X-${i}`, value: "v" })) }, onChange: () => {},
    }));
    expect(four).not.toContain("Add another header");
  });

  test("when the server asked for an API key the rows are titled as such", () => {
    const html = renderToStaticMarkup(React.createElement(CustomConnectorHeaderFields, {
      form: { ...form, headers: [{ name: "Authorization", value: "" }] }, onChange: () => {}, title: "API key", hint: "hint",
    }));
    expect(html).toContain("API key");
    expect(html).toContain("Authorization");
  });
});
