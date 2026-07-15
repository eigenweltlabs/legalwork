import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The GLOBAL skills dir the desktop app reads from and installs into
 * ($XDG_CONFIG_HOME/opencode/skills). On desktop skills/workflows live here and
 * are synced into projects automatically, so hub installs must land here (not in
 * a single project's .opencode/skills, which the desktop list never scans).
 */
export function globalSkillsDir(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "opencode", "skills");
}

export function opencodeConfigPath(workspaceRoot: string): string {
  const jsoncPath = join(workspaceRoot, "opencode.jsonc");
  const jsonPath = join(workspaceRoot, "opencode.json");
  const hiddenJsoncPath = join(workspaceRoot, ".opencode", "opencode.jsonc");
  const hiddenJsonPath = join(workspaceRoot, ".opencode", "opencode.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  if (existsSync(hiddenJsoncPath)) return hiddenJsoncPath;
  if (existsSync(hiddenJsonPath)) return hiddenJsonPath;
  // Nothing exists yet: default to the hidden location so a fresh workspace
  // folder stays free of app-managed files the user didn't create. The engine
  // reads both; a root file the user creates themselves still wins above.
  return hiddenJsoncPath;
}

export function legalworkConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "legalwork.json");
}

export function projectSkillsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "skills");
}

export function projectCommandsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "commands");
}

export function projectPluginsDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "plugins");
}
