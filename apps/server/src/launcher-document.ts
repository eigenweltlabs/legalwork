import { createHash } from "node:crypto";
import { lstat, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { ApiError } from "./errors.js";
import { launcherDestination } from "./launcher-file-destination.js";

export function documentBytes(format: "md" | "txt" | "docx", text: string): Uint8Array {
  if (format !== "docx") return strToU8(text);
  const escape = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split(/\r?\n/).map(line => `<w:p><w:r><w:t xml:space="preserve">${escape(line)}</w:t></w:r></w:p>`).join("")}<w:sectPr/></w:body></w:document>`),
  }, { level: 0, mtime: new Date("1980-01-01T00:00:00Z") });
}

const pending = new Map<string, Promise<{ path: string }>>();
/** Exclusive creation with a durable operation receipt: retries cannot overwrite or duplicate files. */
export async function createLauncherDocument(root: string, input: { operationId: string; folder: string; name: string; format: "md" | "txt" | "docx"; text: string; templatePath?: string }, approve: (path: string) => Promise<void>): Promise<{ path: string }> {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.operationId) || !input.name.trim() || /[/\\\x00-\x1f]/.test(input.name) || /^\.+$/.test(input.name)) throw new ApiError(400, "document_name", "Choose a filename without path separators.");
  const folder = await launcherDestination(root, input.folder);
  const name = input.name.endsWith(`.${input.format}`) ? input.name : `${input.name}.${input.format}`;
  const path = [input.folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""), name].filter(Boolean).join("/");
  const destination = resolve(folder, name);
  let bytes = documentBytes(input.format, input.text);
  if (input.templatePath) {
    if (!input.templatePath.endsWith(`.${input.format}`) || input.templatePath.startsWith("/") || input.templatePath.includes("\\") || input.templatePath.split("/").some(part => !part || part === "." || part === "..")) throw new ApiError(400, "template_path", "Choose a template in this project with the selected format.");
    const parent = dirname(input.templatePath);
    const source = resolve(await launcherDestination(root, parent === "." ? "" : parent), input.templatePath.split("/").at(-1)!);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new ApiError(400, "template_file", "Choose a regular template file smaller than 16 MiB.");
    bytes = new Uint8Array(await readFile(source));
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const key = `${root}:${input.operationId}`;
  const active = pending.get(key);
  if (active) { await active; return createLauncherDocument(root, input, approve); }
  const execute = async () => {
    const journal = await launcherDestination(root, ".legalwork/launcher-documents", true);
    const receiptPath = resolve(journal, `${input.operationId}.json`);
    const receiptInfo = await lstat(receiptPath).catch(error => { if (error?.code === "ENOENT") return null; throw error; });
    if (receiptInfo?.isSymbolicLink()) throw new ApiError(409, "document_receipt", "Invalid save receipt.");
    const prior = await readFile(receiptPath, "utf8").then(text => JSON.parse(text)).catch(error => { if (error?.code === "ENOENT") return null; throw error; });
    if (prior && prior.fingerprint !== fingerprint) throw new ApiError(409, "document_operation", "This save belongs to a different document. Start a new save.");
    if (prior?.complete) {
      const info = await lstat(destination).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) throw new ApiError(409, "file_missing", "The saved file was moved or removed. Start a new save.");
      return { path };
    }
    if (!prior && await lstat(destination).catch(() => null)) throw new ApiError(409, "file_exists", "A file with this name already exists. Choose another name.");
    await approve(destination);
    await launcherDestination(root, input.folder, true);
    await launcherDestination(root, ".legalwork/launcher-documents");
    if (!prior) await writeFile(receiptPath, JSON.stringify({ fingerprint, path, complete: false }), { flag: "wx", mode: 0o600 });
    try { await writeFile(destination, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (!prior) throw new ApiError(409, "file_exists", "A file with this name already exists. Choose another name.");
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink() || !Buffer.from(await readFile(destination)).equals(Buffer.from(bytes))) throw new ApiError(409, "file_changed", "The destination changed. Your input is preserved; choose another name.");
    }
    const temporary = `${receiptPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ fingerprint, path, complete: true }), { flag: "wx", mode: 0o600 });
    await rename(temporary, receiptPath);
    return { path };
  };
  const result = execute().finally(() => pending.delete(key)); pending.set(key, result); return result;
}
