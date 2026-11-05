import { z } from "zod";
import { createEngineClient, workspaceEngineLocation } from "./engine-client.js";
import { ApiError } from "./errors.js";
import { listMcp } from "./mcp.js";
import { McpRecovery } from "./mcp-recovery.js";
import { isInternalSession } from "./native-shared-values.js";
import { pathWithin } from "./native-proxy-policy.js";
import { resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";
import { allowedMemberConnectors } from "./org-policy-items.js";
import { readManagedEngineSettings } from "./managed-engine-settings.js";
import { managedEngineSettingsFilePath } from "./legalwork-runtime-config.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const recoveryByServer = new WeakMap<ServerConfig, McpRecovery>();
const statusesSchema = z.record(z.string(), z.object({ status: z.string() }));

export function mcpRecovery(config: ServerConfig): McpRecovery {
  const recovery = recoveryByServer.get(config) ?? new McpRecovery();
  recoveryByServer.set(config, recovery);
  return recovery;
}

/** A cancelled admission stops waiting and never sends the prompt. Shared native
 * handshakes retain their connector lock until the engine actually settles. */
function waitForRecovery(operation: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(() => { signal.removeEventListener("abort", abort); resolve(); }, error => {
      signal.removeEventListener("abort", abort); reject(error);
    });
    if (signal.aborted) abort();
  });
}

/** Reconnect transport only. Never edit definitions, remove tokens, or replay
 * prompts/tools. Native configuration order remains authoritative. */
export async function recoverWorkspaceMcp(config: ServerConfig, workspace: WorkspaceInfo, directory: string, snapshot?: unknown, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  try {
    const client = createEngineClient(config, workspace);
    const readStatuses = async (requestSignal?: AbortSignal) => {
      const deadline = AbortSignal.timeout(5000);
      const result = await client.mcp.list({ location: { directory } }, { signal: requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline });
      return statusesSchema.parse(Object.fromEntries(result.data.map(server => [server.name, server.status])));
    };
    const statuses = snapshot === undefined ? await readStatuses(signal) : statusesSchema.parse(snapshot);
    await waitForRecovery(mcpRecovery(config).recover({
      engine: resolveWorkspaceOpencodeConnection(config, workspace).baseUrl ?? "",
      directory, statuses, readStatuses,
      connectors: async () => {
        const [definitions, stored] = await Promise.all([
          config.engineConfigurationMode === "managed"
            ? readManagedEngineSettings(managedEngineSettingsFilePath(config), directory).then(settings => settings.configuration.mcp?.servers ?? {})
            : client.config.get({ location: { directory } }).then(entries => Object.fromEntries(entries.flatMap(entry => entry.type === "document" ? Object.entries(entry.info.mcp?.servers ?? {}) : []))),
          listMcp(config, workspace.id, directory),
        ]);
        const allowed = await allowedMemberConnectors(config, definitions);
        return Object.entries(allowed).map(([name, definition]) => ({ name, config: { ...definition, enabled: definition.disabled !== true && Reflect.get(definition, "enabled") !== false },
          disabledByTools: stored.find(item => item.name === name)?.disabledByTools }));
      },
      // Fetch cancellation does not cancel the engine's handshake. Keep the
      // lock until it actually settles; the engine enforces its MCP timeout.
      connect: server => client.mcp.connect({ location: { directory }, server }),
    }), signal);
  } catch {
    signal?.throwIfAborted();
    // Engine unavailability must not erase connector state or block other work.
  }
}

/** Resolve the saved session location rather than the plugin/client default.
 * Internal extraction/connector operations have their own restricted catalog. */
export async function recoverSessionMcp(config: ServerConfig, workspace: WorkspaceInfo, sessionID: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const session = await createEngineClient(config, workspace).session.get({ sessionID }, { signal });
  if (!await pathWithin(workspaceEngineLocation(workspace).directory, session.location.directory)) {
    throw new ApiError(404, "session_not_found", "This chat does not belong to the project.");
  }
  if (isInternalSession(session) || session.agent === "document-extractor") return;
  await recoverWorkspaceMcp(config, workspace, session.location.directory, undefined, signal);
}
