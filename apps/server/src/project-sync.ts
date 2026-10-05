import { syncProjectCalendar } from "./calendar/sync.js";
import { calendarStore } from "./calendar/store.js";
import { updateProjectRemote } from "./project-store.js";
import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { copyFile, readdir, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type {
  ProjectField,
  ProjectSyncOverview,
  ProjectSyncScope,
  ProjectSyncSettings,
  ProjectSyncState,
  ProjectSyncStatus,
} from "@legalwork/types/workspace";
import { z } from "zod";

import { announceSyncChange } from "./app-sync-events.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { requireIntakeClient, type IntakeClient } from "./eigenwelt-intake.js";
import { eigenweltProjectStorage, type RemoteFileIndex } from "./eigenwelt-project-storage.js";
import {
  createRemoteProject,
  deleteRemoteProject,
  listRemoteProjects,
  patchRemoteProject,
  PROJECT_MAX_FILE_BYTES,
  type RemoteProject,
} from "./eigenwelt-projects.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { syncCalendarSubscriptions } from "./calendar/subscriptions.js";
import { ApiError } from "./errors.js";
import type { StorageAdapter } from "./file-storage/common.js";
import { fileKey, hashFile, moveToSyncTrash, syncExcluded, syncProjectFiles } from "./project-file-sync.js";
import { pendingReviewChanges, reviewDocumentKeys, syncProjectReviews } from "./project-review-sync.js";
import {
  createDefaultProjectFolder,
  defaultProjectRoot,
  readProjectDetails,
  setProjectSyncId,
  updateProjectDetails,
  updateProjectPersonalization,
} from "./project-store.js";
import {
  projectSyncStore,
  type FieldChange,
  type ProjectLink,
  type ProjectSyncOp,
  type ProjectSyncStore,
} from "./project-sync-store.js";
import { reviewRunActive } from "./reviews/service.js";
import { registerLocalProject, renameRegisteredWorkspace, unregisterWorkspace } from "./routes/workspaces.js";
import { taskStore } from "./task-store.js";
import { scheduleTaskSync } from "./task-sync.js";
import { connectedTaskOrgId } from "./tasks-api.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

/**
 * Eigenwelt Sync for projects (Akten). A project is local until its owner
 * turns sync on; then the firm keeps it, and every colleague it is shared
 * with — named members, or the whole firm — gets it on their computer.
 *
 * One round:
 *   1. push the project writes made here, in order (turn on, rename, details,
 *      settings, stop) — project-sync-store.ts keeps them;
 *   2. pull what changed at the firm: projects that arrived get a folder here
 *      (or are recognised in one they already have, by the id kept in
 *      .legalwork/project.json, so a project never turns into a second copy),
 *      renames and details are taken over, and projects this member lost are
 *      removed — or, if changes made here had not reached the firm, kept
 *      back until the member decides;
 *   3. sync each project's Tabular Reviews (project-review-sync.ts), then its
 *      documents (project-file-sync.ts).
 *
 * What a project carries is its scope: documents, notes, tasks, recordings,
 * details, and Tabular Reviews with the documents they review. Tasks go through the task sync (task-sync.ts), which asks
 * project_links whether a task's project syncs its tasks. Chats never go
 * with a project: each chat is shared on its own, by its own sharing.
 */

/** The platform calls a round makes; injectable so a test can stand in for the platform. */
export type ProjectSyncPlatform = {
  listProjects: typeof listRemoteProjects;
  createProject: typeof createRemoteProject;
  patchProject: typeof patchRemoteProject;
  deleteProject: typeof deleteRemoteProject;
  /** A project's documents at the firm; `index` keeps their listing between rounds. */
  storage: (client: IntakeClient, projectId: string, index: RemoteFileIndex) => StorageAdapter;
};

const REAL_PLATFORM: ProjectSyncPlatform = {
  listProjects: listRemoteProjects,
  createProject: createRemoteProject,
  patchProject: patchRemoteProject,
  deleteProject: deleteRemoteProject,
  storage: eigenweltProjectStorage,
};

export const DEFAULT_PROJECT_SCOPE: ProjectSyncScope = {
  calendar: true,
  documents: true,
  notes: true,
  tasks: true,
  recordings: false,
  metadata: true,
  reviews: true,
};

/** Pushes and pulls again this long after a local change, so a burst is one round. */
const CHANGE_DEBOUNCE_MS = 3_000;
/** The same after a review changed: a running review writes after every answer. */
const REVIEW_DEBOUNCE_MS = 15_000;
/** The background cadence while the app is open. */
const TIMER_INTERVAL_MS = 60_000;
/** The same while the firm pokes this computer (eigenwelt-sync-events.ts): only a safety net. */
const POKED_INTERVAL_MS = 5 * 60_000;

export type ProjectSyncResult = {
  ran: boolean;
  pushed: number;
  pulled: number;
  arrived: number;
  removed: number;
  error: string | null;
};

type Host = { onWorkspacesChanged: () => void };
type RoundState = { offline: boolean; error: string | null; at: number | null };

function keyOf(config: ServerConfig): string {
  return process.env.LEGALWORK_RUNTIME_DB?.trim() || config.configPath?.trim() || "default";
}

const hosts = new Map<string, Host>();
const revisions = new Map<string, number>();
/** Whether the firm's pokes reach this computer now. */
const poked = new Map<string, boolean>();
/** Per project, how often sync changed its files here: the app reloads what shows them when it moves. */
const contentRevisions = new Map<string, Map<string, number>>();
/** Projects sync took off this computer: the app forgets them in its own list too. */
const removedWorkspaces = new Map<string, Set<string>>();
const roundStates = new Map<string, RoundState>();
const rounds = new Map<string, Promise<ProjectSyncResult>>();
const pendingRounds = new Map<string, ReturnType<typeof setTimeout>>();
const watchers = new Map<string, Map<string, FSWatcher>>();

/** The firm's pokes reach this computer (or stopped reaching it): the timer steps back (or in again). */
export function setProjectSyncPoked(config: ServerConfig, live: boolean): void {
  poked.set(keyOf(config), live);
}

/** How the server hosting project sync hears that its project list changed. */
export function configureProjectSync(config: ServerConfig, host: Host): void {
  hosts.set(keyOf(config), host);
}

/** The project list changed (a project arrived, left or was renamed): the app reloads it. */
function workspacesChanged(config: ServerConfig): void {
  const key = keyOf(config);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
  hosts.get(key)?.onWorkspacesChanged();
  announceSyncChange(config, "projects");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The platform cannot be reached at all (as opposed to refusing something). */
function unreachable(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "intake_unreachable" || error.status === 429 || error.status >= 500);
}

/** Nothing else will go through this round either. */
function roundStopper(error: unknown): boolean {
  return unreachable(error) || (error instanceof ApiError && error.status === 401);
}

/**
 * A project-relative path belongs to the part of the scope named by its top
 * folder. A document also goes with the reviews when they are shared and one
 * of them reviews it (`reviewed`: file keys, see reviewDocumentKeys).
 */
export function scopeIncludes(scope: ProjectSyncScope, path: string, reviewed?: Set<string>, attached?: Set<string>): boolean {
  if (scope.calendar !== false && attached?.has(fileKey(path))) return true;
  const top = path.split("/")[0].toLowerCase();
  if (top === "notes") return scope.notes;
  if (top === "recordings") return scope.recordings;
  return scope.documents || (scope.reviews && (reviewed?.has(fileKey(path)) ?? false));
}

/** The documents that go with the reviews, when reviews are shared without all documents. */
async function reviewedDocuments(scope: ProjectSyncScope, root: string): Promise<Set<string> | undefined> {
  return scope.reviews && !scope.documents ? reviewDocumentKeys(root) : undefined;
}

function nameOf(workspace: WorkspaceInfo): string {
  return workspace.displayName?.trim() || workspace.name;
}

function workspaceOf(config: ServerConfig, workspaceId: string): WorkspaceInfo | null {
  return config.workspaces.find((entry) => entry.id === workspaceId && entry.workspaceType !== "remote") ?? null;
}

async function folderAvailable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A moment just before an ISO timestamp, so the next delta re-reads a project changed in the same millisecond. */
function justBefore(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms - 1).toISOString() : iso;
}

/** Per detail: added or changed (its new definition), removed (null); and the order when it moved. */
export function diffFields(before: ProjectField[], after: ProjectField[]): { changes: FieldChange[]; order: string[] | null } {
  const previous = new Map(before.map((field) => [field.id, JSON.stringify(field)]));
  const changes: FieldChange[] = after
    .filter((field) => previous.get(field.id) !== JSON.stringify(field))
    .map((field) => ({ id: field.id, field }));
  const remaining = new Set(after.map((field) => field.id));
  for (const field of before) if (!remaining.has(field.id)) changes.push({ id: field.id, field: null });
  const beforeOrder = before.map((field) => field.id).filter((id) => remaining.has(id));
  const afterOrder = after.map((field) => field.id).filter((id) => previous.has(id));
  const moved = beforeOrder.some((id, index) => afterOrder[index] !== id);
  return { changes, order: moved || changes.some((change) => change.field !== null && !previous.has(change.id)) ? after.map((field) => field.id) : null };
}

// --- Push ------------------------------------------------------------------------

async function pushOutbox(
  config: ServerConfig,
  platform: ProjectSyncPlatform,
  client: IntakeClient,
  store: ProjectSyncStore,
): Promise<number> {
  let pushed = 0;
  const blocked = new Set<string>();
  for (const entry of store.outbox()) {
    if (blocked.has(entry.projectId)) continue;
    const link = store.linkByProject(entry.projectId);
    try {
      await pushOne(config, platform, client, store, link, entry.op, entry.projectId);
      store.completeOutbox(entry.seq);
      pushed += 1;
    } catch (error) {
      if (roundStopper(error)) {
        store.failOutbox(entry.seq, messageOf(error));
        throw error;
      }
      if (error instanceof ApiError && (error.status === 404 || error.status === 400 || error.status === 403)) {
        // Gone, or never to be taken: the op is dropped, and the reason stays on
        // the project. A missing project is settled by the pull (`hidden`).
        store.completeOutbox(entry.seq);
        if (link) store.updateLink(link.workspaceId, { lastError: messageOf(error) });
        continue;
      }
      store.failOutbox(entry.seq, messageOf(error));
      blocked.add(entry.projectId);
    }
  }
  return pushed;
}

async function pushOne(
  config: ServerConfig,
  platform: ProjectSyncPlatform,
  client: IntakeClient,
  store: ProjectSyncStore,
  link: ProjectLink | null,
  op: ProjectSyncOp,
  projectId: string,
): Promise<void> {
  if (op.kind === "stop") {
    await platform.deleteProject(client, projectId).catch((error: unknown) => {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    });
    return;
  }
  // Sync was turned off again before this went out: nothing to say.
  if (!link) return;
  switch (op.kind) {
    case "create": {
      const workspace = workspaceOf(config, link.workspaceId);
      if (!workspace) return;
      const details = await readProjectDetails(workspace.path);
      const remote = await platform.createProject(client, {
        id: link.projectId,
        name: nameOf(workspace),
        fields: link.settings.scope.metadata ? details.fields : [],
        ...(link.settings.scope.metadata ? { personalizationPrompt: details.personalizationPrompt ?? "" } : {}),
        ...(details.remote ? { remote: details.remote } : {}),
        scope: { ...link.settings.scope, calendar: link.settings.scope.calendar !== false },
        access: link.settings.access,
        memberIds: link.settings.memberIds,
      });
      if (details.remote && remote.remote === null) {
        const repaired = await platform.patchProject(client, link.projectId, { remote: details.remote });
        if (!repaired.project?.remote) throw new ApiError(503, "project_remote_upgrade_required", "The team service needs an update before folder mappings can sync.");
      }
      if (details.remote && remote.remote === undefined) throw new ApiError(503, "project_remote_upgrade_required", "The team service needs an update before folder mappings can sync.");
      if (link.settings.scope.metadata && details.personalizationPrompt && remote.personalizationPrompt == null) {
        await pushPersonalization(platform, client, link.projectId, details.personalizationPrompt);
      }
      store.updateLink(link.workspaceId, {
        confirmed: true,
        ownerUserId: remote.ownerUserId,
        role: remote.role,
        remoteUpdatedAt: remote.updatedAt,
        lastError: null,
      });
      return;
    }
    case "remote": {
      const result = await platform.patchProject(client, projectId, { remote: op.remote, changedAt: op.changedAt });
      if (result.project && result.project.remote == null) throw new ApiError(503, "project_remote_upgrade_required", "The team service needs an update before folder mappings can sync.");
      return;
    }
    case "rename":
      await platform.patchProject(client, projectId, { name: op.name, changedAt: op.changedAt });
      return;
    case "personalization":
      if (link.settings.scope.metadata) await pushPersonalization(platform, client, projectId, op.prompt, op.changedAt);
      return;
    case "fields":
      await platform.patchProject(client, projectId, {
        fieldChanges: op.changes,
        ...(op.order === null ? {} : { fieldOrder: op.order }),
        changedAt: op.changedAt,
      });
      return;
    case "settings":
      await platform.patchProject(client, projectId, {
        access: op.settings.access,
        memberIds: op.settings.memberIds,
        scope: op.settings.scope,
      });
      return;
  }
}

async function pushPersonalization(platform: ProjectSyncPlatform, client: IntakeClient, projectId: string, prompt: string, changedAt?: string): Promise<void> {
  const result = await platform.patchProject(client, projectId, { personalizationPrompt: prompt, changedAt });
  if (result.project && (result.project.personalizationPrompt === undefined || (result.project.scope.metadata && result.project.personalizationPrompt === null))) {
    throw new ApiError(503, "project_personalization_upgrade_required", "The team service needs an update before project instructions can sync.");
  }
}

// --- Pull ------------------------------------------------------------------------

/** A registered local project whose folder already carries this firm project's id. */
async function registeredCopy(config: ServerConfig, store: ProjectSyncStore, projectId: string): Promise<WorkspaceInfo | null> {
  for (const workspace of config.workspaces) {
    if (workspace.workspaceType === "remote" || store.linkByWorkspace(workspace.id)) continue;
    const details = await readProjectDetails(workspace.path).catch(() => null);
    if (details?.syncProjectId === projectId) return workspace;
  }
  return null;
}

/** A folder in the projects folder that already is this project: left by an interrupted arrival, or a reinstall. */
async function unregisteredCopy(config: ServerConfig, root: string, projectId: string): Promise<string | null> {
  const registered = new Set(config.workspaces.map((workspace) => resolve(workspace.path)));
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (registered.has(resolve(path))) continue;
    const details = await readProjectDetails(path).catch(() => null);
    if (details?.syncProjectId === projectId) return path;
  }
  return null;
}

/** Take the firm's details, keeping each one with a change here still on its way up. */
async function applyRemoteDetails(config: ServerConfig, store: ProjectSyncStore, link: ProjectLink, workspace: WorkspaceInfo, remote: RemoteProject): Promise<void> {
  const pending = store.pendingOps(link.projectId);
  const dirty = new Set(pending.flatMap((op) => (op.kind === "fields" ? op.changes.map((change) => change.id) : [])));
  const orderDirty = pending.some((op) => op.kind === "fields" && op.order !== null);
  const current = await readProjectDetails(workspace.path);
  const local = new Map(current.fields.map((field) => [field.id, field]));
  const merged = remote.fields.flatMap((field) => {
    if (!dirty.has(field.id)) return [field];
    const mine = local.get(field.id);
    return mine ? [mine] : [];
  });
  for (const field of current.fields) {
    if (dirty.has(field.id) && !merged.some((entry) => entry.id === field.id)) merged.push(field);
  }
  const ordered = orderDirty
    ? [...merged].sort((a, b) => {
        const indexOf = (id: string) => current.fields.findIndex((field) => field.id === id);
        return indexOf(a.id) - indexOf(b.id);
      })
    : merged;
  const updated = JSON.stringify(ordered) === JSON.stringify(current.fields) ? current
    : await updateProjectDetails(workspace.path, { revision: current.revision, fields: ordered });
  if (pending.some((op) => op.kind === "personalization")) return;
  if (remote.personalizationPrompt === null && updated.personalizationPrompt) {
    // Existing shared projects gain instructions without erasing a saved local prompt.
    await noteProjectPersonalizationSaved(config, workspace.id, "", updated.personalizationPrompt);
  } else if (typeof remote.personalizationPrompt === "string" && remote.personalizationPrompt !== (updated.personalizationPrompt ?? "")) {
    await updateProjectPersonalization(workspace.path, { revision: updated.revision, customInstructions: remote.personalizationPrompt });
  }
}

/**
 * A project of the firm this machine does not have yet. It is recognised in a
 * folder that already carries its id before a new folder is made for it, so
 * an interrupted arrival or a reinstall never leaves two copies of one Akte.
 * One of the member's own projects that carries it (the same folder on a
 * shared drive, say) is never taken over unasked: the member decides to use
 * it as their copy or keep the two apart, and until then nothing arrives.
 */
async function arrive(config: ServerConfig, store: ProjectSyncStore, orgId: string, remote: RemoteProject): Promise<boolean> {
  let registered = await registeredCopy(config, store, remote.id);
  if (registered && remote.role !== "owner") {
    if (store.isRemoved(remote.id)) return false;
    const offer = store.offer(remote.id);
    if (offer?.decision === "separate") registered = null;
    else if (offer?.decision !== "use") {
      if (!offer) {
        store.saveOffer({ projectId: remote.id, workspaceId: registered.id, orgId, name: remote.name, ownerUserId: remote.ownerUserId });
        workspacesChanged(config);
      }
      return false;
    }
  }
  if (!registered && store.isRemoved(remote.id)) return false;
  let workspace = registered;
  // A folder the user brought stays theirs whoever owns the project, and so
  // does the owner's own; a copy sync made (now, or in a round that was
  // interrupted) is one it may take away again.
  let origin: ProjectLink["origin"] = registered || remote.role === "owner" ? "local" : "remote";
  if (!workspace) {
    const root = defaultProjectRoot(config.projectsDirectory);
    const existing = await unregisteredCopy(config, root, remote.id);
    const folderPath = existing ?? (await createDefaultProjectFolder(remote.name, root));
    if (!existing) {
      await setProjectSyncId(folderPath, remote.id);
      origin = "remote";
    }
    workspace = (await registerLocalProject(config, { folderPath, name: remote.name, preset: "starter", position: "last" })).workspace;
  }
  store.clearRemoved(remote.id);
  const link: ProjectLink = {
    workspaceId: workspace.id,
    projectId: remote.id,
    orgId,
    origin,
    role: remote.role,
    ownerUserId: remote.ownerUserId,
    settings: { access: remote.access, memberIds: remote.memberIds, scope: remote.scope },
    confirmed: true,
    remoteUpdatedAt: remote.updatedAt,
    filesReconciledAt: null,
    state: "active",
    allowDeletions: false,
    lastSyncAt: null,
    lastError: null,
    report: null,
  };
  store.saveLink(link);
  if (remote.scope.metadata) await applyRemoteDetails(config, store, link, workspace, remote);
  if (remote.remote) await updateProjectRemote(workspace.path, remote.remote);
  const tasks = await taskStore(config);
  tasks.linkRemoteProjectTasks(remote.id, workspace.id);
  if (remote.scope.tasks) tasks.publishProjectTasks(workspace.id);
  return true;
}

async function applyRemote(config: ServerConfig, store: ProjectSyncStore, link: ProjectLink, remote: RemoteProject): Promise<void> {
  const pending = store.pendingOps(link.projectId);
  const settings = pending.some((op) => op.kind === "settings")
    ? link.settings
    : { access: remote.access, memberIds: remote.memberIds, scope: remote.scope };
  const tasks = await taskStore(config);
  if (settings.scope.tasks && !link.settings.scope.tasks) tasks.publishProjectTasks(link.workspaceId);
  if (link.state === "revoked") {
    // Given access again after a while without it (its owner may have stopped
    // syncing it, which empties the firm's copy): what both sides last agreed
    // on no longer holds, so nothing missing at the firm counts as deleted there.
    store.clearFileBase(link.projectId);
    store.clearReviewBase(link.projectId);
    store.remoteIndex(link.projectId).clear();
  }
  store.updateLink(link.workspaceId, {
    role: remote.role,
    ownerUserId: remote.ownerUserId,
    settings,
    confirmed: true,
    remoteUpdatedAt: remote.updatedAt,
    // Given access again while a copy was held back: it syncs again, and the
    // changes made here meanwhile go up with the next reconcile.
    state: "active",
  });
  const workspace = workspaceOf(config, link.workspaceId);
  if (!workspace) return;
  if (!pending.some((op) => op.kind === "rename") && nameOf(workspace) !== remote.name) {
    await renameRegisteredWorkspace(config, workspace.id, remote.name);
    workspacesChanged(config);
  }
  if (remote.remote && !pending.some((op) => op.kind === "remote") && await folderAvailable(workspace.path)) {
    const current = await readProjectDetails(workspace.path);
    if (JSON.stringify(current.remote) !== JSON.stringify(remote.remote)) await updateProjectRemote(workspace.path, remote.remote, current.revision);
  }
  if (settings.scope.metadata && (await folderAvailable(workspace.path))) {
    await applyRemoteDetails(config, store, { ...link, settings }, workspace, remote);
  }
}

/** Files here that differ from what both sides last agreed on, without reading their content. */
async function localChanges(config: ServerConfig, store: ProjectSyncStore, link: ProjectLink, root: string): Promise<number> {
  const base = store.fileBase(link.projectId).entries();
  const reviewed = await reviewedDocuments(link.settings.scope, root);
  const attached = new Set((await calendarStore(config)).list(link.workspaceId).flatMap(item => item.attachmentPaths.map(fileKey)));
  const seen = new Set<string>();
  let changed = 0;
  const folders = [root];
  while (folders.length > 0) {
    const folder = folders.pop() ?? root;
    for (const item of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (syncExcluded(item.name)) continue;
      const abs = join(folder, item.name);
      if (item.isDirectory()) folders.push(abs);
      if (!item.isFile()) continue;
      const path = abs.slice(root.length + 1).split(sep).join("/").normalize("NFC");
      if (!scopeIncludes(link.settings.scope, path, reviewed, attached)) continue;
      const key = fileKey(path);
      seen.add(key);
      const info = await stat(abs);
      const known = base.get(key);
      // A time that moved alone (a touch, another runtime's rounding) is no change: the content says.
      if (!known || known.size !== info.size || (known.mtimeMs !== info.mtimeMs && (await hashFile(abs)) !== known.sha256)) changed += 1;
    }
  }
  for (const key of base.keys()) if (!seen.has(key)) changed += 1;
  if (link.settings.scope.reviews) changed += await pendingReviewChanges(root, store.reviewBase(link.projectId));
  return changed + store.pendingOps(link.projectId).length + (await calendarStore(config)).pending(link.workspaceId).length;
}

/** The project stays here as a local project: nothing about it syncs any more. */
async function keepAsLocal(config: ServerConfig, store: ProjectSyncStore, link: ProjectLink): Promise<void> {
  const workspace = workspaceOf(config, link.workspaceId);
  (await taskStore(config)).keepProjectTasksLocal(link.workspaceId);
  (await calendarStore(config)).withdraw(link.workspaceId, true);
  // A member's own folder may be the owner's too (a shared drive): its id is not the member's to clear.
  const ownFolder = link.origin === "local" && link.role !== "owner";
  if (workspace && !ownFolder && (await folderAvailable(workspace.path))) await setProjectSyncId(workspace.path, null);
  store.discardOutbox(link.projectId);
  store.removeLink(link.workspaceId);
  workspacesChanged(config);
}

/**
 * The copy this machine was given leaves it: the project, its folder, and its
 * tasks. A folder the member brought themselves is never deleted: it stays,
 * as their own local project.
 */
async function removeCopy(config: ServerConfig, store: ProjectSyncStore, link: ProjectLink): Promise<void> {
  if (link.origin === "local") {
    await keepAsLocal(config, store, link);
    return;
  }
  const workspace = workspaceOf(config, link.workspaceId);
  (await calendarStore(config)).withdraw(link.workspaceId, false);
  store.discardOutbox(link.projectId);
  store.removeLink(link.workspaceId);
  if (workspace) {
    await unregisterWorkspace(config, workspace);
    removedWorkspaces.set(keyOf(config), (removedWorkspaces.get(keyOf(config)) ?? new Set<string>()).add(workspace.id));
    // Only a folder sync made itself is deleted; a folder the member brought is theirs.
    const root = resolve(defaultProjectRoot(config.projectsDirectory));
    if (link.origin === "remote" && resolve(workspace.path).startsWith(root + sep)) {
      await rm(workspace.path, { recursive: true, force: true });
    }
  }
  workspacesChanged(config);
}

/**
 * The firm no longer shows this project to the member: its owner stopped
 * syncing it, or took the member off it. The owner's own folder becomes a
 * local project again. A copy that came from the firm leaves this machine —
 * unless changes made here never reached the firm; then it waits for the
 * member to keep it as a local project or remove it.
 */
async function onHidden(config: ServerConfig, store: ProjectSyncStore, link: ProjectLink): Promise<boolean> {
  if (link.state === "revoked") return false;
  if (link.origin === "local") {
    await keepAsLocal(config, store, link);
    return true;
  }
  const workspace = workspaceOf(config, link.workspaceId);
  if (workspace && (await folderAvailable(workspace.path)) && (await localChanges(config, store, link, workspace.path)) > 0) {
    store.updateLink(link.workspaceId, { state: "revoked" });
    workspacesChanged(config);
    return false;
  }
  await removeCopy(config, store, link);
  return true;
}

async function pullChanges(
  config: ServerConfig,
  platform: ProjectSyncPlatform,
  client: IntakeClient,
  store: ProjectSyncStore,
  orgId: string,
): Promise<{ pulled: number; arrived: number; removed: number }> {
  const since = store.pullCursor(orgId);
  let pageCursor: string | null = null;
  let newest: string | null = null;
  let pulled = 0;
  let arrived = 0;
  let removed = 0;
  const hidden = new Set<string>();
  do {
    const page = await platform.listProjects(client, { updatedSince: since, cursor: pageCursor });
    for (const remote of page.projects) {
      const link = store.linkByProject(remote.id);
      if (link) await applyRemote(config, store, link, remote);
      else if (await arrive(config, store, orgId, remote)) arrived += 1;
      if (newest === null || remote.updatedAt > newest) newest = remote.updatedAt;
      pulled += 1;
    }
    for (const id of page.hidden) hidden.add(id);
    pageCursor = page.nextCursor;
  } while (pageCursor !== null);
  for (const id of hidden) {
    const link = store.linkByProject(id);
    if (link && (await onHidden(config, store, link))) removed += 1;
    // Removed from this computer by the member: shared with them again later, it comes back.
    if (!link) store.clearRemoved(id);
    // No longer shared with them: nothing left to decide.
    if (store.offer(id)?.decision === null) {
      store.dropOffer(id);
      workspacesChanged(config);
    }
  }
  if (arrived > 0) workspacesChanged(config);
  store.setPullCursor(orgId, newest === null ? since : justBefore(newest));
  return { pulled, arrived, removed };
}

// --- Documents -----------------------------------------------------------------------

/**
 * Recordings linked to the project go into its `recordings/` folder once each
 * (audio and transcript, as the recorder exports them), and from there sync
 * like any document. A recorder that is not there (a server without the
 * desktop) has nothing to add.
 */
async function exportRecordings(config: ServerConfig, store: ProjectSyncStore, link: ProjectLink, root: string): Promise<void> {
  const recorder = config.recorder;
  if (!recorder?.listProjectRecordings || !recorder.exportProjectRecording) return;
  const exported = store.exportedRecordings(link.projectId);
  try {
    for (const recording of await recorder.listProjectRecordings(link.workspaceId)) {
      if (recording.status !== "complete" || exported.has(recording.id)) continue;
      if (await recorder.exportProjectRecording(link.workspaceId, recording.id, root)) {
        store.markRecordingExported(link.projectId, recording.id);
      }
    }
  } catch {
    // The documents still sync; the recording is copied on a later round.
  }
}

async function syncDocuments(
  config: ServerConfig,
  platform: ProjectSyncPlatform,
  client: IntakeClient,
  store: ProjectSyncStore,
  link: ProjectLink,
  runner: { userId: string; name: string | null },
): Promise<void> {
  const label = runner.name ?? "LegalWork";
  // A project leaves sync only when it is removed from the list (noteProjectRemoved),
  // never because a server with another project list does not know it.
  const workspace = workspaceOf(config, link.workspaceId);
  if (!workspace || !(await folderAvailable(workspace.path))) return;
  const scope = link.settings.scope;
  if (!scope.documents && !scope.notes && !scope.recordings && !scope.reviews && scope.calendar === false) {
    store.updateLink(link.workspaceId, { lastSyncAt: Date.now(), lastError: null, report: null });
    return;
  }
  const reconcile = link.filesReconciledAt === null || link.filesReconciledAt !== link.remoteUpdatedAt;
  if (scope.recordings) await exportRecordings(config, store, link, workspace.path);
  if (!scope.reviews) store.clearReviewBase(link.projectId);
  const index = store.remoteIndex(link.projectId);
  // One listing for the round: its reviews and its documents.
  const remote = platform.storage(client, link.projectId, index);
  try {
    // Reviews first: with only reviews shared, they say which documents go with them.
    const reviews = scope.reviews
      ? await syncProjectReviews({
          root: workspace.path,
          remote,
          base: store.reviewBase(link.projectId),
          reconcile,
          runningHere: (id) => reviewRunActive(workspace.path, id),
          runner,
        })
      : null;
    const reviewed = await reviewedDocuments(scope, workspace.path);
    const attached = new Set((await calendarStore(config)).list(link.workspaceId).flatMap(item => item.attachmentPaths.map(fileKey)));
    const files = await syncProjectFiles({
      root: resolve(workspace.path),
      remote,
      base: store.fileBase(link.projectId),
      includes: (path) => scopeIncludes(scope, path, reviewed, attached),
      reconcile,
      allowDeletions: link.allowDeletions,
      label,
      maxFileBytes: PROJECT_MAX_FILE_BYTES,
    });
    for (const conflict of files.conflicts) store.addConflict(link.projectId, conflict.path, conflict.copyPath);
    const arrivedHere = files.downloaded + files.removedLocal + files.conflicts.length + (reviews ? reviews.downloaded + reviews.removedLocal : 0);
    if (arrivedHere > 0) {
      const counts = contentRevisions.get(keyOf(config)) ?? new Map<string, number>();
      counts.set(link.workspaceId, (counts.get(link.workspaceId) ?? 0) + 1);
      contentRevisions.set(keyOf(config), counts);
    }
    const moved = (result: { uploaded: number; downloaded: number; removedLocal: number; removedRemote: number } | null) =>
      result !== null && result.uploaded + result.downloaded + result.removedLocal + result.removedRemote > 0;
    const stale = files.stale || (reviews?.stale ?? false);
    // The firm had something the kept listing did not: list it whole next time.
    if (stale) index.clear();
    store.updateLink(link.workspaceId, {
      // Our own uploads move the project's time: the next round reconciles once more.
      filesReconciledAt: reconcile && !stale ? link.remoteUpdatedAt : stale ? null : link.filesReconciledAt,
      allowDeletions: files.heldDeletions > 0 ? link.allowDeletions : false,
      lastSyncAt: Date.now(),
      lastError: null,
      report: {
        pending: files.pending + (reviews?.pending ?? 0),
        skipped: files.skipped.map(({ path, reason }) => ({ path, reason })),
        heldDeletions: files.heldDeletions,
      },
    });
    if (moved(files) || moved(reviews) || files.conflicts.length > 0) scheduleProjectSync(config);
  } catch (error) {
    if (roundStopper(error)) throw error;
    if (error instanceof ApiError && error.status === 404) {
      // The firm no longer has it for us: the next pull says how (`hidden`).
      store.updateLink(link.workspaceId, { filesReconciledAt: null, lastError: messageOf(error) });
      return;
    }
    store.updateLink(link.workspaceId, { lastError: messageOf(error) });
  }
}

// --- Rounds --------------------------------------------------------------------------

/** One full round, now. Concurrent callers share the round in flight. */
export function runProjectSync(
  config: ServerConfig,
  options: { platform?: ProjectSyncPlatform } = {},
): Promise<ProjectSyncResult> {
  const key = keyOf(config);
  const inFlight = rounds.get(key);
  if (inFlight) return inFlight;
  const round = runRound(config, options.platform ?? REAL_PLATFORM).finally(() => {
    if (rounds.get(key) === round) rounds.delete(key);
  });
  rounds.set(key, round);
  return round;
}

async function runRound(config: ServerConfig, platform: ProjectSyncPlatform): Promise<ProjectSyncResult> {
  await ensureFreshPlatformToken(config).catch(() => null);
  const connection = await readEigenweltConnection(config);
  const orgId = connectedTaskOrgId(connection);
  const result: ProjectSyncResult = { ran: false, pushed: 0, pulled: 0, arrived: 0, removed: 0, error: null };
  if (orgId === null) return result;
  result.ran = true;
  const key = keyOf(config);
  const store = await projectSyncStore(config);
  try {
    const client = requireIntakeClient(connection);
    result.pushed = await pushOutbox(config, platform, client, store);
    const pull = await pullChanges(config, platform, client, store, orgId);
    result.pulled = pull.pulled;
    result.arrived = pull.arrived;
    result.removed = pull.removed;
    const runner = {
      userId: connection.account?.userId ?? "",
      name: connection.account?.userName?.trim() || connection.account?.userEmail?.trim() || null,
    };
    for (const link of store.links(orgId)) {
      if (link.state !== "active" || !link.confirmed) continue;
      if (platform === REAL_PLATFORM) {
        try { await syncProjectCalendar(config, client, link); }
        catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; /* An older platform may not have the calendar API yet. Keep the outbox and continue document sync. */ }
      }
      await syncDocuments(config, platform, client, store, link, runner);
      if (platform === REAL_PLATFORM) {
        const pendingCalendar = (await calendarStore(config)).pending(link.workspaceId).length;
        const report = store.linkByWorkspace(link.workspaceId)?.report;
        if (pendingCalendar > 0) store.updateLink(link.workspaceId, { report: { pending: (report?.pending ?? 0) + pendingCalendar, skipped: report?.skipped ?? [], heldDeletions: report?.heldDeletions ?? 0 } });
      }
    }
    roundStates.set(key, { offline: false, error: null, at: Date.now() });
    // Tasks published this round go up with the task sync (which waits for a
    // project's first upload before sending its tasks); a project that
    // arrived brings its tasks down with it.
    if (result.arrived > 0 || (await taskStore(config)).outboxSize() > 0) scheduleTaskSync(config);
  } catch (error) {
    result.error = messageOf(error);
    roundStates.set(key, { offline: unreachable(error), error: result.error, at: Date.now() });
  }
  if (platform === REAL_PLATFORM) {
    try { await syncCalendarSubscriptions(config); }
    catch (error) { result.error ??= messageOf(error); }
  }
  refreshWatchers(config, store.links(orgId));
  // What the round changed (states, files, conflicts) shows in the app now.
  announceSyncChange(config, "projects");
  return result;
}

/** A round soon, coalescing a burst of changes into one. */
export function scheduleProjectSync(config: ServerConfig, delayMs: number = CHANGE_DEBOUNCE_MS): void {
  const key = keyOf(config);
  const pending = pendingRounds.get(key);
  if (pending) clearTimeout(pending);
  const timer = setTimeout(() => {
    pendingRounds.delete(key);
    void runProjectSync(config).catch(() => undefined);
  }, delayMs);
  timer.unref?.();
  pendingRounds.set(key, timer);
}

/** Changes in a synced project's folder start a round soon, rather than waiting for the timer. */
function refreshWatchers(config: ServerConfig, links: ProjectLink[]): void {
  const key = keyOf(config);
  const current = watchers.get(key) ?? new Map<string, FSWatcher>();
  watchers.set(key, current);
  const wanted = new Map<string, string>();
  for (const link of links) {
    const workspace = link.state === "active" ? workspaceOf(config, link.workspaceId) : null;
    if (workspace) wanted.set(link.workspaceId, workspace.path);
  }
  for (const [workspaceId, watcher] of current) {
    if (wanted.has(workspaceId)) continue;
    watcher.close();
    current.delete(workspaceId);
  }
  for (const [workspaceId, path] of wanted) {
    if (current.has(workspaceId)) continue;
    try {
      const watcher = watch(path, { recursive: true }, (_event, name) => {
        // Sync's own bookkeeping and hidden files are not changes to carry; reviews are.
        const parts = String(name ?? "").split(/[\\/]/);
        if (parts[0] && !syncExcluded(parts[0])) scheduleProjectSync(config);
        else if (parts.slice(0, 3).join("/") === ".opencode/legalwork/reviews") scheduleProjectSync(config, REVIEW_DEBOUNCE_MS);
      });
      watcher.on("error", () => {
        watcher.close();
        current.delete(workspaceId);
      });
      current.set(workspaceId, watcher);
    } catch {
      // Not watchable here (a network drive, say): the timer still covers it.
    }
  }
}

/** Rounds in the background while the server is up. Returns the stop function. */
export function startProjectSyncTimer(
  config: ServerConfig,
  intervalMs: number = TIMER_INTERVAL_MS,
  firstRoundDelayMs = 4_000,
): () => void {
  const key = keyOf(config);
  const timer = setInterval(() => {
    const last = roundStates.get(key)?.at ?? 0;
    if (poked.get(key) && Date.now() - last < POKED_INTERVAL_MS) return;
    void runProjectSync(config).catch(() => undefined);
  }, intervalMs);
  timer.unref?.();
  scheduleProjectSync(config, firstRoundDelayMs);
  return () => {
    clearInterval(timer);
    const pending = pendingRounds.get(key);
    if (pending) clearTimeout(pending);
    pendingRounds.delete(key);
    for (const watcher of watchers.get(key)?.values() ?? []) watcher.close();
    watchers.delete(key);
  };
}

// --- What the app sees and does ----------------------------------------------------

async function connectedOrg(config: ServerConfig): Promise<{ orgId: string | null; userId: string | null }> {
  const connection = await readEigenweltConnection(config);
  return { orgId: connectedTaskOrgId(connection), userId: connection.account?.userId ?? null };
}

function stateOf(
  link: ProjectLink,
  available: boolean,
  connected: boolean,
  round: RoundState | undefined,
  pendingChanges: number,
): ProjectSyncState {
  if (link.state === "revoked") return "revoked";
  if (!available) return "unavailable";
  if (!connected || round?.offline) return "offline";
  if ((link.report?.heldDeletions ?? 0) > 0) return "paused";
  if (link.lastError !== null || (round?.error ?? null) !== null) return "error";
  if (pendingChanges > 0 || !link.confirmed || link.lastSyncAt === null) return "pending";
  return "synced";
}

export async function projectSyncStatus(config: ServerConfig, workspace: WorkspaceInfo): Promise<ProjectSyncStatus> {
  const store = await projectSyncStore(config);
  const { orgId, userId } = await connectedOrg(config);
  const link = store.linkByWorkspace(workspace.id);
  if (!link || (orgId !== null && link.orgId !== orgId)) {
    const offer = orgId === null ? undefined : store.pendingOffers(orgId).find((entry) => entry.workspaceId === workspace.id);
    return {
      workspaceId: workspace.id,
      connected: orgId !== null,
      mode: "local",
      role: null,
      viewerUserId: userId,
      // Whoever turns sync on here owns the project.
      ownerUserId: userId,
      settings: { access: "members", memberIds: [], scope: DEFAULT_PROJECT_SCOPE },
      state: offer ? "offered" : "local",
      lastSyncAt: null,
      error: null,
      pendingChanges: 0,
      conflicts: [],
      skipped: [],
      pausedDeletions: 0,
      ownFolder: false,
      offer: offer ? { projectId: offer.projectId, name: offer.name, ownerUserId: offer.ownerUserId } : null,
    };
  }
  const round = roundStates.get(keyOf(config));
  const conflicts = store.conflicts(link.projectId);
  const available = await folderAvailable(workspace.path);
  // A copy held back no longer syncs, so no round reports on it: count what it is held for.
  const pendingChanges =
    link.state === "revoked" && available
      ? await localChanges(config, store, link, workspace.path)
      : store.pendingOps(link.projectId).length + (link.report?.pending ?? 0);
  return {
    workspaceId: workspace.id,
    connected: orgId !== null,
    mode: "synced",
    role: link.role,
    viewerUserId: userId,
    ownerUserId: link.ownerUserId,
    settings: link.settings,
    state: stateOf(link, available, orgId !== null, round, pendingChanges),
    lastSyncAt: link.lastSyncAt === null ? null : new Date(link.lastSyncAt).toISOString(),
    error: link.lastError ?? round?.error ?? null,
    pendingChanges,
    conflicts,
    skipped: link.report?.skipped ?? [],
    pausedDeletions: link.report?.heldDeletions ?? 0,
    ownFolder: link.origin === "local" && link.role === "member",
    offer: null,
  };
}

export async function projectSyncOverview(config: ServerConfig): Promise<ProjectSyncOverview> {
  const store = await projectSyncStore(config);
  const { orgId } = await connectedOrg(config);
  const round = roundStates.get(keyOf(config));
  const states: Record<string, ProjectSyncState> = {};
  for (const link of store.links(orgId ?? undefined)) {
    const workspace = workspaceOf(config, link.workspaceId);
    if (!workspace) continue;
    const pendingChanges = store.pendingOps(link.projectId).length + (link.report?.pending ?? 0);
    states[link.workspaceId] = stateOf(
      link,
      await folderAvailable(workspace.path),
      orgId !== null,
      round,
      pendingChanges,
    );
  }
  if (orgId !== null) {
    for (const offer of store.pendingOffers(orgId)) {
      if (workspaceOf(config, offer.workspaceId)) states[offer.workspaceId] = "offered";
    }
  }
  return {
    connected: orgId !== null,
    revision: revisions.get(keyOf(config)) ?? 0,
    states,
    contents: Object.fromEntries(contentRevisions.get(keyOf(config)) ?? []),
    removed: [...(removedWorkspaces.get(keyOf(config)) ?? [])],
  };
}

/** A synced project's settings are its owner's to change; a local one's are whoever has it. */
function requireOwner(link: ProjectLink | null): void {
  if (link && link.role !== "owner") {
    throw new ApiError(403, "project_sync_not_owner", "Only the project's owner can change who sees it and what it syncs.");
  }
}

/**
 * Turn sync on for a project (its owner, on this machine), or change what it
 * syncs and who sees it. Changing the scope takes effect here at once: tasks
 * leaving the scope stay on this machine, tasks entering it go up.
 */
export async function saveProjectSyncSettings(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  settings: ProjectSyncSettings,
): Promise<ProjectSyncStatus> {
  const { orgId, userId } = await connectedOrg(config);
  if (orgId === null) {
    throw new ApiError(409, "project_sync_not_connected", "Sign in with Eigenwelt to sync this project with your firm.");
  }
  const store = await projectSyncStore(config);
  const tasks = await taskStore(config);
  const link = store.linkByWorkspace(workspace.id);
  requireOwner(link);
  if (!link && store.pendingOffers(orgId).some((offer) => offer.workspaceId === workspace.id)) {
    throw new ApiError(409, "project_sync_offer_pending", "This folder is already a project shared with you: decide first whether to use it as your copy.");
  }
  if (!link) {
    // Shared again after its owner stopped: the same project at the firm, not a second one.
    const projectId = store.takeStopped(workspace.id, orgId) ?? randomUUID();
    await setProjectSyncId(workspace.path, projectId);
    store.saveLink({
      workspaceId: workspace.id,
      projectId,
      orgId,
      origin: "local",
      role: "owner",
      ownerUserId: userId,
      settings,
      confirmed: false,
      remoteUpdatedAt: null,
      filesReconciledAt: null,
      state: "active",
      allowDeletions: false,
      lastSyncAt: null,
      lastError: null,
      report: null,
    });
    store.enqueue(projectId, { kind: "create" });
    if (settings.scope.tasks) tasks.publishProjectTasks(workspace.id);
  } else {
    store.updateLink(workspace.id, { settings, lastError: null });
    store.enqueue(link.projectId, { kind: "settings", settings: { ...settings, scope: { ...settings.scope, calendar: settings.scope.calendar !== false } } });
    if (!link.settings.scope.metadata && settings.scope.metadata && await folderAvailable(workspace.path)) {
      const details = await readProjectDetails(workspace.path);
      store.enqueue(link.projectId, { kind: "personalization", prompt: details.personalizationPrompt ?? "", changedAt: new Date().toISOString() });
    }
    if (link.settings.scope.tasks && !settings.scope.tasks) tasks.keepProjectTasksLocal(workspace.id);
    if (!link.settings.scope.tasks && settings.scope.tasks) tasks.publishProjectTasks(workspace.id);
  }
  scheduleProjectSync(config, 500);
  return projectSyncStatus(config, workspace);
}

/**
 * The owner stops syncing the project: it stays here as a local project with
 * everything in it, and leaves the firm and every colleague's computer.
 */
export async function stopProjectSync(config: ServerConfig, workspace: WorkspaceInfo): Promise<ProjectSyncStatus> {
  const store = await projectSyncStore(config);
  const link = store.linkByWorkspace(workspace.id);
  if (!link) return projectSyncStatus(config, workspace);
  requireOwner(link);
  const confirmed = link.confirmed;
  await keepAsLocal(config, store, link);
  if (confirmed) {
    store.enqueue(link.projectId, { kind: "stop" });
    store.markStopped(workspace.id, link.projectId, link.orgId);
  }
  scheduleProjectSync(config, 500);
  return projectSyncStatus(config, workspace);
}

export const projectSyncActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("keep_local") }),
  z.object({ action: z.literal("remove"), force: z.boolean().optional() }),
  z.object({ action: z.literal("delete_files") }),
  z.object({ action: z.literal("restore_files") }),
  // Both sides changed a file, and this computer's version was kept beside it as a copy:
  // keep both (the copy stays), take the firm's version (the copy goes), or keep this one
  // (it replaces the firm's, and the copy goes).
  z.object({ action: z.literal("dismiss_conflict"), copyPath: z.string().min(1).max(2048) }),
  z.object({ action: z.literal("use_theirs"), copyPath: z.string().min(1).max(2048) }),
  z.object({ action: z.literal("keep_mine"), copyPath: z.string().min(1).max(2048) }),
  z.object({ action: z.literal("use_folder") }),
  z.object({ action: z.literal("keep_apart") }),
]);
export type ProjectSyncAction = z.infer<typeof projectSyncActionSchema>;

/**
 * The member's answers to what sync could not decide alone: use their own
 * folder as their copy of a project shared with them, or keep the two apart;
 * keep a project whose access ended (as a local copy) or remove it; take this
 * computer's held-back deletions to the firm, or bring the files back; put a
 * conflict copy away.
 */
export async function resolveProjectSync(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  input: ProjectSyncAction,
): Promise<ProjectSyncStatus> {
  const store = await projectSyncStore(config);
  if (input.action === "use_folder" || input.action === "keep_apart") {
    const offer = store.pendingOffers().find((entry) => entry.workspaceId === workspace.id);
    if (!offer) throw new ApiError(404, "project_offer_not_found", "There is nothing to decide for this project.");
    store.decideOffer(offer.projectId, input.action === "use_folder" ? "use" : "separate");
    // The project was passed over when it was listed: the next pull lists everything again.
    store.setPullCursor(offer.orgId, null);
    workspacesChanged(config);
    scheduleProjectSync(config, 0);
    return projectSyncStatus(config, workspace);
  }
  const link = store.linkByWorkspace(workspace.id);
  if (!link) throw new ApiError(404, "project_not_synced", "This project does not sync.");
  switch (input.action) {
    case "keep_local":
      await keepAsLocal(config, store, link);
      break;
    case "remove": {
      const changes = (await folderAvailable(workspace.path)) ? await localChanges(config, store, link, workspace.path) : 0;
      if (changes > 0 && input.force !== true) {
        throw new ApiError(409, "project_changes_pending", `${changes} change(s) made on this computer have not reached the firm yet.`, {
          pending: changes,
        });
      }
      if (link.state !== "revoked") store.markRemoved(link.projectId, link.orgId);
      // Shared with them again later, they are asked again.
      store.dropOffer(link.projectId);
      await removeCopy(config, store, link);
      break;
    }
    case "delete_files":
      store.updateLink(workspace.id, { allowDeletions: true });
      break;
    case "restore_files": {
      // Files missing here are no longer "deleted here": the next reconcile
      // finds them only at the firm, and brings them back.
      const base = store.fileBase(link.projectId);
      for (const [key, entry] of base.entries()) {
        const present = await stat(join(workspace.path, ...entry.path.split("/"))).catch(() => null);
        if (!present) base.drop(key);
      }
      store.updateLink(workspace.id, {
        filesReconciledAt: null,
        allowDeletions: false,
        report: link.report && { ...link.report, heldDeletions: 0 },
      });
      break;
    }
    case "dismiss_conflict":
      store.dismissConflict(link.projectId, input.copyPath);
      break;
    case "use_theirs":
    case "keep_mine": {
      // The paths come from the conflict as sync recorded it, never from the request.
      const conflict = store.conflicts(link.projectId).find((entry) => entry.copyPath === input.copyPath);
      if (!conflict) throw new ApiError(404, "project_conflict_not_found", "There is no such conflicting copy.");
      const root = resolve(workspace.path);
      const copy = join(root, ...conflict.copyPath.split("/"));
      const present = await stat(copy).catch(() => null);
      if (input.action === "keep_mine") {
        if (!present) throw new ApiError(409, "project_conflict_copy_missing", "Your version is no longer there.");
        // An edit here like any other: the next round takes it to the firm.
        await copyFile(copy, join(root, ...conflict.path.split("/")));
      }
      // Recoverable for a while, like everything sync removes; the next round removes it at the firm too.
      if (present) await moveToSyncTrash(root, conflict.copyPath);
      store.dismissConflict(link.projectId, conflict.copyPath);
      break;
    }
  }
  scheduleProjectSync(config, 500);
  return projectSyncStatus(config, workspace);
}

// --- Local edits the firm has to hear about -----------------------------------------------

export async function noteProjectPersonalizationSaved(config: ServerConfig, workspaceId: string, before: string, after: string): Promise<void> {
  if (before === after) return;
  const store = await projectSyncStore(config);
  const link = store.linkByWorkspace(workspaceId);
  if (!link || link.state !== "active" || !link.settings.scope.metadata) return;
  store.enqueue(link.projectId, { kind: "personalization", prompt: after, changedAt: new Date().toISOString() });
  scheduleProjectSync(config);
}

export async function noteProjectDetailsSaved(
  config: ServerConfig,
  workspaceId: string,
  before: ProjectField[],
  after: ProjectField[],
): Promise<void> {
  const store = await projectSyncStore(config);
  const link = store.linkByWorkspace(workspaceId);
  if (!link || link.state !== "active" || !link.settings.scope.metadata) return;
  const { changes, order } = diffFields(before, after);
  if (changes.length === 0 && order === null) return;
  store.enqueue(link.projectId, { kind: "fields", changes, order, changedAt: new Date().toISOString() });
  scheduleProjectSync(config);
}

export async function noteProjectRenamed(config: ServerConfig, workspaceId: string, name: string): Promise<void> {
  workspacesChanged(config);
  const store = await projectSyncStore(config);
  const link = store.linkByWorkspace(workspaceId);
  if (!link || link.state !== "active") return;
  store.enqueue(link.projectId, { kind: "rename", name, changedAt: new Date().toISOString() });
  scheduleProjectSync(config);
}

/** Removed from the project list here: it stops syncing here, and a pull does not bring it back. */
export async function noteProjectRemoved(config: ServerConfig, workspaceId: string): Promise<void> {
  const store = await projectSyncStore(config);
  const link = store.linkByWorkspace(workspaceId);
  if (!link) return;
  store.markRemoved(link.projectId, link.orgId);
  store.discardOutbox(link.projectId);
  store.removeLink(workspaceId);
}

// --- Sign-out -------------------------------------------------------------------------------

export type ProjectSignOutResult = { ok: true; removed: number } | { ok: false; pending: number };

/**
 * What signing out means for synced projects: one last round, then the copies
 * that came from the firm leave this machine. The member's own projects stay,
 * with everything in them, and pick up where they were when the member signs
 * in to the same firm again (their tasks leave with the firm's tasks, and
 * come back then). Changes to a copy that still could not reach the firm
 * stop the sign-out unless `force` says otherwise.
 */
export async function signOutOfFirmProjects(
  config: ServerConfig,
  options: { force?: boolean; platform?: ProjectSyncPlatform; apply?: boolean } = {},
): Promise<ProjectSignOutResult> {
  const { orgId } = await connectedOrg(config);
  if (orgId === null) return { ok: true, removed: 0 };
  await runProjectSync(config, { platform: options.platform }).catch(() => undefined);
  const store = await projectSyncStore(config);
  const copies = store.links(orgId).filter((link) => link.origin === "remote");
  let pending = 0;
  for (const link of copies) {
    const workspace = workspaceOf(config, link.workspaceId);
    if (workspace && (await folderAvailable(workspace.path))) pending += await localChanges(config, store, link, workspace.path);
  }
  if (pending > 0 && !options.force) return { ok: false, pending };
  // Checked only: the caller has more to check before anything leaves.
  if (options.apply === false) return { ok: true, removed: 0 };
  for (const link of copies) await removeCopy(config, store, link);
  store.forgetOrg(orgId);
  workspacesChanged(config);
  return { ok: true, removed: copies.length };
}

export async function noteProjectFoldersChanged(config: ServerConfig, workspaceId: string): Promise<void> {
  const store = await projectSyncStore(config);
  const link = store.linkByWorkspace(workspaceId);
  const workspace = workspaceOf(config, workspaceId);
  if (!link || link.state !== "active" || !workspace) return;
  const details = await readProjectDetails(workspace.path);
  if (!details.remote) return;
  store.enqueue(link.projectId, { kind: "remote", remote: details.remote, changedAt: new Date().toISOString() });
  scheduleProjectSync(config);
}
