/**
 * Guarantees `<workspace>/.opencode` is a usable directory.
 *
 * The engine creates that directory during instance bootstrap
 * (Config.loadInstanceState). `mkdir` tolerates an existing *directory*, but
 * throws EEXIST when the name is taken by a *file* — and the engine does not
 * catch it, so instance bootstrap aborts. A failed bootstrap poisons the
 * whole workspace: every route (provider list, MCP connect, session create)
 * then answers 500 `UnknownError` with an `err_…` ref, which surfaces in the
 * app as "Failed to load providers" and "OpenCode is unavailable for this
 * workspace". Reproduced against the pinned engine binary; see issue #62.
 *
 * Two things make this worth repairing rather than reporting:
 * - LegalWork owns that directory (it stores legalwork.json and the seeded
 *   opencode.jsonc there), so it cannot simply avoid creating it.
 * - The engine caches the failed instance, so a workspace stays broken until
 *   the engine restarts — repairing before the engine spawns is what makes
 *   the recovery automatic.
 *
 * The stray entry is renamed aside, never deleted: it is user data we did not
 * write, and its contents are the only clue to how it got there.
 *
 * apps/desktop/electron/runtime.mjs carries an equivalent implementation for
 * the Electron main process (separate package, no shared module) — keep the
 * two in sync.
 */
import { lstat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

export const OPENCODE_STATE_DIR_NAME = ".opencode";

export type OpencodeStateDirRepair = {
  /** Absolute path of the `.opencode` directory. */
  path: string;
  /** Where a stray non-directory entry was moved, when one was found. */
  movedTo: string | null;
};

/** `<root>/.opencode.invalid-<timestamp>`, with a numeric suffix on collision. */
async function reserveBackupPath(statePath: string, now: number): Promise<string> {
  const base = `${statePath}.invalid-${now}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt}`;
    try {
      await lstat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`Unable to reserve a backup path for ${statePath}`);
}

/**
 * Ensure `<workspaceRoot>/.opencode` exists and is a directory, moving a
 * stray file/symlink of that name aside first. Returns what was done so
 * callers can log it. Throws only when the directory cannot be established,
 * with a message naming the path — a silent failure here reappears as an
 * unexplained 500 from the engine.
 */
export async function ensureOpencodeStateDir(
  workspaceRoot: string,
  now: number = Date.now(),
): Promise<OpencodeStateDirRepair> {
  const statePath = join(workspaceRoot, OPENCODE_STATE_DIR_NAME);
  let movedTo: string | null = null;

  // lstat, not stat: a symlink pointing at a file (or at nothing) fails the
  // engine's mkdir the same way, and following it would misreport that.
  let entry: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    entry = await lstat(statePath);
  } catch {
    entry = null;
  }

  if (entry && !entry.isDirectory()) {
    movedTo = await reserveBackupPath(statePath, now);
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
