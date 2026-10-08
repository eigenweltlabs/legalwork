import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const pending = new Map<string, Promise<void>>();

/** Resolve aliases even when the last component is a newly created file. */
export async function canonicalFilePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) return resolve(path);
    return resolve(await canonicalFilePath(parent), basename(path));
  }
}

/** The revision check and replacement must be one operation, across both APIs. */
export async function withFileWriteLock<T>(path: string, write: () => Promise<T>): Promise<T> {
  const key = await canonicalFilePath(path);
  const previous = pending.get(key) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((done) => { release = done; });
  pending.set(key, current);
  await previous;
  try { return await write(); }
  finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}

/** Deterministic ordering prevents opposite-direction moves from deadlocking. */
export async function withFileWriteLocks<T>(paths: string[], write: () => Promise<T>): Promise<T> {
  const keys = [...new Set(await Promise.all(paths.map(canonicalFilePath)))].sort();
  const acquire = (index: number): Promise<T> => index === keys.length ? write() : withFileWriteLock(keys[index], () => acquire(index + 1));
  return acquire(0);
}
