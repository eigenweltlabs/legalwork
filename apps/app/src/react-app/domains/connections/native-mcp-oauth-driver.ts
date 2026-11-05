import type { IntegrationAttempt } from "@opencode/client";
import type { Client } from "@/app/types";
import type { McpOAuthDriver } from "@/app/mcp-oauth-flow";
import { createLegalworkServerClient } from "@/app/lib/legalwork-server";
import { getClientContext, resolveLegalworkWorkspaceMount } from "@/app/lib/opencode";
import { t } from "@/i18n";

type DesktopCallbacks = {
  localServerUrl: () => Promise<string | null>;
  listen: (options: { redirectUri: string }) => Promise<{ listenerId: string }>;
  wait: (options: { listenerId: string; state: string }) => Promise<{ code: string; iss?: string }>;
  cancel: (listenerId: string) => Promise<void>;
};
function sameServer(left: string | null, right: string) { return left?.replace(/\/+$/, "") === right.replace(/\/+$/, ""); }
async function pause(signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 500);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The native engine owns OAuth. Mounted LegalWork clients add callback
 * transport for a browser on a different machine, without exporting tokens. */
export async function createNativeMcpOAuthDriver(options: {
  client: Client; directory: string; server: string; signal: AbortSignal;
  finish: () => Promise<{ status: string }>;
  desktop?: DesktopCallbacks;
}): Promise<McpOAuthDriver> {
  const { client, directory, server, signal } = options, location = { directory };
  const context = getClientContext(client), mount = context && resolveLegalworkWorkspaceMount(context.baseUrl);
  const app = mount && context.auth?.mode === "legalwork" ? { workspaceID: mount.workspaceId, baseUrl: mount.baseUrl,
    client: createLegalworkServerClient({ baseUrl: mount.baseUrl, token: context.auth.token ?? "", hostToken: context.auth.hostToken }) } : undefined;
  const entry = (await client.mcp.list({ location })).data.find(item => item.name === server);
  if (!entry?.integrationID) throw new Error(t("mcp.auth.server_not_registered"));
  const integrationID = entry.integrationID, integration = (await client.integration.get({ integrationID, location })).data;
  const method = integration.methods.find(item => item.type === "oauth");
  if (!method || method.type !== "oauth") throw new Error(t("mcp.auth.provider_did_not_finish"));
  let attempt: IntegrationAttempt | undefined, actualIntegrationID = integrationID, listenerID: string | undefined, oauthState: string | undefined, completed = false;
  const identity = () => {
    if (!attempt) throw new Error(t("mcp.auth.provider_did_not_finish"));
    return { integrationID: actualIntegrationID, attemptID: attempt.attemptID };
  };
  const cancel = async () => { if (attempt) { if (app) await app.client.cancelMcpOAuth(app.workspaceID, identity()); else await client.integration.oauth.cancel({ ...identity(), location }); } };
  const wait = async () => {
    while (true) {
      signal.throwIfAborted();
      const status = app ? await app.client.mcpOAuthStatus(app.workspaceID, identity()) : (await client.integration.oauth.status({ ...identity(), location })).data;
      if (status.status === "complete") { completed = true; return options.finish(); }
      if (status.status !== "pending") throw new Error("message" in status ? status.message : t("mcp.auth.provider_did_not_finish"));
      await pause(signal);
    }
  };
  const driver: McpOAuthDriver = {
    start: async () => {
      signal.throwIfAborted();
      if (app) {
        const started = await app.client.startMcpOAuth(app.workspaceID, server);
        actualIntegrationID = started.integrationID; attempt = started;
        oauthState = new URL(started.url).searchParams.get("state") ?? undefined;
        if (options.desktop && !sameServer(await options.desktop.localServerUrl(), app.baseUrl)) {
          try {
            const desktop = options.desktop, listener = await desktop.listen({ redirectUri: started.callback.redirectUri });
            listenerID = listener.listenerId;
            driver.receiveCode = state => desktop.wait({ listenerId: listener.listenerId, state });
          }
          catch (error) {
            // Never take over an existing listener. The same owned callback can
            // still be pasted explicitly through the typed relay.
            if (!(error instanceof Error) || !error.message.includes("MCP_OAUTH_CALLBACK_IN_USE")) throw error;
            driver.notice = t("mcp.auth.callback_port_manual_notice");
          }
        }
      } else attempt = (await client.integration.oauth.connect({ integrationID, methodID: method.id, location })).data;
      if (signal.aborted) { await cancel(); signal.throwIfAborted(); }
      return { authorizationUrl: attempt.url, expiresAt: attempt.time.expires, instructions: attempt.instructions, mode: attempt.mode, ...(app ? { manual: true } : {}) };
    },
    complete: async (code, response) => {
      if (app) {
        if (!oauthState) throw new Error(t("mcp.auth.missing_oauth_state"));
        const status = await app.client.relayMcpOAuth(app.workspaceID, { ...identity(), state: oauthState, code, ...(response?.iss ? { iss: response.iss } : {}) });
        if (status.status === "failed") throw new Error(status.message);
        if (status.status !== "complete") return wait();
      } else await client.integration.oauth.complete({ ...identity(), location, code });
      completed = true; return options.finish();
    },
    wait,
    dispose: async () => {
      if (listenerID) await options.desktop?.cancel(listenerID);
      if (attempt && !completed) await cancel();
    },
  };
  return driver;
}
