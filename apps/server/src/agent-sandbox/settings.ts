import { type NetworkMode } from "./network.js";
export { networkModeSchema, type NetworkMode } from "./network.js";
import type { ServerConfig } from "../types.js";
import { GLOBAL_TOOL_PERMISSIONS_ID, readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";

export async function readSandboxNetworkMode(config: ServerConfig): Promise<NetworkMode> {
  const settings = await readRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID);
  // Existing webfetch allowances never silently grant unrestricted sockets.
  return settings.sandboxNetworkMode ?? "approve";
}

export async function writeSandboxNetworkMode(config: ServerConfig, mode: NetworkMode): Promise<void> {
  await writeRuntimeOpencodeConfig(config, GLOBAL_TOOL_PERMISSIONS_ID, (current) => ({ ...current, sandboxNetworkMode: mode }));
}
