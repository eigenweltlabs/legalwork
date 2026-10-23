import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchAssistantSessions } from "./assistant-session-search.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

test("session search pages beyond recent history across 500 projects and excludes foreign, archived and synthetic content", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-search-")), prior = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = join(root, "engine.db");
  const db = new Database(process.env.OPENCODE_DB);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_archived INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT)");
  const workspaces: WorkspaceInfo[] = Array.from({ length: 500 }, (_, i) => ({ id: `p-${i}`, name: `Project ${i}`, path: join(root, `project-${i}`), preset: "starter", workspaceType: "local" }));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", workspaces, authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const session = (id: string, path: string, archived: number | null = null) => db.query("INSERT INTO session VALUES (?, ?, ?, ?)").run(id, id, path, archived);
  const part = (id: string, sessionId: string, time: number, data: unknown) => {
    db.query("INSERT INTO message VALUES (?, ?)").run(id, JSON.stringify({ role: "assistant" }));
    db.query("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(id, sessionId, id, time, JSON.stringify(data));
  };
  try {
    session("today", workspaces[0].path); session("old-day", workspaces[499].path, 0);
    session("foreign", join(root, "unregistered")); session("archived", workspaces[0].path, 1);
    for (let i = 0; i < 1100; i++) part(`noise-${i}`, "today", 100 + i, { type: "text", text: "Routine update" });
    part("old-match", "old-day", 1, { type: "text", text: "The Änderung ESCROW decision was approved last year." });
    for (const id of ["foreign", "archived"]) part(id, id, 2000, { type: "text", text: "Änderung escrow" });
    part("synthetic", "today", 2000, { type: "text", text: "Änderung escrow", synthetic: true });
    part("tool-result", "today", 2001, { type: "tool", state: { output: "Änderung escrow tool evidence" } });
    const signal = new AbortController().signal;
    const first = await searchAssistantSessions(config, workspaces, { query: "änderung escrow", limit: 20 }, signal);
    expect(first.items).toEqual([]); expect(first.scanned).toBe(1000); expect(first.nextCursor).toBeTruthy();
    const second = await searchAssistantSessions(config, workspaces, { query: "änderung escrow", limit: 20, cursor: first.nextCursor! }, signal);
    expect(second.items.map(item => [item.projectId, item.sessionId, item.messageId])).toEqual([["p-499", "old-day", "old-match"]]);
    expect(second.nextCursor).toBeNull();
    const tool = await searchAssistantSessions(config, workspaces, { query: "änderung escrow", limit: 1, includeToolOutputs: true }, signal);
    expect(tool.items[0].matchIn).toBe("tool-output"); expect(tool.nextCursor).toBeTruthy();
    await expect(searchAssistantSessions(config, [workspaces[0]], { query: "different", limit: 20, cursor: first.nextCursor! }, signal)).rejects.toThrow("same query and scope");
    const scoped = await searchAssistantSessions(config, [workspaces[0]], { query: "escrow", sessionId: "old-day", limit: 20 }, signal);
    expect(scoped.items).toEqual([]);
  } finally { db.close(); if (prior === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = prior; await rm(root, { recursive: true, force: true }); }
});
