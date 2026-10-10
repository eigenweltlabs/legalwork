import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

const Selection = z.strictObject({ providerID: z.literal("eigenwelt-cloud"), modelID: z.string().min(1).max(512) });

/** Inject only the controller-managed provider into the engine's refreshed file.
 * OpenCode caches global configuration before a new worker has a model key.
 * Keeping this out of runtime.sqlite also keeps the scoped key out of sync.
 */
export async function readChannelProvider(): Promise<Record<string, unknown>> {
  const selectionPath = process.env.LEGALWORK_CHANNEL_MODEL;
  if (!selectionPath) return {};
  const content = await readFile(selectionPath, "utf8").catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (content === null) return {}; // An empty development VM is configured after boot.
  const selection = Selection.parse(JSON.parse(content));
  const path = resolve(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode/opencode.json");
  const config = z.object({ provider: z.record(z.string(), z.unknown()) }).parse(JSON.parse(await readFile(path, "utf8")));
  const provider = z.object({ models: z.record(z.string(), z.unknown()) }).passthrough().parse(config.provider[selection.providerID]);
  if (!(selection.modelID in provider.models)) throw new Error("Channel model is absent from its managed provider");
  return { [selection.providerID]: provider };
}
