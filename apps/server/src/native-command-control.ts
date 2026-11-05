import { isRpcError, type OpenCodeClient } from "@opencode/client";
import { Schema } from "effect";
import { ApiError, findApiError } from "./errors.js";
import { commandSettingsRpc } from "./native-command-rpc.js";

const cancelledSchema = Schema.Struct({ cancelled: Schema.Boolean });

/** The native configured-command loader expands shell outside the shell hook. */
export async function assertManagedCommandIntegration(client: OpenCodeClient, location: { directory: string }): Promise<void> {
  const plugins = (await client.plugin.list({ location })).data;
  if (!plugins.some(plugin => plugin.id === commandSettingsRpc.id && plugin.state.status === "active")
    || plugins.some(plugin => plugin.id === "opencode.config.command")) {
    throw new ApiError(503, "managed_commands_unavailable", "LegalWork's managed command integration is not ready. Reload the engine before running this shortcut so its shell steps use this chat's permissions and sandbox.");
  }
}

export const isCompactionCommand = (name: string) => name.toLowerCase() === "compact";

/** Compact is a native lifecycle operation, not a configured template. */
export async function assertRunnableCommand(client: OpenCodeClient, location: { directory: string }, name: string): Promise<void> {
  if (isCompactionCommand(name)) return;
  await assertManagedCommandIntegration(client, location);
  const commands = (await client.command.list({ location })).data;
  if (!commands.some(item => item.name === name)) throw new ApiError(404, "command_not_found", "Command not found.");
}

export async function runNativeCommand(client: OpenCodeClient, input: Parameters<OpenCodeClient["session"]["command"]>[0], compactionID?: string): Promise<void> {
  if (isCompactionCommand(input.name)) {
    // Like the existing /compact UI shortcut, native compaction has no text,
    // file or template arguments. The full authored draft remains in the queue.
    const admitted = await client.session.compact({ sessionID: input.sessionID, delivery: input.delivery ?? undefined, ...(compactionID ? { id: compactionID } : {}) });
    if (compactionID && admitted.id !== compactionID) throw new Error("The engine did not confirm the queued compaction identity.");
    return;
  }
  await client.session.command(input);
}

function missingCommandRpc(error: unknown): boolean {
  const api = findApiError(error);
  const detail = api?.details;
  const body = detail && typeof detail === "object" && "detail" in detail ? detail.detail : error;
  return isRpcError(body) && (body.type === "rpc.unavailable" || body.type === "rpc.method_not_found");
}

/** Native interrupt alone cannot see a command still expanding its template. */
export async function interruptEngineSession(client: OpenCodeClient, sessionID: string, options: { managedCommands: boolean }): Promise<{ interrupted: boolean }> {
  const session = await client.session.get({ sessionID });
  const [command, execution] = await Promise.allSettled([
    client.rpc.call({ rpcID: commandSettingsRpc.id, method: "cancel", input: { sessionID }, location: session.location }),
    client.session.interrupt({ sessionID }),
  ]);
  // Attempt both: a broken command integration must still stop a model turn.
  // Standalone engines need not install LegalWork's command integration.
  if (command.status === "rejected" && (options.managedCommands || !missingCommandRpc(command.reason))) throw command.reason;
  if (execution.status === "rejected") throw execution.reason;
  const cancelled = command.status === "fulfilled" && Schema.decodeUnknownSync(cancelledSchema)(command.value.output).cancelled;
  return { interrupted: execution.value.interrupted || cancelled };
}
