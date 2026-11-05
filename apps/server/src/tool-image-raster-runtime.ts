import { lstatSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolImageRasterRuntime } from "./tool-image-raster.js";

type NodeRasterHost = {
  executable: string;
  moduleUrl: string;
  versions: { node?: string; bun?: string; electron?: string };
};

/** Host descriptor seam for tests. Never populated from project, model or HTTP configuration. */
export function nodeToolImageRasterRuntime(host: NodeRasterHost): ToolImageRasterRuntime {
  if (!host.versions.node || host.versions.bun !== undefined || host.versions.electron !== undefined)
    throw new Error("Image crop runtime is unavailable: this host must supply an existing Node runtime callback.");
  if (!isAbsolute(host.executable)) throw new Error("Image crop Node executable must be an absolute host path.");
  const moduleFile = fileURLToPath(host.moduleUrl), require = createRequire(host.moduleUrl);
  const executable = realpathSync(host.executable);
  if (!statSync(executable).isFile()) throw new Error("Image crop Node executable is not a regular file.");
  function installed(name: string) {
    // Absolute package lookup follows normal installation ancestors only.
    // Bare require.resolve would also consider NODE_PATH/global fallbacks.
    let directory = dirname(moduleFile);
    for (;;) {
      const candidate = join(directory, "node_modules", name);
      try { lstatSync(candidate); }
      catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`Image crop dependency is not installed beside this server: ${name}`);
        directory = parent;
        continue;
      }
      // An existing but broken nearest installation must fail, not silently
      // select another package or a primary user's global dependency.
      const entry = realpathSync(require.resolve(candidate));
      if (!statSync(entry).isFile()) throw new Error(`Image crop dependency entrypoint is not a regular file: ${name}`);
      return entry;
    }
  }
  return { executable, canvas: installed("@napi-rs/canvas"), imageSize: installed("image-size") };
}

/** Ordinary Node server only. Electron supplies its packaged callback; Bun has no implicit fallback. */
export function resolveNodeToolImageRasterRuntime(): ToolImageRasterRuntime {
  return nodeToolImageRasterRuntime({ executable: process.execPath, moduleUrl: import.meta.url, versions: process.versions });
}
