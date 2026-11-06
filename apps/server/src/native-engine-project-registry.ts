import { readFile, realpath } from "node:fs/promises";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const nativeEngineProjectRegistrySchema = z.object({
  version: z.literal(1), projects: z.array(z.object({ directory: z.string(), approved: z.boolean(),
    generated: z.object({ scopes: z.array(z.string()), documents: z.array(z.object({ path: z.string(), digest: z.string(), alternateDigests: z.array(z.string()).optional(), optional: z.boolean().optional() })) }).optional(),
  })),
});
export type NativeEngineProjectRegistry = z.infer<typeof nativeEngineProjectRegistrySchema>;

type Entry = NativeEngineProjectRegistry["projects"][number];
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";

/** Automatic admission covers only the unchanged application documents. A new
 * authored file or executable must reach the ordinary project review first. */
function generatedDocumentsUnchanged(project: Entry): boolean {
  if (!project.generated) return true; // Explicitly approved authored scope.
  const owned = new Map(project.generated.documents.map(document => [resolve(document.path), document]));
  try {
    for (const [path, document] of owned) {
      let info;
      try { info = lstatSync(path); }
      catch (error) { if (missing(error) && document.optional) continue; return false; }
      if (!info.isFile() || info.isSymbolicLink() || realpathSync(path) !== path) return false;
      const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
      if (digest !== document.digest && !document.alternateDigests?.includes(digest)) return false;
    }
    for (const directory of project.generated.scopes) {
      for (const base of [directory, join(directory, ".opencode")]) for (const name of ["opencode.json", "opencode.jsonc"]) {
        const path = join(base, name);
        try { lstatSync(path); if (!owned.has(path)) return false; }
        catch (error) { if (!missing(error)) return false; }
      }
      for (const name of ["plugin", "plugins"]) {
        const base = join(directory, ".opencode", name);
        let entries;
        try { entries = readdirSync(base, { withFileTypes: true }); }
        catch (error) { if (missing(error)) continue; return false; }
        for (const entry of entries) {
          const info = entry.isSymbolicLink() ? statSync(join(base, entry.name)) : entry;
          if (info.isDirectory() || info.isFile() && /\.(?:js|ts)$/.test(entry.name)) return false;
        }
      }
    }
    return true;
  } catch { return false; }
}

/** Native domain transforms are synchronous. Never return an ignored Promise
 * from them; inspect this small private registry before contributing servers. */
export function nativeEngineLocationApprovedSync(path: string, directory: string): boolean {
  try {
    const actual = realpathSync(directory);
    let content = readFileSync(path, "utf8");
    while (true) {
      const file = nativeEngineProjectRegistrySchema.parse(JSON.parse(content));
      let selected: { root: string; project: Entry } | undefined;
      for (const project of file.projects) {
        const root = realpathSync(project.directory), suffix = relative(root, actual);
        if (suffix === ".." || suffix.startsWith("../") || suffix.startsWith("..\\") || isAbsolute(suffix)) continue;
        if (selected?.root === root) return false;
        if (!selected || root.length > selected.root.length) selected = { root, project };
      }
      if (selected?.project.approved === true && generatedDocumentsUnchanged(selected.project)) return true;
      // A watched replacement can complete after we read the old registry.
      // Re-evaluate only a changed private publication, never arbitrary bytes.
      const current = readFileSync(path, "utf8");
      if (current === content) return false;
      content = current;
    }
  } catch { return false; }
}

/** Unknown locations and an unavailable private registry fail closed. */
export async function nativeEngineLocationApproved(path: string, directory: string): Promise<boolean> {
  const actual = await realpath(directory).catch(() => resolve(directory));
  let content = await readFile(path, "utf8");
  while (true) {
    const file = nativeEngineProjectRegistrySchema.parse(JSON.parse(content));
    let selected: { root: string; project: Entry } | undefined;
    for (const project of file.projects) {
      const root = await realpath(project.directory).catch(() => resolve(project.directory));
      const suffix = relative(root, actual);
      if (suffix === ".." || suffix.startsWith("../") || suffix.startsWith("..\\") || isAbsolute(suffix)) continue;
      if (selected?.root === root) return false;
      if (!selected || root.length > selected.root.length) selected = { root, project };
    }
    if (selected?.project.approved === true && generatedDocumentsUnchanged(selected.project)) return true;
    const current = await readFile(path, "utf8");
    if (current === content) return false;
    content = current;
  }
}
