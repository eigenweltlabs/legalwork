import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat } from "node:fs/promises";

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Windows raises these while another process holds the target open. They clear
 * on their own — the holder is a scanner or a sync client, not a lasting
 * permission problem.
 */
const TRANSIENT_LOCK_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400];

/**
 * `rename`, retrying the transient locks that break write-then-rename on
 * Windows.
 *
 * A workspace on a cloud-synced drive (OneDrive, Dropbox, Google Drive) is the
 * common case: the sync client opens each newly created file to upload it, the
 * temp file of an atomic write included, and while that handle is open Windows
 * fails the rename with EPERM. Defender and the search indexer do the same
 * thing. Every attempt is a fresh rename, so the write still lands atomically
 * — it just waits out the other process (which is why graceful-fs and npm's
 * write-file-atomic retry here too).
 */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !TRANSIENT_LOCK_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function shortId(): string {
  return randomUUID();
}

export function parseList(input: string | undefined): string[] {
  if (!input) return [];
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)).filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[,;]/)
    .map((value) => value.trim())
    .filter(Boolean);
}
