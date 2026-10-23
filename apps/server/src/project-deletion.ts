import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { ProjectDeletionReview } from "@legalwork/types/workspace";
import { ApiError } from "./errors.js";
import { canonicalFilePath } from "./file-write-lock.js";
import { projectFolderOrigin } from "./project-folder-origin.js";
import { defaultProjectRoot } from "./project-store.js";
import { readProjectFileLinks, updateProjectFileLinks, projectFileParent, importProjectFile } from "./project-file-links.js";
import type { ProjectFileLink } from "./project-file-schema.js";
import { beginSessionDeletion } from "./session-execution-gate.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";
import { WikiStore } from "./wiki/store.js";
import { assertProjectFolderIndependent } from "./wiki/workspace-safety.js";
import { copyViewRecord } from "./views/repository.js";
import { reviewSessionViews, savedSessionViews, sessionViewPreviews } from "./views/session-previews.js";
import { backupProjectFolder } from "./project-backup.js";

type Engine = ReturnType<typeof createOpencodeClient>;
type Incoming = { workspace: WorkspaceInfo; link: ProjectFileLink };
export type ProjectDeletionEffects = { taskCount: number; calendarEntryCount: number; scheduledTaskCount: number };
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};
const result = <T>(response: { data?: T; response?: Response }): NonNullable<T> => {
  if (response.data == null || !response.response?.ok) throw new ApiError(502, "project_chats_unavailable", "Project chats could not be checked. Nothing has been removed from the project list. Reconnect the chat engine and retry.");
  return response.data;
};
const requestOptions = () => ({ signal: AbortSignal.timeout(30_000) });

/** A direct-folder inventory helps people recognize files that will really be deleted, without exposing paths. */
async function previewFolder(path: string, info: Awaited<ReturnType<typeof lstat>> | null) {
  if (!info?.isDirectory() || info.isSymbolicLink()) return null;
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const sorted = entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return {
      total: sorted.length,
      items: sorted.map(entry => ({
        name: entry.name,
        kind: entry.isSymbolicLink() ? "link" as const : entry.isDirectory() ? "folder" as const : "file" as const,
      })),
    };
  } catch {
    // A preview must never turn an otherwise valid deletion review into a failure.
    return null;
  }
}

async function countUnsavedDashboards(config: ServerConfig, workspace: WorkspaceInfo, engine: Engine, sessions: Array<{ id: string }>) {
  if (!sessions.length) return 0;
  const previews = [];
  for (const session of sessions) {
    const messages = result(await engine.session.messages({ sessionID: session.id }, requestOptions()));
    previews.push(...sessionViewPreviews(messages).map(item => ({ ...item, sessionId: session.id })));
  }
  if (!previews.length) return 0;
  return reviewSessionViews(previews, await savedSessionViews(config), workspace.id, sessions[0]!.id).items.length;
}

async function plan(config: ServerConfig, workspace: WorkspaceInfo, engine: Engine, loadEffects?: (workspaceId: string) => Promise<ProjectDeletionEffects>) {
  if (workspace.workspaceType !== "local") throw new ApiError(400, "local_project_required", "Delete the project on its host. This computer can only remove the remote connection.");
  const folder = resolve(workspace.path), canonical = await canonicalFilePath(folder);
  const info = await lstat(folder).catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  const folderOrigin = await projectFolderOrigin(config, workspace);
  const legacyManagedFolder = folderOrigin === "unknown" && info?.isDirectory() && !info.isSymbolicLink()
    && inside(await canonicalFilePath(defaultProjectRoot(config.projectsDirectory)), canonical);
  const deleteFolder = folderOrigin === "created_by_app" || Boolean(legacyManagedFolder);
  if (info && !info.isDirectory() && !info.isSymbolicLink()) throw new ApiError(409, "project_folder_unavailable", "The project folder is unavailable. Reconnect it before deleting the project.");
  if ((await new WikiStore(config).list()).some(wiki => wiki.workspaceId === workspace.id)) throw new ApiError(400, "wiki_deletion_required", "Delete this wiki through Wiki settings.");
  if (deleteFolder) await assertProjectFolderIndependent(canonical, await new WikiStore(config).list());
  const incoming: Incoming[] = [];
  for (const other of config.workspaces) {
    if (other.id === workspace.id || other.workspaceType !== "local") continue;
    const otherRoot = await canonicalFilePath(other.path);
    if (otherRoot === canonical || deleteFolder && (inside(canonical, otherRoot) || inside(otherRoot, canonical)))
      throw new ApiError(409, "project_folder_shared", "Another project uses this folder or an overlapping folder. Separate the project folders before deleting.");
    for (const link of await readProjectFileLinks(other.path)) {
      if (link.source.projectId === workspace.id || link.source.workspaceId === workspace.id) incoming.push({ workspace: other, link });
    }
  }
  // Explicit limit avoids the engine's small default. Refuse a truncated review
  // rather than unregistering a project while some of its chats still exist.
  const listed = result(await engine.session.list({ directory: folder, roots: false, limit: 10001 }, requestOptions()));
  if (listed.length >= 10001) throw new ApiError(413, "project_chat_limit", "This project has too many chats for one deletion. Delete some chats first.");
  const sessions = [];
  for (const session of listed) {
    if (!session.directory) throw new ApiError(502, "project_chats_unavailable", "A chat's project could not be verified. No project files have been deleted.");
    if (await canonicalFilePath(session.directory) === canonical) sessions.push(session);
  }
  const statuses = result(await engine.session.status({}, requestOptions()));
  if (sessions.some(session => statuses[session.id] && statuses[session.id].type !== "idle"))
    throw new ApiError(409, "project_chats_busy", "Stop the project's running chats before deleting it.");
  const [folderItems, unsavedDashboardCount, effects] = await Promise.all([
    deleteFolder ? previewFolder(folder, info) : Promise.resolve(null),
    countUnsavedDashboards(config, workspace, engine, sessions),
    loadEffects?.(workspace.id) ?? Promise.resolve({ taskCount: 0, calendarEntryCount: 0, scheduledTaskCount: 0 }),
  ]);
  const review: ProjectDeletionReview = {
    token: createHash("sha256").update(JSON.stringify({ id: workspace.id, canonical, inode: info?.ino, device: info?.dev, folderOrigin, deleteFolder,
      sessions: sessions.map(session => [session.id, session.time.updated]).sort(),
      effects, unsavedDashboardCount,
      incoming: incoming.map(item => [item.workspace.id, item.workspace.path, item.link]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    })).digest("hex"),
    name: workspace.displayName || workspace.name,
    folder, folderExists: Boolean(info), deleteFolder, folderItems, chatCount: sessions.length, unsavedDashboardCount, ...effects,
    copies: incoming.map(item => ({ projectId: item.workspace.id, projectName: item.workspace.displayName || item.workspace.name, name: item.link.name, folder: item.link.folder })),
  };
  return { review, incoming, sessions, canonical, inode: info?.ino, device: info?.dev };
}

export async function reviewProjectDeletion(config: ServerConfig, workspace: WorkspaceInfo, engine: Engine, loadEffects?: (workspaceId: string) => Promise<ProjectDeletionEffects>) {
  return (await plan(config, workspace, engine, loadEffects)).review;
}

async function preserveLink(config: ServerConfig, item: Incoming, readConnected: (link: ProjectFileLink) => Promise<Uint8Array>) {
  // Keep the metadata lock until the independent file is safely published.
  // A later failure leaves either the original link or a complete copy.
  await updateProjectFileLinks(item.workspace.path, async links => {
    const current = links.find(link => link.id === item.link.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(item.link)) throw new ApiError(409, "project_deletion_changed", "A linked file changed. Review the project deletion again.");
    const parent = await projectFileParent(item.workspace.path, current.folder);
    const sourceWorkspace = config.workspaces.find(workspace => workspace.id === current.source.workspaceId);
    if (!current.source.connectionId && sourceWorkspace?.workspaceType !== "local") throw new ApiError(409, "project_link_unavailable", `Reconnect the source of ${current.name} before deleting this project.`);
    const sourceRoot = current.source.connectionId ? null : await realpath(sourceWorkspace!.path);
    const source = sourceRoot ? await realpath(join(sourceRoot, current.source.path)) : null;
    if (source && sourceRoot && !inside(sourceRoot, source)) throw new ApiError(409, "project_link_external", `Relink ${current.name} directly to its external source before deleting this project.`);
    if (source && !(await stat(source)).isFile()) throw new ApiError(409, "project_link_not_file", `The linked file ${current.name} is unavailable.`);
    const isView = /\.view(?:\.conflict-[a-f0-9]{12})?\.json$/i.test(current.source.path);
    if (isView && source && (await stat(source)).size > 2 * 1024 * 1024) throw new ApiError(413, "view_too_large", "A saved view can contain up to 2 MB.");
    const bytes = isView ? copyViewRecord(source ? await readFile(source) : await readConnected(current)) : source ? null : await readConnected(current);
    const suffix = isView ? ".view.json" : extname(current.source.path);
    const name = isView && !/\.view\.json$/i.test(current.name) ? `${current.name}.view.json` : extname(current.name) ? current.name : `${current.name}${suffix}`;
    const extension = /\.view\.json$/i.test(name) ? name.slice(-10) : extname(name);
    const stem = basename(name, extension);
    for (let attempt = 0; attempt < 10000; attempt++) {
      const filename = attempt ? `${stem} (${attempt + 1})${extension}` : name;
      const destination = join(parent, filename);
      try {
        if (bytes) await importProjectFile(item.workspace.path, [current.folder, filename].filter(Boolean).join("/"), bytes);
        else await copyFile(source!, destination, constants.COPYFILE_EXCL);
        return links.filter(link => link.id !== current.id);
      } catch (error) {
        if (error instanceof ApiError && error.code === "file_exists" || error instanceof Error && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
    }
    throw new ApiError(409, "project_copy_collision", "Choose a different name for the linked file before deleting the project.");
  });
}

export async function deleteProjectData(input: {
  config: ServerConfig; workspace: WorkspaceInfo; engine: Engine; token: string;
  readConnected: (link: ProjectFileLink) => Promise<Uint8Array>;
  cleanupSession: (id: string) => Promise<void>;
  beforeFiles: () => Promise<void>;
  loadEffects?: (workspaceId: string) => Promise<ProjectDeletionEffects>;
  backupDirectory?: string;
}) {
  const { config, workspace, engine } = input;
  const current = await plan(config, workspace, engine, input.loadEffects);
  if (current.review.token !== input.token) throw new ApiError(409, "project_deletion_changed", "The project changed. Review the deletion again.");
  if (input.backupDirectory && !current.review.deleteFolder) throw new ApiError(400, "project_folder_retained", "This project folder is kept in place. No backup is needed to delete the project.");
  const releases: Array<() => void> = [];
  try {
    for (const session of current.sessions) releases.push(beginSessionDeletion(config, session.id));
    const ids = new Set(current.sessions.map(session => session.id));
    for (const session of current.sessions) {
      const children = result(await engine.session.children({ sessionID: session.id }, requestOptions()));
      if (children.some(child => !ids.has(child.id))) throw new ApiError(409, "project_chat_scope", "A related chat belongs to another folder. Separate the chats before deleting this project.");
      const messages = result(await engine.session.messages({ sessionID: session.id, limit: 1 }, requestOptions()));
      if (messages.some(message => message.parts.some(part => part.type === "tool" && ["pending", "running"].includes(part.state.status))))
        throw new ApiError(409, "project_chats_busy", "A tool is still running. Wait for the project's chats to finish before deleting.");
    }
    const backup = input.backupDirectory ? await backupProjectFolder(config, workspace.path, input.backupDirectory) : null;
    for (const item of current.incoming) {
      try { await preserveLink(config, item, input.readConnected); }
      catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(409, "project_copy_failed", `Could not keep a copy of “${item.link.name}” in “${item.workspace.displayName || item.workspace.name}”. Check the linked file and destination folder, then retry. The source project files have been kept.`);
      }
    }
    const statuses = result(await engine.session.status({}, requestOptions()));
    if (current.sessions.some(session => statuses[session.id] && statuses[session.id].type !== "idle"))
      throw new ApiError(409, "project_chats_busy", "Stop the project's running chats before deleting it.");
    for (const session of current.sessions.filter(session => !session.parentID || !ids.has(session.parentID))) {
      const deleted = result(await engine.session.delete({ sessionID: session.id }, requestOptions()));
      if (deleted !== true) throw new ApiError(502, "project_chat_delete_failed", "A chat could not be deleted. The project remains available so you can retry.");
    }
    // Verify cascades and clean up orphaned/archived children too.
    for (const session of current.sessions) {
      const remaining = await engine.session.get({ sessionID: session.id }, requestOptions());
      if (remaining.response?.status !== 404) {
        result(remaining);
        if (result(await engine.session.delete({ sessionID: session.id }, requestOptions())) !== true)
          throw new ApiError(502, "project_chat_delete_failed", "A related chat could not be deleted. Retry project deletion.");
      }
      await input.cleanupSession(session.id);
    }
    const remaining = result(await engine.session.list({ directory: workspace.path, roots: false, limit: 10001 }, requestOptions()));
    for (const session of remaining) {
      if (!session.directory || await canonicalFilePath(session.directory) === current.canonical)
        throw new ApiError(409, "project_chats_remaining", "Some chats remain in this project. Review the deletion again before removing its files.");
    }
    await backup?.verify();
    await input.beforeFiles();
    if (current.review.deleteFolder) {
      const latest = await lstat(workspace.path);
      if (!latest.isDirectory() || latest.isSymbolicLink() || latest.ino !== current.inode || latest.dev !== current.device || await realpath(workspace.path) !== current.canonical)
        throw new ApiError(409, "project_folder_changed", "The project folder changed during deletion. Its files were kept.");
      // fs.rm removes links themselves; it never follows a linked directory.
      try { await rm(current.canonical, { recursive: true }); }
      catch {
        throw new ApiError(409, "project_files_delete_failed", "The chats were deleted, but some project files could not be removed. Close files in other apps, check folder permissions and retry to finish deleting the project.");
      }
    }
    return { sessionIds: [...ids], copiedFiles: current.incoming.length, backupPath: backup?.path ?? null };
  } finally { for (const release of releases) release(); }
}
