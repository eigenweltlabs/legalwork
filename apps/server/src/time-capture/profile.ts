import { readFile } from "node:fs/promises";
import { z } from "zod";
import { dirname, join } from "node:path";
import { backOfficeAccess } from "../back-office/access.js";
import { backOfficePrincipalKey } from "../back-office/principal.js";
import { readEigenweltConnection, runtimeDbPath } from "../eigenwelt-connection-store.js";
import type { Actor, ServerConfig, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import { isTimekeepingProject, TIMEKEEPING_PROJECT_PRESET_PREFIX } from "../native-shared-values.js";
import { digest } from "./private-workday.js";

export async function captureProfile(
  config: ServerConfig,
  { actor, scope }: Pick<Awaited<ReturnType<typeof backOfficeAccess>>, "actor" | "scope">,
) {
  const connection = scope === "local" ? await readEigenweltConnection(config) : undefined;
  // The local directory uses one finance identity even when different firm
  // users sign in. Private opt-ins and document names belong to the actual account.
  const account = connection?.account;
  const identity = account
    ? connection.platformURL
      ? backOfficePrincipalKey(connection.platformURL, account.orgId, account.userId)
      : digest(["account", account.orgId, account.userId])
    : (actor.principalKey ?? actor.userId);
  const owner = digest([scope, identity]);
  return {
    profileId: owner,
    captureUser: account?.userId ?? actor.userId,
    user: actor.userId,
    principal: actor.principalKey ?? "",
    scope,
    path: join(dirname(runtimeDbPath(config)), "private-timesheets", owner + ".json"),
  };
}
export async function activeCaptureProfile(config: ServerConfig) {
  return captureProfile(config, await backOfficeAccess(config));
}

export { isTimekeepingProject };
export const timekeepingPreset = (profileId: string) => TIMEKEEPING_PROJECT_PRESET_PREFIX + profileId;

export async function timekeepingEnabled(path: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return z.object({ settings: z.object({ enabled: z.boolean().optional() }) }).parse(value).settings.enabled !== false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

export async function requireTimekeepingOwner(config: ServerConfig, workspace: WorkspaceInfo) {
  if (!isTimekeepingProject(workspace)) return;
  const owner = await activeCaptureProfile(config);
  if (workspace.preset !== timekeepingPreset(owner.profileId) || !await timekeepingEnabled(owner.path))
    throw new ApiError(404, "workspace_not_found", "This project is unavailable for the current account.");
}

export function canOpenTimekeeping(actor: Actor | undefined) {
  return actor?.type === "host" || actor?.scope === "owner";
}

export async function visibleTimekeepingProjects(config: ServerConfig, actor?: Actor) {
  if (!config.workspaces.some(isTimekeepingProject)) return config.workspaces;
  if (actor && !canOpenTimekeeping(actor)) return config.workspaces.filter(workspace => !isTimekeepingProject(workspace));
  const active = await activeCaptureProfile(config).catch(() => null);
  const preset = active && await timekeepingEnabled(active.path).catch(() => false) ? timekeepingPreset(active.profileId) : null;
  return config.workspaces.filter(workspace => !isTimekeepingProject(workspace) || workspace.preset === preset);
}
