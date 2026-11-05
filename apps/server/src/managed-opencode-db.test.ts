import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  MANAGED_ENGINE_DB_FILENAME,
  LEGACY_MANAGED_ENGINE_DB_FILENAME,
  PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP,
  classifySharedOpencodeDb,
  inventoryLegacyHistory,
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

test("history inventory separates app metadata loss, native relocation and attachment navigation", async () => {
  const source = join(root, "inventory.db");
  createDb(source, db => {
    db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT)");
    const message = db.prepare("INSERT INTO message VALUES (?, 'ses_inventory', ?)");
    message.run("msg_user", JSON.stringify({ role: "user", time: { created: 1 }, agent: "legalwork", model: { providerID: "fixture", modelID: "fixture" }, metadata: { legalworkScheduledTask: { taskId: "task" } } }));
    message.run("msg_assistant", JSON.stringify({ role: "assistant", time: { created: 2, completed: 3 }, parentID: "msg_user", agent: "legalwork", mode: "legalwork", providerID: "fixture", modelID: "fixture", path: { cwd: root, root }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, metadata: { diagnostic: "unconsumed" } }));
    const part = db.prepare("INSERT INTO part VALUES (?, 'ses_inventory', ?, ?)");
    part.run("prt_user", "msg_user", JSON.stringify({ type: "text", text: "Run", metadata: { legalworkScheduledTask: { taskId: "task" } } }));
    part.run("prt_assistant", "msg_assistant", JSON.stringify({ type: "text", text: "Done", metadata: { providerTrace: "retained-native" } }));
    part.run("prt_reasoning", "msg_assistant", JSON.stringify({ type: "reasoning", text: "Reasoning", time: { start: 2, end: 3 }, metadata: { providerTrace: "retained-native" } }));
    part.run("prt_tool", "msg_assistant", JSON.stringify({ type: "tool", tool: "read", callID: "call", metadata: { providerTrace: "retained-native" }, state: { status: "completed", input: {}, output: "Complete", title: "Read", time: { start: 2, end: 3 }, metadata: { legalworkViewPreview: { retained: true } }, attachments: [{ id: "prt_tool_file", sessionID: "ses_inventory", messageID: "msg_assistant", type: "file", mime: "application/pdf", url: "file:///retained/tool.pdf" }] } }));
    part.run("prt_inline", "msg_user", JSON.stringify({ type: "file", mime: "text/plain", url: "data:text/plain;base64,QQ==", source: { type: "file", path: "/original/inline.txt", text: { value: "inline.txt", start: 0, end: 10 } } }));
    part.run("prt_uri", "msg_user", JSON.stringify({ type: "file", mime: "application/pdf", url: "file:///original/input.pdf" }));
    part.run("prt_resource", "msg_user", JSON.stringify({ type: "file", mime: "text/plain", url: "data:text/plain;base64,QQ==", source: { type: "resource", clientName: "fixture", uri: "https://example.com/preserved", text: { value: "resource", start: 0, end: 8 } } }));
  });
  const before = readFileSync(source);
  const report = await inventoryLegacyHistory(source, join(root, "candidate.db"));
  expect(readFileSync(source)).toEqual(before);
  expect(report.issues.filter(issue => issue.reason.startsWith("invalid"))).toEqual([]);
  expect(report.issues.filter(issue => issue.reason === "assistant-part-metadata-relocated-to-native").map(issue => issue.partID)).toEqual(["prt_assistant", "prt_reasoning", "prt_tool"]);
  expect(report.issues.filter(issue => issue.reason.includes("app-metadata-not-imported")).map(issue => issue.partID ?? issue.messageID)).toEqual(["prt_user", "msg_user"]);
  expect(report.issues.filter(issue => issue.reason === "assistant-message-unconsumed-metadata-not-imported")).toHaveLength(1);
  expect(report.issues.filter(issue => issue.reason === "non-inline-attachment").map(issue => issue.uri)).toEqual(["file:///original/input.pdf"]);
  expect(report.issues.filter(issue => issue.reason === "file-source-navigation-not-imported").map(issue => issue.uri)).toEqual(["/original/inline.txt"]);
  expect(report.issues.some(issue => issue.uri === "file:///retained/tool.pdf" || issue.partID === "prt_resource")).toBe(false);
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
    ensureSharedDbDir();
    createEngineStyleDb(sharedDbPath(), []);
    const first = await prepareManagedOpencodeEngineDb(testConfig());
    expect(first).not.toBeNull();
    createDb(first!.path, (db) => db.exec("CREATE TABLE marker (id TEXT)"));

    // A foreign shared DB appearing later must not displace the private DB.
    ensureSharedDbDir();
    rmSync(sharedDbPath());
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

  test("copies managed v1 history into a separate file and inventories every unavailable attachment", async () => {
    const directory = join(root, "config");
    mkdirSync(directory, { recursive: true });
    const source = join(directory, LEGACY_MANAGED_ENGINE_DB_FILENAME);
    createEngineStyleDb(source, ["20260622202450_simplify_session_input"]);
    const db = new Database(source);
    db.exec("CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT)");
    const insert = db.query("INSERT INTO part VALUES (?, ?, ?, ?)");
    for (let index = 0; index < 135; index++) insert.run(`prt_${index}`, "ses_test", "msg_test", JSON.stringify({ type: "file", url: `file:///original/${index}.pdf` }));
    insert.run("prt_bad", "ses_test", "msg_test", "invalid-json");
    db.close();
    const before = readFileSync(source);
    const result = await prepareManagedOpencodeEngineDb(testConfig());
    expect(result?.seededFrom).toBe(source);
    expect(result?.path).not.toBe(source);
    expect(readFileSync(source)).toEqual(before);
    if (!result?.migrationReport) throw new Error("A private migration report is required");
    const report = JSON.parse(readFileSync(result.migrationReport, "utf8"));
    expect(report.issues.filter((issue: { reason: string }) => issue.reason === "non-inline-attachment")).toHaveLength(135);
    expect(report.issues.filter((issue: { reason: string }) => issue.reason === "invalid-part")).toHaveLength(135);
    expect(report.issues.some((issue: { reason: string }) => issue.reason === "invalid-part-json")).toBe(true);
    expect(report.counts.part).toBe(136);
  });

  test("respects an explicit OPENCODE_DB override", async () => {
    process.env.OPENCODE_DB = join(root, "custom.db");
    expect(await prepareManagedOpencodeEngineDb(testConfig())).toBeNull();
  });

  test("managed development uses a private DB without importing standalone history", async () => {
    process.env.LEGALWORK_DEV_MODE = "1";
    ensureSharedDbDir();
    createEngineStyleDb(sharedDbPath(), [`${PINNED_ENGINE_NEWEST_MIGRATION_TIMESTAMP}_fixture`]);
    const original = readFileSync(sharedDbPath());
    const result = await prepareManagedOpencodeEngineDb(testConfig());
    expect(result?.path).toBe(join(root, "config", MANAGED_ENGINE_DB_FILENAME));
    expect(result?.seededFrom).toBeNull();
    expect(result?.sharedDbCompatibility).toBeNull();
    if (!result) throw new Error("A private managed development DB is required");
    expect(existsSync(result.path)).toBe(false);
    expect(readFileSync(sharedDbPath())).toEqual(original);
  });
});
