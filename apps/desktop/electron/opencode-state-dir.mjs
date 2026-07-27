import { existsSync } from "node:fs";
import { lstat, mkdir, rename } from "node:fs/promises";
import path from "node:path";

/**
 * Guarantee `<workspace>/.opencode` is a usable directory before the engine
 * boots.
 *
 * The engine creates that directory during instance bootstrap. `mkdir`
 * tolerates an existing *directory* but throws EEXIST when the name is taken
 * by a *file*, and the engine does not catch it — instance bootstrap aborts
 * and then every route for that workspace answers 500 `UnknownError`, which
 * the app shows as "Failed to load providers" and "OpenCode is unavailable for
 * this workspace" (issue #62). The engine also caches the failed instance, so
 * the repair has to happen before it spawns.
 *
 * The stray entry is renamed aside, never deleted — it is user data we did not
 * write, and its contents are the only clue to how it got there.
 *
 * Mirrors apps/server/src/opencode-state-dir.ts (separate package, no shared
 * module) — keep the two in sync.
 */
export async function ensureOpencodeStateDir(workspaceRoot, now = Date.now()) {
  const statePath = path.join(workspaceRoot, ".opencode");
  let movedTo = null;

  // lstat, not stat: a symlink to a file (or to nothing) breaks the engine's
  // mkdir the same way, and following it would misreport that.
  let entry = null;
  try {
    entry = await lstat(statePath);
  } catch {
    entry = null;
  }

  if (entry && !entry.isDirectory()) {
    const base = `${statePath}.invalid-${now}`;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt}`;
      if (existsSync(candidate)) continue;
      movedTo = candidate;
      break;
    }
    if (!movedTo) {
      throw new Error(`Unable to reserve a backup path for ${statePath}`);
    }
    try {
      await rename(statePath, movedTo);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${statePath} must be a folder, but a file is in its place and it could not be moved aside (${reason}). ` +
          `Rename or remove that file, then restart LegalWork.`,
      );
    }
  }

  try {
    await mkdir(statePath, { recursive: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not create the folder ${statePath} (${reason}).`);
  }

  return { path: statePath, movedTo };
}
