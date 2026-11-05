import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode, type SessionMessageInfo } from "@opencode/client";
import {
  searchSessionContents,
  localSessionDatabasePath,
} from "./content-search.js";
import { readSessionInbox } from "./session-inbox.js";
import { openSqliteReadonly } from "./managed-opencode-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)(
  "released native imports are searchable and update inbox without exposing hidden context or other projects",
  async () => {
    if (!binary) throw new Error("A released binary is required");
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "legalwork-native-search-")),
    );
    const workspacePath = join(root, "workspace");
    for (const name of [
      "workspace",
      "other",
      "home",
      "config",
      "data",
      "state",
      "cache",
      "tmp",
    ])
      await mkdir(join(root, name));
    const dbPath = join(root, "data", "engine.db");
    const password = randomBytes(32).toString("hex");
    let output = "";
    const child = spawn(
      binary,
      ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: workspacePath,
        env: {
          PATH: process.env.PATH,
          HOME: join(root, "home"),
          USERPROFILE: join(root, "home"),
          TMPDIR: join(root, "tmp"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_CACHE_HOME: join(root, "cache"),
          OPENCODE_CONFIG_DIR: join(root, "config"),
          OPENCODE_DB: dbPath,
          OPENCODE_PASSWORD: password,
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_CLAUDE_CODE: "1",
          OPENCODE_CONFIG_PROJECT_DISABLE: "1",
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    const oldDb = process.env.OPENCODE_DB;
    process.env.OPENCODE_DB = dbPath;
    try {
      const deadline = Date.now() + 30000;
      let base: string | undefined;
      while (Date.now() < deadline) {
        base = /^server listening on (https?:\/\/[^\s]+)/m.exec(output)?.[1];
        if (base) break;
        if (child.exitCode !== null)
          throw new Error("Native engine startup failed");
        await Bun.sleep(30);
      }
      if (!base) throw new Error("Native engine startup watchdog expired");
      const client = OpenCode.make({
        baseUrl: base,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        },
      });
      const seed = await client.session.create({
        location: { directory: workspacePath },
        title: "Native seed",
      });
      const hidden = "PRIVATE-CONTEXT";
      const full = "Opening ".repeat(30000) + "ARCHIVAL-TAIL";
      const messages: SessionMessageInfo[] = [
        {
          id: "msg_search_user",
          type: "user",
          time: { created: 100 },
          text: `Visible question\n${hidden}`,
          metadata: {
            legalworkPrompt: {
              visibleText: "Visible question",
              reminders: [hidden],
            },
          },
        },
        {
          id: "msg_search_synthetic",
          type: "synthetic",
          time: { created: 101 },
          text: hidden,
          metadata: { legalworkSystemReminder: true },
        },
        {
          id: "msg_search_assistant",
          type: "assistant",
          time: { created: 102, completed: 103 },
          agent: "legalwork",
          model: { providerID: "fixture", id: "fixture" },
          content: [
            { type: "text", text: full },
            {
              type: "reasoning",
              text: hidden,
              time: { created: 102, completed: 103 },
            },
            {
              type: "tool",
              id: "call_search",
              name: "read",
              time: { created: 102, ran: 102, completed: 103 },
              state: {
                status: "completed",
                input: { secret: hidden },
                content: [{ type: "text", text: hidden }],
                metadata: {},
              },
            },
          ],
        },
        {
          id: "msg_search_compaction",
          type: "compaction",
          status: "completed",
          reason: "manual",
          time: { created: 999 },
          summary: hidden,
        },
      ];
      messages.unshift({
        id: "msg_search_historical",
        type: "user",
        time: { created: 1 },
        text: "HISTORICAL-PASSAGE",
      });
      messages.push(
        ...Array.from(
          { length: 250 },
          (_, index): SessionMessageInfo => ({
            id: `msg_search_padding_${index}`,
            type: "user",
            time: { created: 104 + index },
            text: `Later unrelated message ${index}`,
          }),
        ),
      );
      const imported = await client.session.import({
        info: {
          ...seed,
          id: "ses_search_imported",
          title: "Public source",
          time: { created: 100, updated: 104 },
        },
        messages,
        location: { directory: workspacePath },
      });
      const foreign = await client.session.create({
        location: { directory: join(root, "other") },
        title: "ARCHIVAL-TAIL PRIVATE-CONTEXT",
      });
      const archived = await client.session.import({
        info: {
          ...seed,
          id: "ses_search_archived",
          title: "ARCHIVAL-TAIL",
          time: { created: 100, updated: 104, archived: 105 },
        },
        messages: [],
        location: { directory: workspacePath },
      });
      const workspace: WorkspaceInfo = {
        id: "fixture",
        name: "Fixture",
        path: workspacePath,
        preset: "starter",
        workspaceType: "local",
      };
      const config = { configPath: join(root, "server.json") } as ServerConfig;
      expect(localSessionDatabasePath(config)).toBe(dbPath);
      const db = await openSqliteReadonly(dbPath);
      try {
        expect(
          db
            .all("SELECT name FROM sqlite_master WHERE type='table'")
            .map((row) => row.name),
        ).toContain("session_v2");
        expect(
          db.all("PRAGMA table_info(session_message)").map((row) => row.name),
        ).toContain("seq");
      } finally {
        db.close();
      }
      const found = await searchSessionContents(
        config,
        workspace,
        "ARCHIVAL-TAIL",
        new AbortController().signal,
      );
      expect(found.items.map((item) => item.id)).toEqual([imported.id]);
      expect(found.items[0].messageId).toBe("msg_search_assistant");
      expect(
        (
          await searchSessionContents(
            config,
            workspace,
            hidden,
            new AbortController().signal,
          )
        ).items,
      ).toEqual([]);
      expect(
        (
          await searchSessionContents(
            config,
            workspace,
            "Visible question",
            new AbortController().signal,
          )
        ).items[0].messageId,
      ).toBe("msg_search_user");
      expect(
        (
          await searchSessionContents(
            config,
            workspace,
            "HISTORICAL-PASSAGE",
            new AbortController().signal,
          )
        ).items[0].messageId,
      ).toBe("msg_search_historical");
      const inbox = await readSessionInbox(
        config,
        [workspace],
        [foreign.id, archived.id].map((sessionId) => ({
          workspaceId: workspace.id,
          sessionId,
          updatedAt: Date.now(),
          assistantAt: 0,
        })),
      );
      expect(
        inbox.find((item) => item.sessionId === imported.id)?.assistantAt,
      ).toBe(103);
      expect(
        inbox.some(
          (item) =>
            item.sessionId === foreign.id || item.sessionId === archived.id,
        ),
      ).toBe(false);
    } finally {
      if (oldDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = oldDb;
      child.kill("SIGTERM");
      await Promise.race([exited, Bun.sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);

test("managed v2 DB selection works in dev and explicit OPENCODE_DB remains authoritative", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { MANAGED_ENGINE_DB_FILENAME } = await import(
    "./managed-opencode-db.js"
  );
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-db-path-"));
  const original = {
    db: process.env.OPENCODE_DB,
    dev: process.env.LEGALWORK_DEV_MODE,
    runtime: process.env.LEGALWORK_RUNTIME_DB,
  };
  try {
    delete process.env.OPENCODE_DB;
    process.env.LEGALWORK_DEV_MODE = "1";
    process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    const managed = join(root, MANAGED_ENGINE_DB_FILENAME);
    await writeFile(managed, "");
    const config = { configPath: join(root, "server.json") } as ServerConfig;
    expect(localSessionDatabasePath(config)).toBe(managed);
    process.env.OPENCODE_DB = join(root, "explicit-native.db");
    expect(localSessionDatabasePath(config)).toBe(process.env.OPENCODE_DB);
  } finally {
    for (const [key, value] of [
      ["OPENCODE_DB", original.db],
      ["LEGALWORK_DEV_MODE", original.dev],
      ["LEGALWORK_RUNTIME_DB", original.runtime],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
