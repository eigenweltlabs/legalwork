import { expect, test } from "bun:test";
import { z } from "zod";
import { nativeMcpBinary, nativeMcpEngine, nativeOAuthProvider } from "./native-mcp-engine.test-support.js";
import { beginNativeMcpOAuth, nativeMcpOAuthStatus, waitForNativeMcpOAuth } from "./native-mcp.test-support.js";

const released = test.skipIf(!nativeMcpBinary);
async function fixture(action: (provider: Awaited<ReturnType<typeof nativeOAuthProvider>>, engine: Awaited<ReturnType<typeof nativeMcpEngine>>) => Promise<void>) {
  const provider = await nativeOAuthProvider();
  const engine = await nativeMcpEngine({ mcp: { servers: { shared: { type: "remote", url: `${provider.url}/mcp` } } } });
  try { await action(provider, engine); } finally { await engine.close(); await provider.close(); }
}
const log = z.object({ requests: z.array(z.object({ path: z.string() })) });
const registrations = async (provider: Awaited<ReturnType<typeof nativeOAuthProvider>>) => log.parse(await provider.requests()).requests.filter(request => request.path === "/register").length;

released("native OAuth control completes and saves its own exact registered client", async () => fixture(async (_provider, engine) => {
  const client = engine.client(), attempt = await beginNativeMcpOAuth(client, engine.location, "shared");
  expect((await nativeMcpOAuthStatus(client, engine.location, attempt)).status).toBe("pending");
  expect((await fetch(attempt.url)).status).toBe(200);
  expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
  const credential = (await client.credential.list()).find(entry => entry.integrationID === attempt.integrationID);
  expect(credential?.value.type).toBe("oauth");
  expect(JSON.stringify(credential?.value)).toContain(new URL(attempt.url).searchParams.get("client_id") ?? "missing-client");
}), 30_000);

released("raw native location rebuild cancels a pending attempt without substituting another OAuth client", async () => fixture(async (provider, engine) => {
  const client = engine.client(), before = await registrations(provider), attempt = await beginNativeMcpOAuth(client, engine.location, "shared");
  expect(await registrations(provider)).toBe(before + 1);
  await client.location.reload();
  await client.model.list({ location: engine.location });
  await client.mcp.list({ location: engine.location });
  expect(await registrations(provider)).toBe(before + 1);
  await expect(nativeMcpOAuthStatus(client, engine.location, attempt)).rejects.toMatchObject({ _tag: "IntegrationAttemptNotFoundError" });
  expect((await client.credential.list()).filter(entry => entry.integrationID === attempt.integrationID)).toEqual([]);
  const browser = await fetch(attempt.url, { redirect: "manual" });
  const callback = browser.headers.get("location"); if (!callback) throw new Error("Provider callback missing");
  await expect(fetch(callback)).rejects.toBeDefined();
}), 30_000);

released("another native location sharing one connector identity cannot clobber the pending sign-in", async () => fixture(async (provider, engine) => {
  const client = engine.client(), attempt = await beginNativeMcpOAuth(client, engine.location, "shared"), before = await registrations(provider);
  const other = { directory: engine.other };
  await client.model.list({ location: other });
  const shared = (await client.mcp.list({ location: other })).data.find(server => server.name === "shared");
  expect(shared?.integrationID).toBe(attempt.integrationID);
  expect(await registrations(provider)).toBe(before);
  expect((await nativeMcpOAuthStatus(client, engine.location, attempt)).status).toBe("pending");
  expect((await fetch(attempt.url)).status).toBe(200);
  expect((await waitForNativeMcpOAuth(client, engine.location, attempt)).status).toBe("complete");
}), 30_000);
