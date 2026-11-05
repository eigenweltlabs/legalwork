import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile, rm } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import type { WikiSuggestion, WikiSuggestionInput, WikiSuggestionAttachment } from "@legalwork/types/wiki-suggestions";
import { WikiSuggestionSchema, wikiSuggestionFile, wikiSuggestionContent } from "./suggestion-schema.js";
import { ApiError } from "../errors.js";
import { WIKI_MAX_ASSET_BYTES, wikiPath } from "./store.js";

const Metadata = WikiSuggestionSchema.omit({ content: true, revision: true, filePath: true });
const locks = new Map<string, Promise<unknown>>();
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
const sourceExtensions = /\.(?:pdf|docx?|odt|rtf|txt|csv|xlsx?|pptx?|png|jpe?g|webp|gif|tiff?)$/i;
const attachmentFile = (file: Pick<WikiSuggestionAttachment, "sha256" | "name">) => `${file.sha256}-${file.name}`;

async function boundedFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new ApiError(400, "invalid_suggestion_attachment", "Choose a regular source file.");
    if (stat.size > WIKI_MAX_ASSET_BYTES) throw new ApiError(413, "suggestion_attachments_too_large", "Source files can total up to 100 MB per draft.");
    const bytes = await file.readFile();
    if (bytes.length > WIKI_MAX_ASSET_BYTES) throw new ApiError(413, "suggestion_attachments_too_large", "Source files can total up to 100 MB per draft.");
    return bytes;
  } finally { await file.close(); }
}

/** Drafts belong to the originating project. Nothing here writes a wiki. */
export class WikiSuggestions {
  constructor(private root: string, private workspaceId: string) {}

  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const key = `${await realpath(this.root)}:${id}`;
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    locks.set(key, next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }

  private async path(parts: string[], create = false) {
    let path = await realpath(this.root);
    for (const [index, part] of [".legalwork", "tmp", "wiki-suggestions", ...parts].entries()) {
      path = join(path, part);
      const last = index === parts.length + 2;
      if (create && !last) await mkdir(path).catch(error => { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; });
      const stat = await lstat(path).catch(error => { if (missing(error) && (create || last)) return null; throw error; });
      if (stat?.isSymbolicLink() || (stat && !last && !stat.isDirectory())) throw new ApiError(400, "invalid_suggestion_path", "The suggestion folder must be inside this project, without symbolic links.");
    }
    return path;
  }
  private id(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, "invalid_suggestion", "Choose a wiki suggestion.");
    return id;
  }
  private async put(id: string, file: string, content: string | Buffer) {
    if (Buffer.byteLength(content) > (typeof content !== "string" ? WIKI_MAX_ASSET_BYTES : file === "draft.md" ? 2_000_000 : 128_000)) throw new ApiError(413, "suggestion_too_large", "This draft is too large.");
    const path = await this.path([this.id(id), ...file.split("/")], true);
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await this.path([id, ...file.split("/")]);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  private async source(path: string) {
    // Downloads in the project's temporary folder are supported, but hidden
    // configuration, absolute paths and symlinked project escapes are not.
    wikiPath(path.startsWith(".legalwork/tmp/") ? path.slice(".legalwork/tmp/".length) : path);
    let current = await realpath(this.root);
    for (const part of path.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new ApiError(400, "invalid_suggestion_attachment", "Source files must be inside this project, without symbolic links.");
    }
    return boundedFile(current);
  }
  private async stageAttachments(id: string, input: WikiSuggestionInput["attachments"], previous: WikiSuggestionAttachment[] = []) {
    if (input === undefined) return previous;
    const result: WikiSuggestionAttachment[] = [];
    const names = new Set<string>();
    let total = 0;
    for (const item of input) {
      const name = item.name ?? item.sourcePath.split("/").at(-1)!;
      wikiPath(name);
      if (name.includes("/") || name.length > 180 || !sourceExtensions.test(name) || extname(name).toLowerCase() !== extname(item.sourcePath).toLowerCase())
        throw new ApiError(400, "invalid_suggestion_attachment", "Use a document or image filename with its original extension (up to 180 characters).");
      if (names.has(name.normalize("NFC").toLowerCase())) throw new ApiError(400, "duplicate_suggestion_attachment", "Give each source file a different filename.");
      names.add(name.normalize("NFC").toLowerCase());
      const retained = previous.find(file => file.sourcePath === item.sourcePath && file.name === name);
      const bytes = retained ? null : await this.source(item.sourcePath);
      const size = retained ? retained.size : bytes!.length;
      total += size;
      if (total > WIKI_MAX_ASSET_BYTES) throw new ApiError(413, "suggestion_attachments_too_large", "Source files can total up to 100 MB per draft.");
      if (retained) { result.push(retained); continue; }
      const sha256 = hash(bytes!);
      const file = `attachments/${attachmentFile({ sha256, name })}`;
      await this.put(id, file, bytes!);
      // Keep draft links distinct from already-published sources of the same
      // name. Publication resolves these into the wiki's flat Sources folder.
      result.push({ sourcePath: item.sourcePath, name, size, sha256, path: `Sources/${id}/${name}`, filePath: `${dirname(wikiSuggestionFile(id))}/${file}` });
    }
    return result;
  }
  /** Verify the immutable snapshot, never re-read the original download at Save. */
  async attachment(draft: WikiSuggestion, index: number) {
    const file = draft.attachments[index];
    if (!file) throw new ApiError(404, "suggestion_attachment_missing", "This source file is no longer in the draft.");
    wikiPath(file.name);
    if (file.name.includes("/") || !sourceExtensions.test(file.name) || (draft.status !== "saved" && file.path !== `Sources/${file.name}` && file.path !== `Sources/${draft.id}/${file.name}`))
      throw new ApiError(400, "invalid_suggestion_attachment", "This source file has an invalid destination.");
    const bytes = await boundedFile(await this.path([this.id(draft.id), "attachments", attachmentFile(file)]));
    if (bytes.length !== file.size || hash(bytes) !== file.sha256)
      throw new ApiError(409, "suggestion_attachment_changed", "A staged source file changed. Remove it from the draft and attach it again before saving.");
    return { path: file.path, data: bytes };
  }
  async read(id: string): Promise<WikiSuggestion> {
    try {
      const metadataPath = await this.path([this.id(id), "suggestion.json"]);
      if ((await lstat(metadataPath)).size > 128_000) throw new ApiError(413, "suggestion_too_large", "This draft is too large.");
      const meta = Metadata.parse(JSON.parse(await readFile(metadataPath, "utf8")));
      if (meta.attachments.reduce((total, file) => total + file.size, 0) > WIKI_MAX_ASSET_BYTES) throw new ApiError(413, "suggestion_attachments_too_large", "Source files can total up to 100 MB per draft.");
      const path = await this.path([id, "draft.md"]);
      if ((await lstat(path)).size > 2_000_000) throw new ApiError(413, "suggestion_too_large", "This draft is too large.");
      const content = await readFile(path, "utf8");
      return { ...meta, id, workspaceId: this.workspaceId, content, revision: hash(JSON.stringify(meta) + content), filePath: wikiSuggestionFile(id) };
    } catch (error) {
      if (missing(error)) throw new ApiError(404, "suggestion_not_found", "This suggestion is no longer available.");
      throw error;
    }
  }
  async list() {
    const folder = await this.path(["."]).catch(error => { if (missing(error)) return null; throw error; });
    if (!folder) return [];
    const entries = await readdir(folder, { withFileTypes: true }).catch(error => { if (missing(error)) return []; throw error; });
    const result: WikiSuggestion[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
      result.push(await this.read(entry.name));
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }
  async create(input: WikiSuggestionInput, sessionId: string | null) {
    const id = randomUUID(), now = Date.now();
    try {
      const attachments = await this.stageAttachments(id, input.attachments);
      await this.put(id, "draft.md", wikiSuggestionContent(input.content, input.destination.path, attachments));
      await this.put(id, "suggestion.json", JSON.stringify({ ...input, attachments, content: undefined, id, workspaceId: this.workspaceId, sessionId, status: "pending", createdAt: now, updatedAt: now }));
      return await this.read(id);
    } catch (error) {
      const folder = await this.path([id]).catch(() => null);
      if (folder) await rm(folder, { recursive: true, force: true });
      throw error;
    }
  }
  async current(id: string, revision: string) {
    const current = await this.read(id);
    if (current.status !== "pending") throw new ApiError(409, "suggestion_closed", "This suggestion has already been saved or dismissed.");
    if (current.revision !== revision) throw new ApiError(409, "suggestion_changed", "This draft changed. Reload it before continuing; your text is still available in the editor.");
    return current;
  }
  async update(id: string, revision: string, input: WikiSuggestionInput) {
    return this.locked(id, async () => {
      const current = await this.current(id, revision);
      const attachments = await this.stageAttachments(id, input.attachments, current.attachments);
      await this.put(id, "draft.md", wikiSuggestionContent(input.content, input.destination.path, attachments, current.attachments));
      await this.put(id, "suggestion.json", JSON.stringify(Metadata.parse({ ...current, ...input, attachments, updatedAt: Date.now() })));
      return this.read(id);
    });
  }
  /** Caller holds the lock while publishing or dismissing. */
  async finish(current: WikiSuggestion, status: "saved" | "dismissed") {
    if (status === "saved") await this.put(current.id, "draft.md", current.content);
    await this.put(current.id, "suggestion.json", JSON.stringify(Metadata.parse({ ...current, status, updatedAt: Date.now() })));
    return this.read(current.id);
  }
}
