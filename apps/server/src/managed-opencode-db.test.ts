import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  MANAGED_ENGINE_DB_FILENAME,
  PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP,
  classifySharedOpencodeDb,
  prepareManagedOpencodeEngineDb,
} from "./managed-opencode-db.js";
import type { ServerConfig } from "./types.js";

let root: string;
const savedEnv: Record<string, string | undefined> = {};

function createDb(path: string, setup: (db: Database) => void): void {
  const db = new Database(path, { create: true });
  try {
    setup(db);
  } finally {
    db.close();
  }
}

function createEngineStyleDb(path: string, migrationIds: string[]): void {
  createDb(path, (db) => {
    db.exec("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER)");
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, data TEXT)");
    const insert = db.query("INSERT INTO migration (id, time_completed) VALUES (?, ?)");
    for (const id of migrationIds) insert.run(id, Date.now());
    db.query("INSERT INTO session (id, data) VALUES (?, ?)").run("ses_test", "{}");
  });
}

function testConfig(): ServerConfig {
  // Only configPath is consulted (runtimeStorageDir derives from it).
  return { configPath: join(root, "config", "server.json") } as unknown as ServerConfig;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "legalwork-managed-db-"));
  for (const key of [
    "OPENCODE_DB",
    "LEGALWORK_DEV_MODE",
    "XDG_DATA_HOME",
    "LEGALWORK_DATA_DIR",
    "LEGALWORK_RUNTIME_DB",
  ]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Point the shared-DB discovery at an isolated location.
  process.env.XDG_DATA_HOME = join(root, "xdg-data");
  // runtimeStorageDir() prefers LEGALWORK_RUNTIME_DB over the config path, and
  // sibling suites set it, so pin it inside this test's temp root. Without
  // this the private DB lands in whatever directory leaked in — shared across
  // these tests — and a DB written by one test makes the next one take the
  // "private DB already exists" early return.
  process.env.LEGALWORK_RUNTIME_DB = join(root, "config", "runtime.sqlite");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function sharedDbPath(): string {
  const dir = join(root, "xdg-data", "opencode");
  return join(dir, "opencode.db");
}

function ensureSharedDbDir(): void {
  mkdirSync(join(root, "xdg-data", "opencode"), { recursive: true });
}

describe("classifySharedOpencodeDb", () => {
  test("accepts a DB whose migrations are all known to the pinned engine", async () => {
    ensureSharedDbDir();
    createEngineStyleDb(sharedDbPath(), [
      "20260127222353_familiar_lady_ursula",
      `${PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP}_simplify_session_input`,
    ]);
    expect(await classifySharedOpencodeDb(sharedDbPath())).toBe("compatible");
  });

  test("rejects a DB migrated by a newer OpenCode", async () => {
    ensureSharedDbDir();
    createEngineStyleDb(sharedDbPath(), [
      `${PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP}_simplify_session_input`,
      "20990101000000_from_the_future",
    ]);
    expect(await classifySharedOpencodeDb(sharedDbPath())).toBe("foreign");
  });

  test("rejects a non-empty DB with neither migration nor session table", async () => {
    ensureSharedDbDir();
    createDb(sharedDbPath(), (db) => {
      db.exec("CREATE TABLE something_else (id TEXT)");
    });
    expect(await classifySharedOpencodeDb(sharedDbPath())).toBe("foreign");
  });

  test("reports a missing file as unreadable", async () => {
    expect(await classifySharedOpencodeDb(join(root, "does-not-exist.db"))).toBe("unreadable");
  });
});

describe("prepareManagedOpencodeEngineDb", () => {
  test("seeds the private DB from a compatible shared DB (sessions survive)", async () => {
    ensureSharedDbDir();
    createEngineStyleDb(sharedDbPath(), [`${PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP}_simplify_session_input`]);

    const result = await prepareManagedOpencodeEngineDb(testConfig());
    expect(result).not.toBeNull();
    expect(result?.path.endsWith(MANAGED_ENGINE_DB_FILENAME)).toBe(true);
    expect(result?.seededFrom).toBe(sharedDbPath());
    expect(existsSync(result!.path)).toBe(true);

    const copy = new Database(result!.path, { readonly: true });
    try {
      const row = copy.query("SELECT id FROM session").get() as { id?: string };
      expect(row?.id).toBe("ses_test");
    } finally {
      copy.close();
    }
  });

  test("does NOT adopt a foreign (newer) shared DB — engine starts fresh", async () => {
    ensureSharedDbDir();
    createEngineStyleDb(sharedDbPath(), ["20990101000000_from_the_future"]);

    const result = await prepareManagedOpencodeEngineDb(testConfig());
    expect(result).not.toBeNull();
    expect(result?.seededFrom).toBeNull();
    expect(result?.sharedDbCompatibility).toBe("foreign");
    // No copy was made; the engine will create the file itself.
    expect(existsSync(result!.path)).toBe(false);
  });

  test("returns the existing private DB without touching the shared one", async () => {
    const first = await prepareManagedOpencodeEngineDb(testConfig());
    expect(first).not.toBeNull();
    createDb(first!.path, (db) => db.exec("CREATE TABLE marker (id TEXT)"));

    // A foreign shared DB appearing later must not displace the private DB.
    ensureSharedDbDir();
    createEngineStyleDb(sharedDbPath(), ["20990101000000_from_the_future"]);

    const second = await prepareManagedOpencodeEngineDb(testConfig());
    expect(second?.path).toBe(first!.path);
    expect(second?.seededFrom).toBeNull();
    expect(second?.sharedDbCompatibility).toBeNull();
    const db = new Database(first!.path, { readonly: true });
    try {
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'marker'").get()).toBeTruthy();
    } finally {
      db.close();
    }
  });

  test("respects an explicit OPENCODE_DB override", async () => {
    process.env.OPENCODE_DB = join(root, "custom.db");
    expect(await prepareManagedOpencodeEngineDb(testConfig())).toBeNull();
  });

  test("stays out of the way in dev mode", async () => {
    process.env.LEGALWORK_DEV_MODE = "1";
    expect(await prepareManagedOpencodeEngineDb(testConfig())).toBeNull();
  });
});
