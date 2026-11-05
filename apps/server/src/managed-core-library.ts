import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { CORE_OPENCODE_FILES } from "./core-skills.js";
import { engineStorageDir } from "./engine-storage.js";
import { parseFrontmatter } from "./frontmatter.js";
import { nativeOpencodeConfig } from "./native-opencode-config.js";
import { ensureCoreOpencodeFiles } from "./workspace-init.js";
import type { ServerConfig } from "./types.js";

export function managedCoreLibraryRoot(config: ServerConfig) {
  return join(engineStorageDir(config), "capability-library");
}

/** App-owned bundled files have one private home. Project and personal files
 * remain untouched; ordinary native schemas retain agent and command semantics. */
export async function prepareManagedCoreLibrary(config: ServerConfig) {
  const root = managedCoreLibraryRoot(config);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await ensureCoreOpencodeFiles(root);
}

export function managedCoreConfiguration() {
  const agent: Record<string, unknown> = {}, command: Record<string, unknown> = {};
  for (const file of CORE_OPENCODE_FILES) {
    const match = /^\.opencode\/(agents|commands)\/(.+)\.md$/.exec(file.path);
    if (!match) continue;
    const parsed = parseFrontmatter(file.content);
    const value = match[1] === "agents" ? { ...parsed.data, prompt: parsed.body.trim() }
      : { ...parsed.data, template: parsed.body.trim() };
    (match[1] === "agents" ? agent : command)[match[2]!] = value;
  }
  return nativeOpencodeConfig({ agent, commands: command });
}
