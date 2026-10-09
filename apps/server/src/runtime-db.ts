import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ServerConfig } from "./types.js";

/**
 * runtime.sqlite, the machine's own store beside the server config: the
 * statements its stores need, over bun:sqlite (bun) or node:sqlite (Node /
 * Electron) — better-sqlite3 is not loadable under bun.
 */

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

export type SqliteHandle = {
  close: () => void;
  run: (sql: string, params?: SqlValue[]) => void;
  all: (sql: string, params?: SqlValue[]) => Row[];
  get: (sql: string, params?: SqlValue[]) => Row | undefined;
  exec: (sql: string) => void;
};

export async function openSqlite(path: string): Promise<SqliteHandle> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    return {
      close: () => db.close(),
      run: (sql, params = []) => {
        db.query(sql).run(...params);
      },
      all: (sql, params = []) => db.query(sql).all(...params) as Row[],
      get: (sql, params = []) => (db.query(sql).get(...params) as Row | null) ?? undefined,
      exec: (sql) => {
        db.exec(sql);
      },
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  return {
    close: () => db.close(),
    run: (sql, params = []) => {
      db.prepare(sql).run(...params);
    },
    all: (sql, params = []) => db.prepare(sql).all(...params) as Row[],
    get: (sql, params = []) => db.prepare(sql).get(...params) as Row | undefined,
    exec: (sql) => {
      db.exec(sql);
    },
  };
}

export function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.LEGALWORK_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : join(homedir(), ".config", "legalwork");
  return join(configDir, "runtime.sqlite");
}
