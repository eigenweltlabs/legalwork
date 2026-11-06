import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import pluginDefinition from "./opencode-plugins/legalwork-task-tools.js";
import { nativePluginTools } from "./opencode-plugins/native-plugin-test-support.js";

test("native task tools create, download, replace and remove attachments through the real server", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-task-attachments-"));
  const directory = join(root, "project");
  await mkdir(directory);
  const previous = {
    LEGALWORK_SERVER_URL: process.env.LEGALWORK_SERVER_URL,
    LEGALWORK_SERVER_TOKEN: process.env.LEGALWORK_SERVER_TOKEN,
    LEGALWORK_RUNTIME_DB: process.env.LEGALWORK_RUNTIME_DB,
  };
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "attachment-client", hostToken: "attachment-host",
    configPath: join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"], workspaces: [{ id: "attachment-project", name: "Attachment project", path: directory, preset: "default", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
    autoDownloadOcr: false,
  };
  const server = await startServer(config);
  process.env.LEGALWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.LEGALWORK_SERVER_TOKEN = config.token;
  const plugin = await nativePluginTools(pluginDefinition, { directory });
  const resultSchema = z.object({ ok: z.literal(true), task: z.object({ id: z.string() }).passthrough() });
  const detailSchema = z.object({ task: z.object({ attachments: z.array(z.object({ id: z.string(), filename: z.string() })) }) });
  const details = async (taskId: string) => {
    const response = await fetch(`${process.env.LEGALWORK_SERVER_URL}/workspace/attachment-project/tasks/${encodeURIComponent(taskId)}`, { headers: { Authorization: `Bearer ${config.token}` } });
    expect(response.status).toBe(200);
    return detailSchema.parse(await response.json()).task;
  };
  try {
    const created = resultSchema.parse(JSON.parse(await plugin.tool.legalwork_task_create.execute({ title: "Review agreement" })));
    const taskId = created.task.id;
    const source = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0, 0xff]);
    await writeFile(join(directory, "agreement.pdf"), source);
    await writeFile(join(directory, "notes.txt"), "Keep this attachment.");
    resultSchema.parse(JSON.parse(await plugin.tool.legalwork_task_attach.execute({ taskId, paths: ["agreement.pdf", "notes.txt"] })));
    const original = (await details(taskId)).attachments.find(file => file.filename === "agreement.pdf");
    if (!original) throw new Error("The source was not attached.");

    expect(JSON.parse(await plugin.tool.legalwork_task_download_attachment.execute({ taskId, attachmentId: original.id, path: "sources/agreement.pdf" }))).toMatchObject({ ok: true, local_path: "sources/agreement.pdf", bytes: source.byteLength });
    expect(new Uint8Array(await readFile(join(directory, "sources/agreement.pdf")))).toEqual(source);

    await writeFile(join(directory, "revised.pdf"), "Edited agreement");
    const replaced = z.object({ ok: z.literal(true), replacementAttachmentId: z.string() }).parse(JSON.parse(await plugin.tool.legalwork_task_attach.execute({ taskId, replaceAttachmentId: original.id, paths: ["revised.pdf"] })));
    expect((await details(taskId)).attachments.map(file => file.filename).sort()).toEqual(["notes.txt", "revised.pdf"]);
    expect(JSON.parse(await plugin.tool.legalwork_task_download_attachment.execute({ taskId, attachmentId: replaced.replacementAttachmentId, path: "sources/revised.pdf" }))).toMatchObject({ ok: true });
    expect(await readFile(join(directory, "sources/revised.pdf"), "utf8")).toBe("Edited agreement");

    resultSchema.parse(JSON.parse(await plugin.tool.legalwork_task_delete_attachment.execute({ taskId, attachmentId: replaced.replacementAttachmentId })));
    expect((await details(taskId)).attachments.map(file => file.filename)).toEqual(["notes.txt"]);
    expect(await readFile(join(directory, "sources/revised.pdf"), "utf8")).toBe("Edited agreement");
    expect(JSON.parse(await plugin.tool.legalwork_task_download_attachment.execute({ taskId, attachmentId: original.id, path: "removed.pdf" }))).toMatchObject({ ok: false, error: "That attachment does not exist." });
  } finally {
    await plugin.close();
    await server.stop();
    await rm(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 30_000);
