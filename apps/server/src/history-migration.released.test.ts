import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { OpenCode } from "@opencode/client";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";
import {
  prepareManagedOpencodeEngineDb,
  LEGACY_MANAGED_ENGINE_DB_FILENAME,
} from "./managed-opencode-db.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";
import { listEngineMessages } from "./engine-client.js";
import { searchSessionContents } from "./content-search.js";
import { readSessionInbox } from "./session-inbox.js";
import { readLegacyHistoryBackup, hashHistoryFile } from "./history-v1-backup.js";
import { readSessionHistoryProvenance, readScopedSessionHistoryProvenance } from "./session-history-provenance.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const nativeBinary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
const legacyBinary = process.env.LEGALWORK_TEST_OPENCODE_V1_BIN;
const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

test.skipIf(!nativeBinary || !legacyBinary)(
  "actual released v1 history migrates through an immutable managed copy to native v2 without inference",
  async () => {
    if (!nativeBinary || !legacyBinary)
      throw new Error("Both released binaries are required");
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "legalwork-history-v1-v2-")),
    );
    for (const name of [
      "workspace",
      "home",
      "config",
      "state",
      "data",
      "cache",
      "tmp",
    ])
      await mkdir(join(root, name));
    const workspacePath = join(root, "workspace");
    const source = join(root, "state", LEGACY_MANAGED_ENGINE_DB_FILENAME);
    const password = randomBytes(32).toString("hex");
    const headers = {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      "content-type": "application/json",
    };
    const env = {
      PATH: process.env.PATH,
      HOME: join(root, "home"),
      USERPROFILE: join(root, "home"),
      TMPDIR: join(root, "tmp"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_CONFIG_DIR: join(root, "config"),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable" }),
    };
    let output = "";
    const child = spawn(
      resolve(legacyBinary),
      ["serve", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: workspacePath,
        env: {
          ...env,
          OPENCODE_DB: source,
          OPENCODE_SERVER_USERNAME: "opencode",
          OPENCODE_SERVER_PASSWORD: password,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    let native:
      | Awaited<ReturnType<typeof createManagedOpencodeServer>>
      | undefined;
    const savedEnv = new Map(
      [
        "OPENCODE_DB",
        "LEGALWORK_RUNTIME_DB",
        "LEGALWORK_DEV_MODE",
        "XDG_DATA_HOME",
      ].map((key) => [key, process.env[key]]),
    );
    try {
      const deadline = Date.now() + 30000;
      let base: string | undefined;
      while (Date.now() < deadline) {
        base = /(?:opencode )?server listening on (https?:\/\/[^\s]+)/.exec(
          output,
        )?.[1];
        if (base) break;
        if (child.exitCode !== null)
          throw new Error("Frozen v1 startup failed");
        await Bun.sleep(30);
      }
      if (!base) throw new Error("Frozen v1 startup watchdog expired");
      const query = new URLSearchParams({ directory: workspacePath });
      const health = await fetch(`${base}/global/health`, { headers }).then(
        (response) => response.json(),
      );
      expect(health.version).toBe("1.18.29");
      const created = await fetch(`${base}/session?${query}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title: "Migration fixture" }),
      });
      expect(created.ok).toBe(true);
      const session = await created.json();
      const sessionID = String(session.id);
      child.kill("SIGTERM");
      await exited;
      const visible = "VISIBLE-CONTRACT-QUESTION";
      const reminder =
        '<system-reminder topic="office-pane">PRIVATE-MODEL-CONTEXT</system-reminder>';
      const long = "Complete legal source ".repeat(12000) + "FULL-TOOL-TAIL";
      const inline =
        "data:text/plain;base64," +
        Buffer.from("PUBLIC-ATTACHMENT").toString("base64");
      const db = new Database(source);
      try {
        const message = db.prepare(
          "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
        );
        const part = db.prepare(
          "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
        );
        message.run(
          "msg_migration_user",
          sessionID,
          100,
          100,
          JSON.stringify({
            role: "user",
            time: { created: 100 },
            agent: "legalwork",
            model: { providerID: "fixture", modelID: "fixture" },
            metadata: { fixture: "user-metadata" },
          }),
        );
        message.run(
          "msg_migration_assistant",
          sessionID,
          200,
          300,
          JSON.stringify({
            role: "assistant",
            time: { created: 200, completed: 300 },
            parentID: "msg_migration_user",
            modelID: "fixture",
            providerID: "fixture",
            mode: "legalwork",
            agent: "legalwork",
            path: { cwd: workspacePath, root: workspacePath },
            finish: "stop",
            cost: 1.25,
            tokens: {
              input: 123,
              output: 45,
              reasoning: 6,
              cache: { read: 70, write: 8 },
            },
            metadata: { fixture: "assistant-metadata" },
          }),
        );
        const add = (
          id: string,
          messageID: string,
          created: number,
          data: unknown,
        ) =>
          part.run(
            id,
            messageID,
            sessionID,
            created,
            created,
            JSON.stringify(data),
          );
        add("prt_visible", "msg_migration_user", 100, {
          type: "text",
          text: visible,
          metadata: {
            legalworkScheduledTask: {
              taskId: "a2d90125-4cc4-44ea-9027-f430c4d82aab",
              workspaceId: "fixture",
              title: "Scheduled fixture",
            },
          },
        });
        add("prt_hidden", "msg_migration_user", 101, {
          type: "text",
          text: reminder,
          synthetic: true,
        });
        add("prt_ignored", "msg_migration_user", 102, {
          type: "text",
          text: "IGNORED-NOT-MODEL-CONTEXT",
          ignored: true,
        });
        add("prt_inline", "msg_migration_user", 103, {
          type: "file",
          mime: "text/plain",
          filename: "public.txt",
          url: inline,
        });
        add("prt_external", "msg_migration_user", 104, {
          type: "file",
          mime: "application/pdf",
          filename: "external.pdf",
          url: "file:///synthetic/unavailable.pdf",
        });
        add("prt_answer", "msg_migration_assistant", 200, {
          type: "text",
          text: "SUPPORTED-ANSWER",
        });
        add("prt_reasoning", "msg_migration_assistant", 201, {
          type: "reasoning",
          text: "PRIVATE-REASONING",
          time: { start: 201, end: 202 },
        });
        add("prt_tool", "msg_migration_assistant", 202, {
          type: "tool",
          callID: "call_migration",
          tool: "legalwork_word_read",
          state: {
            status: "completed",
            input: { document: "agreement.docx" },
            output: long,
            title: "Read agreement",
            metadata: {
              revision: 3,
              legalworkSystemReminders: {
                "office-pane": { document: "agreement.docx" },
              },
            },
            time: { start: 202, end: 250 },
            attachments: [
              {
                id: "prt_tool_file",
                sessionID,
                messageID: "msg_migration_assistant",
                type: "file",
                mime: "text/plain",
                filename: "tool.txt",
                url: inline,
              },
            ],
          },
        });
        part.run(
          "prt_malformed",
          "msg_migration_user",
          sessionID,
          105,
          105,
          "{broken-json",
        );
        message.run("msg_malformed", sessionID, 106, 106, "{broken-json");
        add("prt_running", "msg_migration_assistant", 203, {
          type: "tool",
          callID: "call_migration_running",
          tool: "read",
          state: {
            status: "running",
            input: { filePath: "agreement.docx" },
            title: "Pending read",
            metadata: {},
            time: { start: 203 },
          },
        });
        db.prepare("UPDATE session SET time_updated=? WHERE id=?").run(
          300,
          sessionID,
        );
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        db.close();
      }
      const original = digest(await readFile(source));
      delete process.env.OPENCODE_DB;
      delete process.env.LEGALWORK_DEV_MODE;
      process.env.LEGALWORK_RUNTIME_DB = join(root, "state", "runtime.sqlite");
      process.env.XDG_DATA_HOME = join(root, "data");
      const config = {
        configPath: join(root, "state", "server.json"),
      } as ServerConfig;
      const prepared = await prepareManagedOpencodeEngineDb(config);
      if (!prepared) throw new Error("No managed copy was prepared");
      expect(prepared.seededFrom).toBe(source);
      expect(digest(await readFile(source))).toBe(original);
      const report = JSON.parse(
        await readFile(prepared.migrationReport!, "utf8"),
      );
      expect(
        report.issues.some(
          (issue: { reason: string }) =>
            issue.reason === "non-inline-attachment",
        ),
      ).toBe(true);
      expect(
        report.issues.some(
          (issue: { reason: string }) => issue.reason === "invalid-part-json",
        ),
      ).toBe(true);
      expect(
        report.issues.some(
          (issue: { reason: string }) =>
            issue.reason === "invalid-message-json",
        ),
      ).toBe(true);
      expect(
        report.issues.some(
          (issue: { reason: string }) => issue.reason === "interrupted-tool",
        ),
      ).toBe(true);
      expect(
        report.issues.filter(
          (issue: { reason: string; partID?: string; messageID?: string }) =>
            issue.reason.startsWith("invalid") &&
            (issue.partID === "prt_tool" ||
              issue.partID === "prt_visible" ||
              issue.messageID === "msg_migration_assistant" ||
              issue.messageID === "msg_migration_user") &&
            issue.partID !== "prt_malformed",
        ).length,
      ).toBe(0);
      native = await createManagedOpencodeServer({
        bin: resolve(nativeBinary),
        cwd: workspacePath,
        env: { ...env, OPENCODE_DB: prepared.path },
        timeoutMs: 30000,
        signal: AbortSignal.timeout(30000),
      });
      const client = OpenCode.make({
        baseUrl: native.url,
        headers: {
          authorization: `Basic ${Buffer.from(`${native.username}:${native.password}`).toString("base64")}`,
        },
      });
      expect((await client.server.info()).version).toBe(await expectedOpencodeVersion(nativeBinary));
      expect((await client.migration.v1.status()).status).toBe("completed");
      const messages = await listEngineMessages(client, sessionID);
      const user = messages.find((message) => message.type === "user");
      const assistant = messages.find(
        (message) => message.type === "assistant",
      );
      if (user?.type !== "user" || assistant?.type !== "assistant")
        throw new Error(
          "Native migration omitted the saved user/assistant history",
        );
      const context = await client.session.context({ sessionID });
      const reminderMessage = messages.find(
        (message) => message.type === "synthetic" && message.text === reminder,
      );
      expect(reminderMessage?.type).toBe("synthetic");
      expect(
        reminderMessage?.metadata?.legalworkSystemReminder,
      ).toBeUndefined();
      expect(user.metadata?.legalworkScheduledTask).toBeUndefined(); // Explicit upstream metadata limitation.
      // Full native evidence stays asserted; no snapshots of implementation details.
      expect(user.text.includes(visible)).toBe(true);
      expect(JSON.stringify(context).includes("PRIVATE-MODEL-CONTEXT")).toBe(
        true,
      );
      expect(user.text.includes("IGNORED-NOT-MODEL-CONTEXT")).toBe(false);
      expect(assistant.tokens).toEqual({
        input: 123,
        output: 45,
        reasoning: 6,
        cache: { read: 70, write: 8 },
      });
      expect(assistant.cost).toBe(1.25);
      const tool = assistant.content.find(
        (content) =>
          content.type === "tool" && content.name === "legalwork_word_read",
      );
      if (tool?.type !== "tool" || tool.state.status !== "completed")
        throw new Error("Completed tool did not survive migration");
      expect(
        tool.state.content.some(
          (content) => content.type === "text" && content.text === long,
        ),
      ).toBe(true);
      expect(tool.state.metadata?.revision).toBe(3);
      const interrupted = assistant.content.find(
        (content) =>
          content.type === "tool" && content.id === "call_migration_running",
      );
      expect(
        interrupted?.type === "tool" && interrupted.state.status === "error",
      ).toBe(true);
      expect(user.files?.length).toBe(1);
      expect(user.text.includes("external.pdf")).toBe(true);
      expect(
        tool.state.content.some((content) => content.type === "file"),
      ).toBe(true);
      expect(await client.session.active()).toEqual({});
      expect(await client.session.inbox.list({ sessionID })).toEqual([]);
      process.env.OPENCODE_DB = prepared.path;
      const workspace: WorkspaceInfo = {
        id: "fixture",
        name: "Fixture",
        path: workspacePath,
        preset: "starter",
        workspaceType: "local",
      };
      const backup=await readLegacyHistoryBackup(config);
      if(!backup)throw new Error("The immutable original history backup is missing");
      expect(backup.path).not.toBe(prepared.path);
      expect(await hashHistoryFile(backup.path)).toBe(backup.sha256);
      const provenance=await readSessionHistoryProvenance(config,workspace,await client.session.get({sessionID}),messages);
      expect(provenance.status).toBe("available");
      expect(provenance.messages[user.id]?.scheduledTask?.taskId).toBe("a2d90125-4cc4-44ea-9027-f430c4d82aab");
      expect(provenance.messages[user.id]?.attachments).toHaveLength(2);
      expect(provenance.messages[user.id]?.attachments.find(file=>file.bytes==="reference-only")?.reference).toBe("file:///synthetic/unavailable.pdf");
      expect(user.metadata?.legalworkScheduledTask).toBeUndefined(); // Provenance never rewrites native model history.
      const descendant=await client.session.create({parentID:sessionID,location:{directory:workspacePath},title:"Child fixture"});
      expect((await readScopedSessionHistoryProvenance(config,workspace,client,descendant.id,sessionID)).provenance.messages[user.id]?.attachments).toHaveLength(2);
      expect((await readScopedSessionHistoryProvenance(config,workspace,client,sessionID,sessionID)).sessionID).toBe(sessionID);
      const sibling=await client.session.create({location:{directory:workspacePath},title:"Sibling fixture"});
      await expect(readScopedSessionHistoryProvenance(config,workspace,client,sibling.id,sessionID)).rejects.toMatchObject({status:404});
      const review=await client.session.create({parentID:sessionID,location:{directory:workspacePath},metadata:{legalworkReviewWorker:true}});
      await expect(readScopedSessionHistoryProvenance(config,workspace,client,review.id,sessionID)).rejects.toMatchObject({status:403});
      await expect(readScopedSessionHistoryProvenance(config,{...workspace,directory:join(root,"home")},client,descendant.id,sessionID)).rejects.toMatchObject({status:404});
      expect(
        (
          await searchSessionContents(
            config,
            workspace,
            "SUPPORTED-ANSWER",
            new AbortController().signal,
          )
        ).items[0]?.id,
      ).toBe(sessionID);
      expect(
        (
          await searchSessionContents(
            config,
            workspace,
            "PRIVATE-MODEL-CONTEXT",
            new AbortController().signal,
          )
        ).items,
      ).toEqual([]);
      expect(
        (await readSessionInbox(config, [workspace], []))[0]?.assistantAt,
      ).toBe(300);
      expect(digest(await readFile(source))).toBe(original);
    } finally {
      if (native) await native.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exited, Bun.sleep(3000)]);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await exited;
        }
      }
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
