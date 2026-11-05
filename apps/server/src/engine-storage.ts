import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/** Settings and the capability library stay shared. Each independently owned
 * launcher may isolate its engine lease, generated configuration and history. */
export function engineStorageDir(config: ServerConfig): string {
  return config.managedEngineStorageDirectory ?? runtimeStorageDir(config);
}
