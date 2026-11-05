import { afterEach, expect, test } from "bun:test";
import { nativePluginTools } from "../opencode-plugins/native-plugin-test-support.js";
import { LegalWorkExtensionsPreview } from "../opencode-plugins/legalwork-extensions-preview.js";
import { connectorDefinitions } from "@legalwork/types/connectors";

const originalFetch = globalThis.fetch;
const savedEnv = ["LEGALWORK_SERVER_URL", "LEGALWORK_SERVER_TOKEN", "LEGALWORK_CONNECTOR_TOKEN"].map((key) => ({ key, value: process.env[key] }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const { key, value } of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test("passes the runtime capability only for registered connector actions and never returns it", async () => {
  process.env.LEGALWORK_SERVER_URL = "http://legalwork.test";
  process.env.LEGALWORK_SERVER_TOKEN = "runtime-client";
  process.env.LEGALWORK_CONNECTOR_TOKEN = "private-mail-capability";
  const headers: Headers[] = [];
  globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    headers.push(new Headers(init?.headers));
    return Response.json({ ok: true, result: { connected: true } });
  }, { preconnect: originalFetch.preconnect });
  const plugin = await nativePluginTools(LegalWorkExtensionsPreview);
  for (const extensionId of [...connectorDefinitions.map((item) => item.id), "google-workspace"]) {
    const result = await plugin.tool.legalwork_extension_call.execute({ extensionId, action: "status" }, { sessionID: "session" });
    expect(result).not.toContain("private-mail-capability");
  }
  expect(headers.map((header) => header.get("x-legalwork-connector-token"))).toEqual([...connectorDefinitions.map(() => "private-mail-capability"), null]);
});
