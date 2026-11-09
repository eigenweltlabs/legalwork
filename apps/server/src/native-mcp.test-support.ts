import type { OpenCodeClient, IntegrationAttempt } from "@opencode/client";

export type NativeMcpOAuthAttempt = IntegrationAttempt & { integrationID: string };

/** Public released APIs only. This watchdog bounds fixture failures, not tools. */
export async function waitForNativeFixture<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string,
  { timeoutMs = 15_000, retryError = () => true }: { timeoutMs?: number; retryError?: (error: unknown) => boolean } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  do {
    try { const value = await read(); if (accepts(value)) return value; last = value; }
    catch (error) {
      if (!retryError(error)) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  throw new Error(`Native fixture did not reach ${label}: ${JSON.stringify(last)}`);
}

// Model discovery initializes location plugins without invoking a model. A cold
// location can consume the engine's activation deadline on its first request.
export function waitForNativeLocation(client: OpenCodeClient, location: { directory: string }) {
  return waitForNativeFixture(() => client.model.list({ location }), () => true, `plugin activation for ${location.directory}`, {
    timeoutMs: 40_000,
    retryError: error => error instanceof Error && "_tag" in error && error._tag === "ServiceUnavailableError"
      && "service" in error && error.service === "plugin",
  });
}

export async function beginNativeMcpOAuth(client: OpenCodeClient, location: { directory: string }, serverName: string): Promise<NativeMcpOAuthAttempt> {
  await waitForNativeLocation(client, location);
  const server = await waitForNativeFixture(async () => (await client.mcp.list({ location })).data.find(server => server.name === serverName), server => Boolean(server?.integrationID), `OAuth integration ${serverName}`);
  if (!server?.integrationID) throw new Error(`Missing OAuth integration ${serverName}`);
  const integrationID = server.integrationID;
  const integration = await client.integration.get({ integrationID, location });
  const method = integration.data.methods.find(method => method.type === "oauth");
  if (!method || method.type !== "oauth") throw new Error(`Missing OAuth method ${serverName}`);
  return { integrationID, ...(await client.integration.oauth.connect({ integrationID, methodID: method.id, location })).data };
}

export async function nativeMcpOAuthStatus(client: OpenCodeClient, location: { directory: string }, attempt: Pick<NativeMcpOAuthAttempt, "integrationID" | "attemptID">) {
  return (await client.integration.oauth.status({ ...attempt, location })).data;
}

export async function waitForNativeMcpOAuth(client: OpenCodeClient, location: { directory: string }, attempt: Pick<NativeMcpOAuthAttempt, "integrationID" | "attemptID">) {
  return waitForNativeFixture(() => nativeMcpOAuthStatus(client, location, attempt), status => status.status !== "pending", "OAuth completion");
}
