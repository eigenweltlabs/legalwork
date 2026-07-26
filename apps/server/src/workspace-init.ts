import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { ensureDir, exists } from "./utils.js";
import { ApiError } from "./errors.js";
import { CORE_OPENCODE_FILES } from "./core-skills.js";
import { legalworkConfigPath, opencodeConfigPath } from "./workspace-files.js";
import { readJsoncFile } from "./jsonc.js";
import { ensureOpencodeStateDir } from "./opencode-state-dir.js";
import type { ReloadReason } from "./types.js";

// One hash over all bundled-core file contents. Bumps whenever the app ships a new
// version of these files, which is the trigger to refresh already-seeded workspaces.
const CORE_BUNDLE_HASH = createHash("sha1")
  .update(CORE_OPENCODE_FILES.map((f) => `${f.path} ${f.content}`).join(" "))
  .digest("hex");

type WorkspaceLegalworkConfig = {
  version: number;
  workspace?: {
    name?: string | null;
    createdAt?: number | null;
    preset?: string | null;
  } | null;
  authorizedRoots: string[];
  reload?: {
    auto?: boolean;
    resume?: boolean;
  } | null;
};

type EnsureWorkspaceFilesResult = {
  changed: boolean;
  reloadReasons: ReloadReason[];
};

function normalizePreset(preset: string | null | undefined): string {
  const trimmed = preset?.trim() ?? "";
  if (!trimmed) return "starter";
  return trimmed;
}

async function ensureWorkspaceLegalworkConfig(workspaceRoot: string, preset: string): Promise<boolean> {
  const path = legalworkConfigPath(workspaceRoot);
  if (await exists(path)) return false;
  const now = Date.now();
  const config: WorkspaceLegalworkConfig = {
    version: 1,
    workspace: {
      name: basename(workspaceRoot) || "Workspace",
      createdAt: now,
      preset,
    },
    authorizedRoots: [workspaceRoot],
    reload: null,
  };
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf8");
  return true;
}

/**
 * Seed the "bundled-core" skills/agents (the tabular-review engine, its HTML template,
 * the builder, and the document-extractor agent) into the workspace. These are
 * APP-MANAGED: a hash stamp (`.opencode/.legalwork-core`) records the bundle version,
 * and when the app ships a new bundle the stale copies are refreshed in place. Between
 * versions it is a no-op (and a core file the user deletes simply comes back). Files for
 * OTHER skills are never touched. Returns the reload reasons for any files written.
 */
async function ensureCoreOpencodeFiles(workspaceRoot: string): Promise<ReloadReason[]> {
  const reasons = new Set<ReloadReason>();
  const stampPath = join(workspaceRoot, ".opencode", ".legalwork-core");
  const prev = (await exists(stampPath)) ? (await readFile(stampPath, "utf8")).trim() : "";
  // Refresh when the bundle changed (or this workspace was never stamped). This overwrites
  // older bundled copies so design/format updates actually reach existing workspaces.
  const refresh = prev !== CORE_BUNDLE_HASH;
  for (const file of CORE_OPENCODE_FILES) {
    const dest = join(workspaceRoot, file.path);
    if (await exists(dest)) {
      if (!refresh) continue;
      if ((await readFile(dest, "utf8")) === file.content) continue; // already identical
    }
    await ensureDir(dirname(dest));
    await writeFile(dest, file.content, "utf8");
    if (file.path.includes("/skills/")) reasons.add("skills");
    if (file.path.includes("/commands/")) reasons.add("commands");
    if (file.path.includes("/agents/")) reasons.add("agents");
  }
  if (refresh) {
    await ensureDir(join(workspaceRoot, ".opencode"));
    await writeFile(stampPath, `${CORE_BUNDLE_HASH}\n`, "utf8");
  }
  return Array.from(reasons);
}

async function ensureOpencodeConfig(workspaceRoot: string): Promise<boolean> {
  const path = opencodeConfigPath(workspaceRoot);
  if (await exists(path)) {
    await readJsoncFile<Record<string, unknown>>(path, {}, { allowInvalid: true });
  }
  return false;
}

export async function ensureWorkspaceFiles(workspaceRoot: string, presetInput: string): Promise<EnsureWorkspaceFilesResult> {
  const preset = normalizePreset(presetInput);
  if (!workspaceRoot.trim()) {
    throw new ApiError(400, "invalid_workspace_path", "workspace path is required");
  }
  await ensureDir(workspaceRoot);
  // Before anything writes into .opencode: a stray file of that name makes the
  // engine's instance bootstrap throw EEXIST, which 500s every route for this
  // workspace (issue #62).
  const stateDir = await ensureOpencodeStateDir(workspaceRoot);
  if (stateDir.movedTo) {
    console.warn(
      `[workspace-init] ${stateDir.path} was a file, not a folder; moved it to ${stateDir.movedTo} so OpenCode can start.`,
    );
  }
  const reloadReasons = new Set<ReloadReason>();
  if (await ensureOpencodeConfig(workspaceRoot)) reloadReasons.add("config");
  const legalworkConfigChanged = await ensureWorkspaceLegalworkConfig(workspaceRoot, preset);
  for (const reason of await ensureCoreOpencodeFiles(workspaceRoot)) reloadReasons.add(reason);
  return {
    changed: legalworkConfigChanged || reloadReasons.size > 0,
    reloadReasons: Array.from(reloadReasons),
  };
}

export async function readRawOpencodeConfig(path: string): Promise<{ exists: boolean; content: string | null }> {
  const hasFile = await exists(path);
  if (!hasFile) {
    return { exists: false, content: null };
  }
  const content = await readFile(path, "utf8");
  return { exists: true, content };
}
