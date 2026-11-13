import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "./types.js";
import { ensureLegacyHistoryBackup, legacyHistoryBackupDirectory } from "./history-v1-backup.js";
import { readCurrentHistory, updateCurrentHistoryReceipt } from "./current-history-state.js";
import { assertSessionHistoryRecoveryReady } from "./session-history-undo.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-current-history-"));
  const config = { configPath: join(root, "server.json"), managedEngineStorageDirectory: root } as ServerConfig;
  const source = join(root, "original.db"), db = new Database(source);
  db.exec("CREATE TABLE session(id TEXT,directory TEXT,time_created INTEGER,parent_id TEXT,permission TEXT,revert TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT)");
  db.prepare("INSERT INTO session VALUES(?,?,?,?,?,?)").run("ses_chat", root, 1, null, JSON.stringify([{ permission: "bash", pattern: "*", action: "deny" }]), JSON.stringify({ messageID: "msg_original" }));
  db.prepare("INSERT INTO message VALUES(?,?,?,?)").run("msg_original", "ses_chat", 2, JSON.stringify({ role: "user", time: { created: 2 }, agent: "legalwork", model: { providerID: "fixture", modelID: "fixture" } }));
  db.prepare("INSERT INTO part VALUES(?,?,?,?)").run("prt_file", "msg_original", "ses_chat", JSON.stringify({ type: "file", mime: "text/plain", filename: "original.txt", url: "data:text/plain;base64,T1JJR0lOQUw=", source: { type: "file", path: "/fixture/original.txt", text: { value: "original", start: 0, end: 8 } } }));
  db.close();
  const backup = await ensureLegacyHistoryBackup(config, source, async destination => { const db = new Database(source, { readonly: true }); try { db.run("VACUUM INTO ?", [destination]); } finally { db.close(); } });
  return { root, config, backup, close: () => rm(root, { recursive: true, force: true }) };
}

test("one-time typed history import preserves native rules, byte identity and receipts after the archive moves", async () => {
  const run = await fixture();
  try {
    const state = await readCurrentHistory(run.config);
    expect(state?.sessions.ses_chat.policy).toMatchObject({ status: "available", source: { rules: [{ action: "shell", resource: "*", effect: "deny" }] } });
    expect(state?.sessions.ses_chat.messages.msg_original.attachments[0]).toMatchObject({ name: "original.txt", sourcePath: "/fixture/original.txt", inlineHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(assertSessionHistoryRecoveryReady(run.config, ["ses_chat"])).rejects.toMatchObject({ code: "history_undo_recovery_resolution_required" });
    await updateCurrentHistoryReceipt(run.config, "undo", "ses_chat", { version: 1, sourceSha256: run.backup.sha256, sessionID: "ses_chat", restoredAt: 10 });
    await rename(legacyHistoryBackupDirectory(run.config), join(run.root, "recovery-archive"));
    await rm(join(run.root, "original.db"));
    expect((await readCurrentHistory(run.config))?.undoReceipts.ses_chat.restoredAt).toBe(10);
    expect((await readCurrentHistory(run.config))?.sessions.ses_chat).toEqual(state?.sessions.ses_chat);
    await expect(assertSessionHistoryRecoveryReady(run.config, ["ses_chat"])).resolves.toBeUndefined();
    await expect(updateCurrentHistoryReceipt(run.config, "undo", "ses_chat", { version: 1, sourceSha256: "another-source", sessionID: "ses_chat", restoredAt: 20 })).rejects.toMatchObject({ code: "history_state_recovery_required" });
  } finally { await run.close(); }
});

test("missing or damaged current state blocks instead of resetting old Undo and permission state", async () => {
  const run = await fixture();
  try {
    await readCurrentHistory(run.config);
    const path = join(run.root, "history-current.json"), original = await readFile(path, "utf8");
    await rm(path);
    await expect(readCurrentHistory(run.config)).rejects.toMatchObject({ code: "history_state_recovery_required" });
    await expect(assertSessionHistoryRecoveryReady(run.config, ["ses_chat"])).rejects.toMatchObject({ code: "history_undo_recovery_resolution_required" });
    const changed = JSON.parse(original); delete changed.state.sessions.ses_chat;
    await writeFile(path, JSON.stringify(changed));
    await expect(readCurrentHistory(run.config)).rejects.toMatchObject({ code: "history_state_recovery_required" });
    await writeFile(path, original); await expect(readCurrentHistory(run.config)).resolves.not.toBeNull();
    await rm(path); await rm(join(run.root, "history-import-state.json"));
    await expect(readCurrentHistory(run.config)).rejects.toMatchObject({ code: "history_state_recovery_required" });
  } finally { await run.close(); }
});

test("fresh profiles and a lost expected original are distinguished", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-fresh-history-"));
  const config = { configPath: join(root, "server.json"), managedEngineStorageDirectory: root } as ServerConfig;
  try {
    expect(await readCurrentHistory(config)).toBeNull();
    await writeFile(join(root, "opencode-v2-history-migration.json"), JSON.stringify({ source: "expected-original.db" }));
    await expect(readCurrentHistory(config)).rejects.toMatchObject({ code: "history_state_recovery_required" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
