import { ApiError } from "./errors.js";
import { writeLegalworkRuntimeConfigFile } from "./legalwork-runtime-config.js";
import type { ServerConfig } from "./types.js";

const publications = new WeakMap<ServerConfig, Promise<void>>();

/** Initial engine startup builds the registry. Later project mutations must
 * publish their native configuration before their first task can be admitted. */
export function commitRegisteredEngineProjects<T>(config: ServerConfig, save: () => Promise<T>): Promise<T> {
  const previous = publications.get(config);
  const operation = (async () => {
    await previous?.catch(() => {});
    const result = await save();
    try { if (config.engineConfigurationMode && config.opencodeBaseUrl) await writeLegalworkRuntimeConfigFile(config, config.workspaces[0]?.id ?? ""); }
    catch (cause) {
      const error = new ApiError(503, "project_engine_setup_failed", "The project was saved, but its AI configuration could not be applied. Retry project setup before sending a task.");
      error.cause = cause;
      throw error;
    }
    return result;
  })();
  const pending = operation.then(() => {});
  publications.set(config, pending);
  void pending.then(() => { if (publications.get(config) === pending) publications.delete(config); }, () => {});
  return operation;
}

export const publishRegisteredEngineProjects = (config: ServerConfig) => commitRegisteredEngineProjects(config, async () => {});

export async function awaitRegisteredEngineProjects(config: ServerConfig): Promise<void> {
  let pending: Promise<void> | undefined;
  while (pending !== publications.get(config)) {
    pending = publications.get(config);
    await pending;
  }
}
