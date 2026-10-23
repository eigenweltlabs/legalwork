import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ViewInput, ViewOwner, ViewRecord, ViewSummary, ViewIssue } from "@legalwork/types/views";
import { StoredViewSchema, ViewInputSchema, isLocalOpenUIProgram } from "./schema.js";
import { ApiError } from "../errors.js";
import { withFileWriteLock } from "../file-write-lock.js";
import { importProjectFile, projectFileParent } from "../project-file-links.js";

const MAX_BYTES = 2 * 1024 * 1024;
const isRecordPath = (path: string) => /\.view(?:\.conflict-[a-f0-9]{12})?\.json$/i.test(path);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
/** Independent files need independent IDs, even when several links share a source. */
export function copyViewRecord(bytes: Uint8Array): Buffer {
  if (bytes.length > MAX_BYTES) throw new ApiError(413, "view_too_large", "A saved view can contain up to 2 MB.");
  try {
    const { savedFrom: _legacySource, ...stored } = z.object({ savedFrom: z.unknown().optional() }).passthrough().parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    const record = StoredViewSchema.parse(stored);
    if (!isLocalOpenUIProgram(record.program)) throw new Error("Unsupported program");
    const copy = Buffer.from(JSON.stringify({ ...record, id: randomUUID(), updatedAt: Date.now() }, null, 2) + "\n");
    if (copy.length > MAX_BYTES) throw new Error("Record exceeds 2 MB");
    return copy;
  } catch {
    throw new ApiError(409, "view_copy_failed", "A linked dashboard could not be copied. Repair the dashboard before deleting its project. The source has been kept.");
  }
}
export type ViewFiles = {
  dashboardFolder?(): Promise<string>;
  list(): Promise<string[]>;
  read(path: string): Promise<Buffer>;
  write(path: string, bytes: Buffer, baseRevision: string): Promise<void>;
};

/** A single atomic record owns its program and frozen data. No second writable cache. */
export class ViewRepository {
  constructor(private readonly owner: ViewOwner, private readonly files: ViewFiles) {}
  private async records() {
    const records: { path: string; record: ViewRecord }[] = [];
    const issues: ViewIssue[] = [];
    const ids = new Set<string>();
    const paths = (await this.files.list()).filter(isRecordPath);
    if (paths.length > 1000) throw new ApiError(413, "too_many_views", "This workspace has more than 1,000 saved views.");
    for (const path of paths) {
      const filename = path.split("/").pop()?.split(".view")[0];
      let id = z.string().uuid().safeParse(filename).data;
      try {
        const bytes = await this.files.read(path);
        if (bytes.length > MAX_BYTES) throw new Error("Record exceeds 2 MB");
        const raw: unknown = JSON.parse(bytes.toString("utf8"));
        id = z.object({ id: z.string().uuid() }).safeParse(raw).data?.id ?? id;
        // Early preview builds wrote local receipt metadata into shared files.
        // Accept those files, but never expose or perpetuate that metadata.
        const { savedFrom: _legacySource, ...stored } = z.object({ savedFrom: z.unknown().optional() }).passthrough().parse(raw);
        const parsed = StoredViewSchema.parse(stored);
        if (!isLocalOpenUIProgram(parsed.program)) throw new Error("Unsupported program");
        if (ids.has(parsed.id)) issues.push({ path, id: parsed.id, code: "view_revision_conflict", message: "Competing copies of this view need reconciliation. Both copies have been preserved." });
        ids.add(parsed.id);
        records.push({ path, record: { ...parsed, owner: this.owner, revision: hash(bytes) } });
      } catch {
        issues.push({ path, ...(id ? { id } : {}), code: "view_invalid_record", message: `The saved view at ${path} could not be read. Its original bytes have been preserved.` });
      }
    }
    const blocked = new Set(issues.flatMap(issue => issue.id ? [issue.id] : []));
    return { records: records.filter(item => !blocked.has(item.record.id)), issues };
  }
  async readAll(): Promise<ViewRecord[]> { return (await this.records()).records.map(item => item.record); }
  async list(): Promise<{ items: ViewSummary[]; issues: ViewIssue[] }> {
    const { records, issues } = await this.records();
    return { items: records.map(({ path, record: { id, title, mode, updatedAt, revision, owner } }) => ({ path, id, title, mode, updatedAt, revision, owner })).sort((a, b) => b.updatedAt - a.updatedAt), issues };
  }
  private async find(id: string) {
    const { records, issues } = await this.records();
    const issue = issues.find(issue => issue.id === id);
    if (issue) throw new ApiError(409, issue.code, issue.message);
    return records.find(item => item.record.id === id);
  }
  async read(id: string): Promise<ViewRecord> {
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, "invalid_view_id", "Invalid view ID.");
    const item = await this.find(id);
    if (!item) throw new ApiError(404, "view_not_found", "This saved view is unavailable.");
    return item.record;
  }
  async location(id: string): Promise<string> {
    const item = await this.find(id);
    if (!item) throw new ApiError(404, "view_not_found", "This saved view is unavailable.");
    return item.path;
  }
  private validate(input: ViewInput) {
    const parsed = ViewInputSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, "invalid_view", "Check the view title, program and data bindings.");
    if (!isLocalOpenUIProgram(parsed.data.program)) throw new ApiError(400, "invalid_view_program", "Use the bundled OpenUI component language without scripts or hosted response bundles.");
    if (this.owner.kind === "workspace" && Object.keys(input.queries).length) throw new ApiError(400, "workspace_view_requires_datasets", "Project reports and dashboards use named datasets from their sources. Live indexed wiki queries belong to the wiki.");
    if (input.mode === "report" && Object.keys(input.queries).some(name => !input.datasets?.[name])) throw new ApiError(400, "report_snapshot_missing", "Frozen reports must retain their query datasets.");
    return parsed.data;
  }
  async create(input: ViewInput): Promise<ViewRecord> {
    const data = this.validate(input), id = randomUUID(), updatedAt = Date.now();
    const bytes = Buffer.from(JSON.stringify({ ...data, id, updatedAt }, null, 2) + "\n");
    if (bytes.length > MAX_BYTES) throw new ApiError(413, "view_too_large", "A saved view can contain up to 2 MB.");
    const folder = data.mode === "report" ? "Reports" : await this.files.dashboardFolder?.() ?? "Views";
    await this.files.write(`${folder}/${id}.view.json`, bytes, "");
    return { ...data, id, updatedAt, owner: this.owner, revision: hash(bytes) };
  }
  async update(id: string, input: ViewInput, baseRevision: string): Promise<ViewRecord> {
    const item = await this.find(id);
    if (!item) throw new ApiError(404, "view_not_found", "This saved view is unavailable.");
    if (item.record.revision !== baseRevision) throw new ApiError(409, "view_revision_conflict", "This view changed. Read its current revision before editing.");
    const data = this.validate(input);
    const updatedAt = Date.now(), bytes = Buffer.from(JSON.stringify({ ...data, id, updatedAt }, null, 2) + "\n");
    if (bytes.length > MAX_BYTES) throw new ApiError(413, "view_too_large", "A saved view can contain up to 2 MB.");
    await this.files.write(item.path, bytes, baseRevision);
    return { ...data, id, updatedAt, owner: this.owner, revision: hash(bytes) };
  }
}

/** Workspace adapter uses the same file lock as the existing editable-file APIs. */
export function workspaceViewFiles(root: string): ViewFiles {
  const read = async (path: string) => {
    const parts = path.split("/"), name = parts.pop();
    if (!name || !isRecordPath(path)) throw new ApiError(400, "invalid_view_path", "Invalid saved view path.");
    const parent = await projectFileParent(root, parts.join("/"));
    const handle = await open(join(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) throw new ApiError(413, "view_too_large", "A saved view can contain up to 2 MB.");
      return await handle.readFile();
    } finally { await handle.close(); }
  };
  return {
    dashboardFolder: async () => "Dashboards",
    async list() {
      const paths: string[] = [];
      let count = 0;
      const scan = async (folder: string) => {
        const parent = await projectFileParent(root, folder);
        for (const entry of await readdir(parent, { withFileTypes: true })) {
          if (++count > 250_000) throw new ApiError(413, "view_inventory_too_large", "This folder has too many entries to index views.");
          if (entry.name.startsWith(".") || entry.isSymbolicLink() || entry.name === "node_modules") continue;
          const path = folder ? `${folder}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await scan(path);
          else if (entry.isFile() && isRecordPath(path)) paths.push(path);
        }
      };
      await scan("");
      return paths;
    },
    read,
    async write(path, bytes, revision) {
      const parts = path.split("/"), name = parts.pop();
      if (!name || !isRecordPath(path)) throw new ApiError(400, "invalid_view_path", "Invalid saved view path.");
      if (revision === "") {
        const destination = parts.join("/");
        if (destination !== "Views" && destination !== "Reports" && destination !== "Dashboards") throw new ApiError(400, "invalid_view_path", "New views belong in Dashboards or Reports.");
        const base = await realpath(root), folder = join(base, destination);
        try { await mkdir(folder); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
        if ((await lstat(folder)).isSymbolicLink()) throw new ApiError(403, "invalid_view_path", "The view folder cannot be a symbolic link.");
        await importProjectFile(root, path, bytes);
        return;
      }
      const parent = await projectFileParent(root, parts.join("/")), target = join(parent, name);
      await withFileWriteLock(target, async () => {
        let current: Buffer;
        try { current = await read(path); } catch (error) { if (missing(error)) throw new ApiError(409, "view_revision_conflict", "This saved view was removed."); throw error; }
        if (hash(current) !== revision) throw new ApiError(409, "view_revision_conflict", "This saved view changed. Read its current revision before editing.");
        const temporary = join(parent, `.view-${randomUUID()}.tmp`);
        try { await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
        finally { await rm(temporary, { force: true }); }
      });
    },
  };
}
