import { expect, spyOn, test } from "bun:test";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

test("connector modal status is scoped while grid status stays available", async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return Response.json({ configured: true, requiresSignIn: false, connectors: [] });
  }, { preconnect: original.preconnect }));
  try {
    const client = createLegalworkServerClient({ baseUrl: "http://local.invalid", token: "owner-token", hostToken: "host-token" });
    await client.connectorStatus("outlook-calendar");
    await client.connectorStatus("outlook-calendar", true);
    await client.connectorStatus();
    expect(urls).toEqual(["http://local.invalid/connectors/outlook-calendar", "http://local.invalid/connectors/outlook-calendar?refresh=true", "http://local.invalid/connectors"]);
  } finally { mock.mockRestore(); }
});

test("connection requests let the server select the default and preserve explicit reconnect methods", async () => {
  const bodies: unknown[] = [];
  const original = globalThis.fetch;
  const mock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ flowId: "fixture", connectUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", expiresAt: 1 });
  }, { preconnect: original.preconnect }));
  try {
    const client = createLegalworkServerClient({ baseUrl: "http://local.invalid", token: "owner-token", hostToken: "host-token" });
    await client.connectorConnect("outlook");
    await client.connectorConnect("outlook", "legacy-account", "nango");
    await client.connectorConnect("outlook-calendar", "direct-account", "custom");
    expect(bodies).toEqual([{}, { method: "nango", connectionId: "legacy-account" }, { method: "custom", connectionId: "direct-account" }]);
  } finally { mock.mockRestore(); }
});
