import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServerConfig } from "../types.js";
import { ensureWikiAgentToken, grantWikiAgentSession } from "../wiki/agent-access.js";
import { timekeepingPreset } from "./profile.js";

/** Exercise the same day-log read the visible suggestions chat performs after launch. */
export async function workdayChatClient(config: ServerConfig, profileId: string, port: number) {
  if (!config.configPath) throw new Error("The source test requires an on-disk server configuration.");
  const path = await realpath(dirname(config.configPath));
  const workspace = { id: "time-review", name: "Time review", path, workspaceType: "local" as const, preset: timekeepingPreset(profileId) };
  config.workspaces.push(workspace);
  const sessionId = "workday-source-test";
  await grantWikiAgentSession(config, { workspaceId: workspace.id, directory: path, sessionId, scope: "owner" });
  const token = await ensureWikiAgentToken(config);
  return async (body: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${port}/workspace/${workspace.id}/timekeeping/workday`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-legalwork-wiki-agent-directory": encodeURIComponent(path),
        "x-legalwork-wiki-agent-session": sessionId, "x-legalwork-wiki-agent-token": token },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Workday action failed (${response.status}): ${await response.text()}`);
    return response.json();
  };
}

export async function workdayChatReader(config: ServerConfig, profileId: string, port: number) {
  const call = await workdayChatClient(config, profileId, port);
  return (date: string) => call({ action: "read", date });
}
