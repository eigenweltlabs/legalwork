import { posix } from "node:path";
import { ApiError } from "./errors.js";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Both hosts resolve local entries from the marketplace root, not its metadata
 * directory. Reading a catalog never executes a command or installs a registry package. */
export function localMarketplaceEntries(value: unknown): { path: string; entry: Record<string, unknown> }[] {
  if (!object(value) || !Array.isArray(value.plugins)) return [];
  const pluginRoot = object(value.metadata) && typeof value.metadata.pluginRoot === "string" ? value.metadata.pluginRoot : undefined;
  return value.plugins.flatMap(entry => {
    if (!object(entry)) return [];
    const source = entry.source;
    let path = typeof source === "string" ? source : object(source) && source.source === "local" && typeof source.path === "string" ? source.path : undefined;
    if (!path) return [];
    if (pluginRoot && /^[\w.-]+$/.test(path) && path !== "." && path !== "..") path = `${pluginRoot}/${path}`;
    if (path !== "." && !path.startsWith("./") || path.includes("\\") || path.split("/").includes("..")) return [];
    return [{ path: posix.normalize(path), entry }];
  });
}

export function marketplaceManifest(manifest: Record<string, unknown>, entry: Record<string, unknown> | undefined, hasManifest: boolean): Record<string, unknown> {
  if (!entry) return manifest;
  if (!hasManifest) return entry;
  const result = { ...manifest };
  for (const field of ["displayName", "description", "author", "homepage", "repository", "license", "keywords"]) if (entry[field] !== undefined) result[field] = entry[field];
  for (const field of ["commands", "agents", "skills", "hooks", "outputStyles", "themes"]) {
    if (entry[field] === undefined) continue;
    if (entry.strict === false) throw new ApiError(400, "invalid_plugin_import", `Plugin ${String(entry.name)} has conflicting manifests. Remove the marketplace component overrides or enable strict mode.`);
    const current = result[field];
    if (current === undefined) result[field] = entry[field];
    else if (object(current) && object(entry[field])) result[field] = { ...current, ...entry[field] };
    else result[field] = [...(Array.isArray(current) ? current : [current]), ...(Array.isArray(entry[field]) ? entry[field] : [entry[field]])];
  }
  return result;
}
