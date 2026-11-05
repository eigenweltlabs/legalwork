import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ApiError } from "../errors.js";
import { canonicalFilePath } from "../file-write-lock.js";
import { receiveFile } from "../file-storage/common.js";
import type { MailAttachment } from "./mail.js";

function attachmentFilename(value: string) {
  let name = (value.split(/[\\/]/).at(-1) ?? "").replace(/[<>:"|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/, "").trim();
  if (!name || /^\.+$/.test(name)) name = "attachment";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  const extension = extname(name);
  const suffix = Buffer.byteLength(extension) <= 20 ? extension : "";
  const stem = Array.from(name.slice(0, name.length - suffix.length));
  while (Buffer.byteLength(stem.join("") + suffix) > 240) stem.pop();
  return stem.join("") + suffix;
}

async function* responseBytes(response: Response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

// fields=data gives a single JSON string. Decode complete base64 groups as they
// arrive, retaining only the envelope and the final group between chunks.
async function* gmailAttachmentBytes(response: Response) {
  const invalid = () => new ApiError(502, "connector_api_invalid", "Gmail returned invalid attachment content.");
  let prefix = "", suffix = "", pending = "", started = false, ended = false;
  for await (const bytes of responseBytes(response)) {
    let text = Buffer.from(bytes).toString("latin1");
    if (!started) {
      prefix += text;
      const opening = /^\s*\{\s*"data"\s*:\s*"/.exec(prefix);
      if (!opening) { if (prefix.length > 1024) throw invalid(); continue; }
      text = prefix.slice(opening[0].length); prefix = ""; started = true;
    }
    if (ended) { suffix += text; if (suffix.length > 1024) throw invalid(); continue; }
    const closing = text.indexOf('"');
    pending += closing < 0 ? text : text.slice(0, closing);
    const completeLength = Math.max(0, Math.floor((pending.length - 4) / 4) * 4);
    const complete = pending.slice(0, completeLength);
    if (!/^[A-Za-z0-9_-]*$/.test(complete)) throw invalid();
    if (complete) yield Buffer.from(complete, "base64url");
    pending = pending.slice(completeLength);
    if (closing >= 0) {
      const tail = Buffer.from(pending, "base64url");
      if (!/^[A-Za-z0-9_-]*={0,2}$/.test(pending) || tail.toString("base64url") !== pending.replace(/=+$/, "") || (pending.includes("=") && pending.length % 4 !== 0)) throw invalid();
      if (tail.length) yield tail;
      ended = true; suffix = text.slice(closing + 1);
    }
  }
  if (!started || !ended || !/^\s*\}\s*$/.test(suffix)) throw invalid();
}

export async function downloadMailAttachment(root: string, provider: "gmail" | "outlook", load: () => Promise<MailAttachment>) {
  const base = await canonicalFilePath(resolve(root, ".legalwork", "attachments", "email"));
  const inside = relative(root, base);
  if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`)) throw new ApiError(403, "attachment_path_outside_workspace", "The attachment folder must remain inside this project.");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, `${provider}-`));
  let attachment: MailAttachment | undefined;
  try {
    const canonical = await realpath(directory);
    const child = relative(root, canonical);
    if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) throw new ApiError(403, "attachment_path_outside_workspace", "The attachment folder must remain inside this project.");
    attachment = await load();
    const filename = attachmentFilename(attachment.filename);
    const path = join(canonical, filename);
    const received = await receiveFile(attachment.encoding === "base64url-json" ? gmailAttachmentBytes(attachment.response) : responseBytes(attachment.response), path);
    if (attachment.expectedSize !== null && received.size !== attachment.expectedSize) throw new ApiError(502, "connector_attachment_incomplete", "The attachment download was incomplete. Try again.");
    return { path, relativePath: relative(root, path).split(sep).join("/"), filename, mimeType: attachment.mimeType, size: received.size };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { await attachment?.response.body?.cancel().catch(() => undefined); }
}
