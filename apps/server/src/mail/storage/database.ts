import { constants } from "node:fs";
import { lstat, mkdir, open, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import type { MailDatabase, MailSqlRow, MailSqlValue } from "./database-interface.js";

// The pinned package omits its declarations from its NodeNext exports map.
// Keep a narrow native boundary, then validate its engine/configuration before disk use.
interface NativeDatabase {
  prepare(sql: string): {
    get(...parameters: readonly MailSqlValue[]): unknown;
    all(...parameters: readonly MailSqlValue[]): unknown[];
    run(...parameters: readonly MailSqlValue[]): { changes: number };
  };
  pragma(sql: string, options?: { simple: boolean }): unknown;
  key(key: Buffer): number;
  rekey(key: Buffer): number;
  defaultSafeIntegers(enabled: boolean): void;
  transaction<T>(body: () => T): { immediate(): T };
  exec(sql: string): void;
  close(): void;
}
interface NativeConstructor {
  new(path: string, options?: { fileMustExist: boolean }): NativeDatabase;
}
function isNativeConstructor(value: unknown): value is NativeConstructor {
  return typeof value === "function";
}

export interface EncryptedMailDatabaseOptions {
  path: string;
  /** Caller owns and must clear its key; this function clears its temporary copy. */
  key: Uint8Array;
}

function row(value: unknown): MailSqlRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid SQLite row");
  const result: Record<string, MailSqlValue> = {};
  for (const [name, cell] of Object.entries(value)) {
    if (typeof cell === "bigint") {
      const number = Number(cell);
      if (!Number.isSafeInteger(number)) throw new Error("SQLite integer exceeds safe numeric range");
      Object.defineProperty(result, name, { value: number, enumerable: true });
    } else if (cell === null || typeof cell === "string" || typeof cell === "number" || cell instanceof Uint8Array) {
      Object.defineProperty(result, name, { value: cell, enumerable: true });
    } else throw new Error("Unsupported SQLite value");
  }
  return result;
}

function verifyEngine(db: NativeDatabase): void {
  const identity = row(db.prepare("SELECT sqlite3mc_version() AS engine, sqlite_version() AS sqlite").get());
  if (identity.engine !== "SQLite3 Multiple Ciphers 2.4.0" || identity.sqlite !== "3.53.4") {
    throw new Error("Unsupported encrypted SQLite engine");
  }
}

async function verifyPrivateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) throw new Error("Mail database must be a regular file with a single link");
  if (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
    throw new Error("Mail database must be privately owned with mode 0600");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Worker-only encrypted SQLite. There is no plaintext runtime or backend fallback. */
export async function openEncryptedMailDatabase(options: EncryptedMailDatabaseOptions): Promise<MailDatabase> {
  if (process.versions.bun) throw new Error("Encrypted mail storage requires a Node/Electron worker; Bun native loading is unsupported");
  if (!Number.isInteger(Number(process.versions.napi)) || Number(process.versions.napi) < 10 || !process.versions.node) throw new Error("Encrypted mail storage requires Node-API 10 or newer");
  if (!options || !(options.key instanceof Uint8Array) || options.key.byteLength !== 32) {
    throw new Error("A 32-byte mail database key is required");
  }
  if (typeof options.path !== "string" || !isAbsolute(options.path) || options.path.includes("\0")) {
    throw new Error("An absolute mail database filesystem path is required");
  }
  const path = options.path;
  // Copy before the first await; caller changes cannot race the key used to open.
  const key = Buffer.from(options.key);
  let native: NativeDatabase | undefined;
  try {
    const Database: unknown = createRequire(import.meta.url)("better-sqlite3-multiple-ciphers");
    if (!isNativeConstructor(Database)) throw new Error("Invalid encrypted SQLite module");
    // Reject an unknown/plaintext module before touching the target filesystem.
    const probe = new Database(":memory:");
    try { verifyEngine(probe); } finally { probe.close(); }

    const folder = dirname(path);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const parent = await stat(folder);
    if (process.platform !== "win32" && ((parent.mode & 0o022) !== 0 || parent.uid !== process.getuid?.())) {
      throw new Error("Mail database directory must be owned and not writable by other users");
    }
    try {
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      await file.close();
    } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    await verifyPrivateFile(path);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { await verifyPrivateFile(`${path}${suffix}`); }
      catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    }

    native = new Database(path, { fileMustExist: true });
    native.pragma("cipher='sqlcipher'");
    native.pragma("legacy=0");
    native.pragma("temp_store=MEMORY");
    if (native.pragma("cipher", { simple: true }) !== "sqlcipher" ||
        String(native.pragma("legacy", { simple: true })) !== "0" ||
        native.pragma("temp_store", { simple: true }) !== 2) {
      throw new Error("Encrypted SQLite configuration could not be verified");
    }
    if (native.key(key) !== 0) throw new Error("Encrypted SQLite key setup failed");
    verifyEngine(native);
    // Force authentication BEFORE changing journal mode or running any migrations.
    native.prepare("SELECT count(*) FROM sqlite_master").get();
    if (native.pragma("journal_mode=WAL", { simple: true }) !== "wal") throw new Error("Encrypted mail database requires WAL support");
    native.pragma("synchronous=FULL");
    if (native.pragma("synchronous", { simple: true }) !== 2) throw new Error("Encrypted mail durability configuration failed");
    native.defaultSafeIntegers(true);
    const db = native;
    return {
      exec(sql) { db.exec(sql); },
      run(sql, parameters = []) { return { changes: db.prepare(sql).run(...parameters).changes }; },
      get(sql, parameters = []) {
        const value = db.prepare(sql).get(...parameters);
        return value === undefined ? undefined : row(value);
      },
      all(sql, parameters = []) { return db.prepare(sql).all(...parameters).map(row); },
      transaction<T>(body: () => T): T {
        if (Object.prototype.toString.call(body) === "[object AsyncFunction]") throw new Error("Mail transactions must be synchronous");
        return db.transaction(() => {
          const result = body();
          if (result !== null && (typeof result === "object" || typeof result === "function") &&
              "then" in result && typeof result.then === "function") {
            // Do not leave a rejected native Promise unhandled after rejecting this misuse.
            if (result instanceof Promise) void result.catch(() => {});
            throw new Error("Mail transactions cannot return thenables");
          }
          return result;
        }).immediate();
      },
      rekey(nextKey) {
        if (!(nextKey instanceof Uint8Array) || nextKey.byteLength !== 32) throw new Error("Invalid mail rekey input");
        const replacement = Buffer.from(nextKey);
        try {
          if (db.pragma("journal_mode=DELETE", { simple: true }) !== "delete") throw new Error("Mail rekey requires an exclusive store");
          if (db.rekey(replacement) !== 0) throw new Error("Mail rekey failed");
          db.prepare("SELECT count(*) FROM sqlite_master").get();
          if (db.pragma("journal_mode=WAL", { simple: true }) !== "wal") throw new Error("Mail rekey durability failed");
        } finally { replacement.fill(0); }
      },
      close() { db.close(); },
    };
  } catch (error) {
    native?.close();
    throw error;
  } finally { key.fill(0); }
}
