import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Configuration references retain their original content base. Moved support
 * references follow their existing suffix into the local home. */
export function connectedConfigurationPath(workspace: { path: string; contentPath?: string | null }, value: string): string {
  if (value.startsWith("file://")) return pathToFileURL(connectedConfigurationPath(workspace, fileURLToPath(value))).href;
  if (value.startsWith("~/") || /^[a-z]+:\/\//i.test(value) || value.includes("{env:")) return value;
  const content = workspace.contentPath || workspace.path;
  const suffix = relative(content, resolve(content, value));
  if (/^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(suffix)) return resolve(workspace.path, suffix);
  return isAbsolute(value) ? value : resolve(content, suffix);
}

export function connectedMcpServer(workspace: { path: string; contentPath?: string | null }, server: { command: readonly string[]; cwd?: string }, defaultContent = true) {
  return {
    ...(server.cwd || defaultContent ? { cwd: connectedConfigurationPath(workspace, server.cwd || ".") } : {}),
    command: server.command.map(value => isAbsolute(value) || /^(?:\.\/)?\.(?:opencode|legalwork)(?:[\\/]|$)/.test(value) ? connectedConfigurationPath(workspace, value) : value),
  };
}
