import type { Result } from "@opencode/plugin/promise/tool";
import type { Content } from "@opencode/schema/tool";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
const PREVIEW_BYTES = 8 * 1024;
const shellOutput = z.object({ output: z.string(), exitCode: z.number().optional(), truncated: z.boolean(), sandbox: z.enum(["host", "virtual-machine"]) }).passthrough();

function segment(value: string) {
  return /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : createHash("sha256").update(value).digest("hex");
}

function format(text: string) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { text, extension: "txt" }; }
  const shell = shellOutput.safeParse(value);
  if (shell.success) {
    const { output, ...metadata } = shell.data;
    return { text: output, extension: "txt", shell: metadata };
  }
  if (typeof value === "object" && value !== null) return { text: JSON.stringify(value, null, 2), extension: "json" };
  return { text, extension: "txt" };
}

async function directory(root: string, chat: string) {
  let path = await realpath(root);
  for (const part of [".legalwork", "tool-output", segment(chat)]) {
    path = join(path, part);
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error?.code !== "EEXIST") throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Tool output storage must be an ordinary project directory.");
  }
  return path;
}

function preview(text: string) {
  const bytes = Buffer.from(text);
  let end = Math.min(bytes.length, PREVIEW_BYTES);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8").split("\n").slice(0, 200).join("\n");
}

export async function saveProjectToolOutput(root: string, sessionID: string, callID: string, result: Result): Promise<Result | undefined> {
  // Native file tools already bound their pages and supply continuation offsets.
  // Follow the engine's contract instead of shortening those pages a second time.
  if (result.metadata?.truncated !== undefined) return;
  const content: ReadonlyArray<Content> = typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content ?? [];
  const text = content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  if (Buffer.byteLength(text) <= MAX_BYTES && text.split("\n").length <= MAX_LINES) return;
  const output = format(text);
  const folder = await directory(root, sessionID);
  let path = join(folder, `${segment(callID)}.${output.extension}`);
  try { await writeFile(path, output.text, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    path = join(folder, `${segment(callID)}-${randomUUID()}.${output.extension}`);
    await writeFile(path, output.text, { flag: "wx", mode: 0o600 });
  }
  const metadata = output.shell ? `\nCommand metadata: ${JSON.stringify(output.shell)}` : "";
  const notice = `\n\n[Preview shortened; full output saved to ${path}\nUse read, grep, or shell to inspect relevant portions.]${metadata}`;
  return {
    ...result,
    content: [{ type: "text", text: preview(output.text) + notice }, ...content.flatMap(part => part.type === "file" ? [part] : [])],
    metadata: { ...result.metadata, ...output.shell, truncated: true, outputPath: path, outputBytes: Buffer.byteLength(output.text),
      ...(output.shell ? { sourceTruncated: output.shell.truncated } : {}) },
  };
}
