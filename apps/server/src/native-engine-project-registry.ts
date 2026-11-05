import { readFile, realpath } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export const nativeEngineProjectRegistrySchema = z.object({
  version: z.literal(1), projects: z.array(z.object({ directory: z.string(), approved: z.boolean() })),
});
export type NativeEngineProjectRegistry = z.infer<typeof nativeEngineProjectRegistrySchema>;

/** Native domain transforms are synchronous. Never return an ignored Promise
 * from them; inspect this small private registry before contributing servers. */
export function nativeEngineLocationApprovedSync(path: string, directory: string): boolean {
  try {
    const file = nativeEngineProjectRegistrySchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const actual = realpathSync(directory);
    for (const project of file.projects) {
      if (!project.approved) continue;
      const root = realpathSync(project.directory), suffix = relative(root, actual);
      if (suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix)) return true;
    }
    return false;
  } catch { return false; }
}

/** Unknown locations and an unavailable private registry fail closed. */
export async function nativeEngineLocationApproved(path: string, directory: string): Promise<boolean> {
  const file = nativeEngineProjectRegistrySchema.parse(JSON.parse(await readFile(path, "utf8")));
  const actual = await realpath(directory).catch(() => resolve(directory));
  for (const project of file.projects) {
    if (!project.approved) continue;
    const root = await realpath(project.directory).catch(() => resolve(project.directory));
    const suffix = relative(root, actual);
    if (suffix !== ".." && !suffix.startsWith("../") && !suffix.startsWith("..\\") && !isAbsolute(suffix)) return true;
  }
  return false;
}
