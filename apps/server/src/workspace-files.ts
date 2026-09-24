import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function globalOpencodeConfigDir(): string {
  return join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "opencode");
}

/**
 * Global library shared with desktop import/listing and available in every workspace.
 * The desktop passes XDG_CONFIG_HOME after migrating its former Windows
 * APPDATA library. Standalone Windows servers retain their existing library
 * until they can run that migration too.
 */
export function globalSkillsDir(): string {
  if (process.env.XDG_CONFIG_HOME?.trim() || process.platform !== "win32") {
    return join(globalOpencodeConfigDir(), "skills");
  }
  const appData = process.env.APPDATA?.trim();
  return appData ? join(appData, "opencode", "skills") : join(globalOpencodeConfigDir(), "skills");
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

/** All legacy project files the engine may merge, in display precedence order. */
export function opencodeConfigPaths(workspaceRoot: string): string[] {
  return [
    join(workspaceRoot, "opencode.jsonc"),
    join(workspaceRoot, "opencode.json"),
    join(workspaceRoot, ".opencode", "opencode.jsonc"),
    join(workspaceRoot, ".opencode", "opencode.json"),
  ];
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
