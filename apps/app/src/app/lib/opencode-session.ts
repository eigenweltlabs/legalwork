import {ensureNativeCatalogReady} from "./opencode-catalog-ready";
import type { Client, ModelRef } from "../types";
import { projectSession, type SessionView } from "./opencode-view";
import { selectSessionExecution } from "./system-reminder";
export async function abortSession(
  client: Client,
  sessionID: string,
  _directory?: string,
): Promise<boolean> {
  return (await client.session.interrupt({ sessionID })).interrupted;
}
export async function abortSessionSafe(
  client: Client,
  sessionID: string,
  directory?: string,
): Promise<boolean> {
  try {
    return await abortSession(client, sessionID, directory);
  } catch {
    return false;
  }
}
export async function revertSession(
  client: Client,
  sessionID: string,
  messageID: string,
): Promise<SessionView> {
  await client.session.revert.stage({ sessionID, messageID });
  return projectSession(await client.session.get({ sessionID }));
}
export async function forkSession(
  client: Client,
  sessionID: string,
  messageID?: string,
): Promise<SessionView> {
  return projectSession(
    await client.session.fork({ sessionID, before: messageID }),
  );
}
export async function unrevertSession(
  client: Client,
  sessionID: string,
): Promise<SessionView> {
  await client.session.revert.clear({ sessionID });
  return projectSession(await client.session.get({ sessionID }));
}
export async function setSessionArchived(
  client: Client,
  sessionID: string,
  archived: boolean,
  _directory?: string,
): Promise<void> {
  await client.session.update({ sessionID, archived });
}
export async function compactSession(
  client: Client,
  sessionID: string,
  model: ModelRef,
  _options?: { directory?: string },
): Promise<void> {
  await selectSessionExecution(client, sessionID, { model });
  await client.session.compact({ sessionID });
}
export async function shellInSession(
  client: Client,
  sessionID: string,
  command: string,
  options?: { model?: ModelRef; agent?: string; variant?: string },
): Promise<void> {
  await client.session.update({ sessionID, archived: false });
  if (options) await selectSessionExecution(client, sessionID, options);
  await client.session.shell({ sessionID, command });
}
export type CommandListItem = {
  id: string;
  name: string;
  description?: string;
  source?: "command" | "mcp" | "skill";
};
export async function listCommands(
  client: Client,
  directory?: string,
): Promise<CommandListItem[]> {
  await ensureNativeCatalogReady(client,directory);
  const commands = await client.command.list({
    location: directory ? { directory } : undefined,
  });
  return commands.data.map((command) => ({
    id: `cmd:${command.name}`,
    name: command.name,
    description: command.description,
    source: "command",
  }));
}
