import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAssistantInteraction } from "./assistant-onboarding.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

test("onboarding distinguishes actual use across past days from automatic, synthetic, or other-project messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-onboarding-"));
  const prior = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = join(root, "engine.sqlite");
  const db = new Database(process.env.OPENCODE_DB);
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT, time_archived INTEGER); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)");
  const workspace: WorkspaceInfo = { id: "assistant", name: "Assistant", path: join(root, "assistant"), preset: "main-assistant", workspaceType: "local" };
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "host", workspaces: [workspace], authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const add = (id: string, session: string, role: string, part: object) => {
    db.query("INSERT INTO message VALUES (?, ?, ?)").run(id, session, JSON.stringify({ role }));
    db.query("INSERT INTO part VALUES (?, ?, ?)").run(id, id, JSON.stringify(part));
  };
  try {
    db.query("INSERT INTO session VALUES (?, ?, ?, ?)").run("today", workspace.path, null, null);
    db.query("INSERT INTO session VALUES (?, ?, ?, ?)").run("archived-day", workspace.path, null, 10);
    db.query("INSERT INTO session VALUES (?, ?, ?, ?)").run("other-project", root, null, null);
    expect(await hasAssistantInteraction(config, workspace)).toBe(false);
    add("automated", "today", "user", { type: "text", text: "[Scheduled task: Morning briefing]\nCheck all projects" });
    add("return", "today", "user", { type: "text", text: "A delegated project chat has returned", synthetic: true });
    add("bot", "today", "assistant", { type: "text", text: "Your briefing is ready" });
    add("hidden", "today", "user", { type: "text", text: "Ignored", ignored: true });
    add("other", "other-project", "user", { type: "text", text: "Hello" });
    expect(await hasAssistantInteraction(config, workspace)).toBe(false);
    add("person", "archived-day", "user", { type: "text", text: "What is happening with Aster?" });
    expect(await hasAssistantInteraction(config, workspace)).toBe(true);
    db.query("DELETE FROM part WHERE id = ?").run("person");
    add("file", "today", "user", { type: "file", filename: "contract.pdf" });
    expect(await hasAssistantInteraction(config, workspace)).toBe(true);
  } finally {
    db.close();
    if (prior === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = prior;
    await rm(root, { recursive: true, force: true });
  }
});
