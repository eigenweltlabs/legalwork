import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WorkspaceRoots } from "./project-storage-paths.js";

/** Only references to the two relocated support folders change. */
export function relocatedSupportReference(workspace: WorkspaceRoots, value: string): string {
  if (!workspace.previousPath && !workspace.previousPaths?.length) return value;
  if (value.startsWith("file://")) {
    try {
      const url = new URL(value), path = fileURLToPath(url), mapped = relocatedSupportReference(workspace, path);
      if (mapped === path) return value;
      const result = pathToFileURL(mapped); result.search = url.search; result.hash = url.hash;
      return result.href;
    } catch { return value; } // Unrelated URLs/placeholders are not project paths.
  }
  for (const source of new Set([workspace.previousPath, ...workspace.previousPaths ?? []])) {
    if (!source) continue;
    for (const folder of [".opencode", ".legalwork"]) {
      const from = resolve(source, folder), to = resolve(workspace.path, folder);
      for (const prefix of new Set([from, from.replaceAll("\\", "/")])) {
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        value = value.replace(new RegExp(`${escaped}(?=[/\\\\\\s'\"}):,]|$)`, process.platform === "win32" ? "gi" : "g"), () => prefix.includes("\\") ? to : to.replaceAll("\\", "/"));
      }
    }
  }
  return value;
}

export function relocatedSupportValues(workspace: WorkspaceRoots, value: unknown): unknown {
  if (typeof value === "string") return relocatedSupportReference(workspace, value);
  if (Array.isArray(value)) return value.map(item => relocatedSupportValues(workspace, item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocatedSupportValues(workspace, item)]));
  return value;
}

/** Provider strings may contain native {file:...} tokens, alongside user text. */
export function relocatedProviderFiles(workspace: WorkspaceRoots, value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\{file:[^}]+\}/g, token => relocatedSupportReference(workspace, token));
  if (Array.isArray(value)) return value.map(item => relocatedProviderFiles(workspace, item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocatedProviderFiles(workspace, item)]));
  return value;
}

/** Configuration references retain their original content base. Moved support
 * references follow their existing suffix into the local home. */
export function connectedConfigurationPath(workspace: WorkspaceRoots, value: string): string {
  if (value.startsWith("file://")) return pathToFileURL(connectedConfigurationPath(workspace, fileURLToPath(value))).href;
  if (value.startsWith("~/") || /^[a-z]+:\/\//i.test(value) || value.includes("{env:")) return value;
  value = relocatedSupportReference(workspace, value);
  const content = workspace.contentPath || workspace.path;
  const suffix = relative(content, resolve(content, value));
  if (/^(?:\.opencode|\.legalwork)(?:[\\/]|$)/.test(suffix)) return resolve(workspace.path, suffix);
  return isAbsolute(value) ? value : resolve(content, suffix);
}

export function connectedMcpServer(workspace: WorkspaceRoots, server: { command: readonly string[]; cwd?: string; environment?: Readonly<Record<string, string>> }, defaultContent = true) {
  return {
    ...(server.cwd || defaultContent ? { cwd: connectedConfigurationPath(workspace, server.cwd || ".") } : {}),
    command: server.command.map(value => isAbsolute(value) || /^(?:\.\/)?\.(?:opencode|legalwork)(?:[\\/]|$)/.test(value) ? connectedConfigurationPath(workspace, value) : relocatedSupportReference(workspace, value)),
    ...(server.environment ? { environment: Object.fromEntries(Object.entries(server.environment).map(([key, value]) => [key, relocatedSupportReference(workspace, value)])) } : {}),
  };
}
