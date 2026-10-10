import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { runtimeDbPath } from "../runtime-db.js";
import { MANAGED_ENGINE_DB_FILENAME } from "../managed-opencode-db.js";
import type { ServerConfig } from "../types.js";
import type { StorageAdapter } from "../file-storage/common.js";
import { globalSkillsDir } from "../workspace-files.js";
import { ControlSchema, CheckpointSchema, SyncConfigSchema, ProjectSchema, emptyControl, type CloudSyncConfig } from "./schema.js";
import { getBlob, isConflict, putBlob, type SyncObjects } from "./objects.js";
import { ReplicaResources } from "./files.js";
import { PlatformObjects, resourceStorage } from "./platform.js";
import { projectSyncStore } from "../project-sync-store.js";
import { DEFAULT_PROJECT_SCOPE, runProjectSync, saveProjectSyncSettings, scopeIncludes, type ProjectSyncResult } from "../project-sync.js";
import { syncBatches } from "../sync-batches.js";
import { reviewDocumentKeys, syncProjectReviews, REVIEW_SYNC_PREFIX } from "../project-review-sync.js";
import { reviewRunActive } from "../reviews/service.js";
import { fileKey } from "../project-file-sync.js";
import { calendarStore } from "../calendar/store.js";
import { persistServerWorkspaceState } from "../routes/workspaces.js";
import { readProjectDetails, restoreProjectDetails, setProjectSyncId } from "../project-store.js";
import { syncPreferences } from "./settings.js";
import { exportCheckpoint, nextScheduledRun, recoverCheckpointRestore, restoreCheckpoint } from "./state.js";

const CatalogSchema = z.array(ProjectSchema).max(5000);
const DeviceSchema = z.object({ checkpoint: z.string().nullable().default(null), timeZone: z.string().optional() });

export class CloudReplica {
  private owner: string;
  private epoch: number | null = null;
  private expiresAt = 0;
  private stopped = false;
  private round: Promise<unknown> | null = null;
  private syncError: string | null = null;
  private materializing = new Map<string, Promise<unknown>>();
  private devicePath: string;
  private checkpointHash: string | null = null;
  private requestedProjects = new Set<string>();
  private quiescing = false;
  private checkpointed = false;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private renewing: Promise<void> | null = null;
  private renewalGeneration = 0;
  private engineWrites = 0;
  private drained: Array<() => void> = [];
  private constructor(private config: ServerConfig, readonly settings: CloudSyncConfig, readonly objects: SyncObjects,
    private files: ReplicaResources, private now: () => number) {
    this.owner = `${settings.deviceId.slice(0, 80)}_${randomUUID().replaceAll("-", "")}`;
    this.devicePath = join(dirname(runtimeDbPath(config)), "cloud-sync-device.json");
  }
  static async open(config: ServerConfig, settings: CloudSyncConfig, objects?: SyncObjects, now = Date.now) {
    settings = SyncConfigSchema.parse(settings);
    const store = objects ?? await PlatformObjects.open(config, settings.accountId);
    const root = dirname(runtimeDbPath(config));
    await mkdir(root, { recursive: true });
    const files = new ReplicaResources(await projectSyncStore(config), settings.deviceId);
    const replica = new CloudReplica(config, settings, store, files, now);
    if (settings.role === "executor" && existsSync(replica.devicePath)) {
      const device = DeviceSchema.parse(JSON.parse(await readFile(replica.devicePath, "utf8")));
      replica.checkpointHash = device.checkpoint;
      if (device.timeZone) process.env.TZ = device.timeZone;
    }
    config.cloudSync = { role: settings.role, canExecute: replica.canExecute, prepareWorkspace: id => replica.prepareWorkspace(id),
      shouldSyncFiles: id => settings.role !== "executor" || replica.requestedProjects.has(id) || files.isHydrated(`project:${id}`, config.workspaces.find(workspace => workspace.id === id)?.path ?? ""),
      deviceName: settings.deviceName };
    config.cloudSync.maintainsProject = id => !settings.projectIds.length || settings.projectIds.includes(id);
    config.cloudSync.checkpoint = async () => {
      await replica.tick(true);
      replica.checkpointed = true;
      // Never freeze a lease request/socket into a reusable VM snapshot.
      await replica.renewing;
      return { checkpointAt: (await replica.control()).value.checkpointAt };
    };
    config.cloudSync.runEngineRequest = execute => {
      if (!replica.canExecute()) throw new ApiError(409, "sync_execution_owner", "The execution owner is paused or unavailable.");
      replica.engineWrites++;
      return Promise.resolve().then(execute).finally(() => {
        if (--replica.engineWrites === 0) for (const resolve of replica.drained.splice(0)) resolve();
      });
    };
    config.cloudSync.beginCheckpoint = async () => {
      replica.quiescing = true; replica.checkpointed = false;
      if (replica.engineWrites) await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          replica.drained = replica.drained.filter(waiter => waiter !== ready);
          replica.quiescing = false;
          reject(new ApiError(409, "sync_assistant_busy", "Wait for the active engine request to finish before pausing its VM."));
        }, 10000);
        timer.unref();
        replica.drained.push(ready);
      });
      return () => { replica.quiescing = false; replica.checkpointed = false; };
    };
    const resume = async () => {
      // Provider suspension can freeze sockets independently of checkpointing.
      // Fence old callbacks, then require fresh control/CAS ownership proof.
      // Their eventual success or failure must not change the resumed lease.
      replica.renewalGeneration++;
      replica.renewing = null;
      if (!replica.hasLease()) {
        const current = await replica.control();
        if (current.value.owner !== replica.owner || current.value.checkpoint?.sha256 !== replica.checkpointHash)
          throw new ApiError(409, "sync_lease_lost", "Another VM has taken ownership. Stop this VM and restore the latest checkpoint offline.");
        await replica.acquire();
      } else await replica.renew();
      // bootCloudSync prepared the assistant before exposing the server. A
      // checkpoint retains those files and settings; re-listing every resource
      // on each message blocks execution for seconds even on a warm VM.
      // Ownership is renewed above; incremental refresh follows in the normal
      // background round and individual project hydration still gates its use.
      replica.quiescing = false; replica.checkpointed = false;
      void replica.tick().catch(() => {});
      return { role: settings.role, canExecute: replica.canExecute(), nextRunAt: await nextScheduledRun(config) };
    };
    config.cloudSync.resume = resume;
    config.cloudSync.ready = async () => {
      // Normal execution already relies on this bounded local lease, renewed
      // by the heartbeat and fenced at expiry. A warm request need not repeat
      // its remote read/CAS. Checkpointed, expired or near-expiry guests always
      // run the same fresh resume proof, including stale-renewal fencing.
      if (settings.role !== "executor" || replica.checkpointed || !replica.canExecute() ||
        replica.expiresAt - replica.now() <= Math.floor(settings.leaseMs / 3)) return resume();
      const nextRunAt = await nextScheduledRun(config);
      return { role: settings.role, canExecute: replica.canExecute(), nextRunAt };
    };
    config.cloudSync.status = async () => { const { value } = await replica.control(); return { role: settings.role, canExecute: replica.canExecute(), checkpointAt: value.checkpointAt, nextRunAt: value.nextRunAt }; };
    return replica;
  }
  async control() {
    const object = await this.objects.get("control.json");
    return { value: object ? ControlSchema.parse(JSON.parse(object.data.toString())) : emptyControl, revision: object?.revision ?? null };
  }
  private hasLease = () => !this.stopped && this.epoch !== null && this.expiresAt > this.now();
  canExecute = () => !this.stopped && !this.quiescing && (this.settings.role === "companion" || this.hasLease());
  private armExpiry() {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      if (!this.hasLease() && !this.quiescing) this.config.cloudSync?.onLeaseLost?.();
    }, Math.max(1, this.expiresAt - this.now()));
    this.leaseTimer.unref();
  }
  async acquire() {
    if (this.settings.role !== "executor") throw new ApiError(409, "sync_files_only", "This device syncs files; the copied assistant runs on its execution owner.");
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.control();
      if (current.value.owner !== null && current.value.owner !== this.owner && current.value.expiresAt > this.now()) {
        throw new ApiError(409, "sync_executor_busy", "Another device is running the assistant. Release it before handing over.");
      }
      const value = { ...current.value, owner: this.owner, epoch: current.value.owner === this.owner && current.value.expiresAt > this.now() ? current.value.epoch : current.value.epoch + 1,
        expiresAt: this.now() + this.settings.leaseMs };
      try {
        await this.objects.put("control.json", Buffer.from(JSON.stringify(value)), current.revision);
        this.epoch = value.epoch; this.expiresAt = value.expiresAt; this.armExpiry();
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => {
            if (this.checkpointed || this.quiescing && !this.hasLease()) return;
            void this.renew().catch(error => console.warn("[cloud-sync] lease renewal failed:", error instanceof Error ? error.message : "unavailable"));
          }, Math.floor(this.settings.leaseMs / 3));
          this.heartbeat.unref();
        }
        return;
      } catch (error) { if (!isConflict(error)) throw error; }
    }
    throw new Error("Could not acquire assistant execution ownership");
  }
  async renew() {
    if (this.renewing) return this.renewing;
    const pending = this.renewOnce(this.renewalGeneration);
    this.renewing = pending;
    try { await pending; } finally { if (this.renewing === pending) this.renewing = null; }
  }
  private assertRenewal(generation: number) {
    if (generation !== this.renewalGeneration)
      throw new ApiError(409, "sync_renewal_superseded", "A resumed worker replaced this lease renewal.");
  }
  private async renewOnce(generation: number) {
    for (let attempt = 0; attempt < 8; attempt++) {
      this.assertRenewal(generation);
      const current = await this.control();
      this.assertRenewal(generation);
      if (this.epoch === null || current.value.owner !== this.owner || current.value.epoch !== this.epoch || current.value.expiresAt <= this.now()) {
        this.expiresAt = 0;
        // Lease expiry is expected during a checkpointed VM pause. Execution
        // stays blocked until resume verifies the owner and checkpoint again.
        if (!this.quiescing || current.value.owner !== this.owner || current.value.epoch !== this.epoch)
          this.config.cloudSync?.onLeaseLost?.();
        throw new ApiError(409, "sync_lease_lost", "Assistant execution ownership changed; this device must stop.");
      }
      const expiresAt = this.now() + this.settings.leaseMs;
      try {
        await this.objects.put("control.json", Buffer.from(JSON.stringify({ ...current.value, expiresAt })), current.revision);
        this.assertRenewal(generation);
        this.expiresAt = expiresAt; this.armExpiry(); return;
      } catch (error) { if (!isConflict(error)) throw error; }
    }
    throw new Error("Could not renew assistant execution ownership");
  }
  async publishState() {
    if (!this.hasLease()) throw new ApiError(409, "sync_no_lease", "Acquire execution ownership before publishing sessions.");
    const checkpoint = await exportCheckpoint(this.config, this.objects);
    const reference = await putBlob(this.objects, Buffer.from(JSON.stringify(checkpoint)));
    // Ownership and checkpoint share ONE conditional object, so an old VM
    // cannot overwrite state after a handoff even if its upload finishes later.
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.control();
      if (current.value.owner !== this.owner || current.value.epoch !== this.epoch || current.value.expiresAt <= this.now())
        throw new ApiError(409, "sync_lease_lost", "The checkpoint belongs to an expired execution owner.");
      try {
        await this.objects.put("control.json", Buffer.from(JSON.stringify({ ...current.value, checkpoint: reference,
          checkpointAt: this.now(), nextRunAt: await nextScheduledRun(this.config) })), current.revision);
        await this.rememberCheckpoint(reference.sha256);
        return checkpoint;
      } catch (error) { if (!isConflict(error)) throw error; }
    }
    throw new Error("Could not publish assistant checkpoint");
  }
  /** One-time seed: a desktop must never replace an existing cloud checkpoint. */
  async seedCompanion() {
    if (this.settings.role !== "companion") throw new ApiError(409, "sync_companion_required", "Use a companion desktop to create the cloud copy.");
    const current = await this.control();
    if (current.value.checkpoint) return false;
    if (current.value.owner) throw new ApiError(409, "sync_executor_busy", "Cloud setup is already in progress.");
    const checkpoint = await exportCheckpoint(this.config, this.objects, { companionSeed: true });
    const reference = await putBlob(this.objects, Buffer.from(JSON.stringify(checkpoint)));
    await this.objects.put("control.json", Buffer.from(JSON.stringify({ ...current.value, checkpoint: reference,
      checkpointAt: this.now(), nextRunAt: null })), current.revision);
    return true;
  }
  private async rememberCheckpoint(sha256: string) {
    await writeFile(this.devicePath, JSON.stringify({ checkpoint: sha256, timeZone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone }), { mode: 0o600 });
    this.checkpointHash = sha256;
  }
  async restore(replace = false) {
    if (!this.canExecute()) throw new ApiError(409, "sync_no_lease", "Acquire execution ownership before restoring sessions.");
    const recovered = await recoverCheckpointRestore(this.config);
    const current = await this.control(), reference = current.value.checkpoint;
    if (!reference) return recovered;
    const path = join(dirname(runtimeDbPath(this.config)), "cloud-sync-checkpoint.json");
    await getBlob(this.objects, reference, path);
    const checkpoint = CheckpointSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const complete = (!checkpoint.runtime || existsSync(runtimeDbPath(this.config))) &&
      (!checkpoint.engine || existsSync(join(dirname(runtimeDbPath(this.config)), MANAGED_ENGINE_DB_FILENAME)));
    if (!recovered && reference.sha256 === this.checkpointHash && complete) return false;
    await restoreCheckpoint(this.config, this.objects, checkpoint, this.settings.projectsDirectory ?? join(dirname(runtimeDbPath(this.config)), "projects"), replace || recovered || reference.sha256 === this.checkpointHash && !complete);
    await this.rememberCheckpoint(reference.sha256);
    return true;
  }
  async release() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    await this.renewing?.catch(() => {});
    const current = await this.control();
    if (current.value.owner === this.owner && current.value.epoch === this.epoch) {
      await this.objects.put("control.json", Buffer.from(JSON.stringify({ ...current.value, owner: null, expiresAt: 0 })), current.revision);
    }
    this.expiresAt = 0; this.epoch = null;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
  }
  private async catalog() {
    const object = await this.objects.get("catalog.json");
    return { value: object ? CatalogSchema.parse(JSON.parse(object.data.toString())) : [], revision: object?.revision ?? null };
  }
  async syncCatalog() {
    if (this.settings.role !== "files") await this.importCatalog();
    {
      const links = await projectSyncStore(this.config);
      for (const workspace of this.config.workspaces.filter(workspace => workspace.workspaceType !== "remote" &&
        (!this.settings.projectIds.length || this.settings.projectIds.includes(workspace.id)))) {
        if (!links.linkByWorkspace(workspace.id)) await saveProjectSyncSettings(this.config, workspace,
          { access: "members", memberIds: [], scope: { ...DEFAULT_PROJECT_SCOPE, recordings: true } });
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await this.catalog(), projects = new Map(current.value.map(project => [project.id, project]));
        for (const workspace of this.config.workspaces.filter(workspace => workspace.workspaceType !== "remote")) {
          const link = links.linkByWorkspace(workspace.id);
          if (link) projects.set(workspace.id, ProjectSchema.parse({ id: workspace.id, name: workspace.name, preset: workspace.preset, sourcePath: workspace.path, projectId: link.projectId,
            details: existsSync(workspace.path) ? await readProjectDetails(workspace.path) : undefined,
            filesReady: this.settings.role === "executor" ? projects.get(workspace.id)?.filesReady : this.files.isHydrated(`project:${workspace.id}`, workspace.path) }));
        }
        const data = Buffer.from(JSON.stringify([...projects.values()]));
        if (JSON.stringify(current.value) === data.toString()) return;
        try { await this.objects.put("catalog.json", data, current.revision); return; }
        catch (error) { if (!isConflict(error)) throw error; }
      }
      throw new Error("Project catalog changed too often; retry sync");
    }
  }
  private async importCatalog() {
    const current = await this.catalog();
    for (const project of current.value) {
      if (this.config.workspaces.some(workspace => workspace.id === project.id)) continue;
      this.config.workspaces.push({ id: project.id, name: project.name, preset: project.preset,
        path: join(this.settings.projectsDirectory ?? join(dirname(runtimeDbPath(this.config)), "projects"), project.id), workspaceType: "local" });
      const root = this.config.workspaces.at(-1)!.path;
      await mkdir(root, { recursive: true });
      if (!this.config.authorizedRoots.includes(root)) this.config.authorizedRoots.push(root);
      if (project.details) await restoreProjectDetails(root, project.details);
      if (project.projectId) await setProjectSyncId(root, project.projectId);
    }
    await persistServerWorkspaceState(this.config);
  }
  private async publishProjectReady(projectId: string) {
    if (this.settings.role === "executor") return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.catalog();
      const project = current.value.find(project => project.id === projectId);
      if (!project || project.filesReady === true) return;
      const value = current.value.map(project => project.id === projectId ? { ...project, filesReady: true } : project);
      try { await this.objects.put("catalog.json", Buffer.from(JSON.stringify(value)), current.revision); return; }
      catch (error) { if (!isConflict(error)) throw error; }
    }
    throw new Error("Project availability changed too often; retry sync");
  }
  private async initializeProject(projectId: string, allowDeletions: boolean) {
    const workspace = this.config.workspaces.find(workspace => workspace.id === projectId && workspace.workspaceType !== "remote");
    if (!workspace) throw new ApiError(404, "sync_project_missing", "This project is not registered on this replica.");
    if (this.settings.role === "executor" && (await this.catalog()).value.find(project => project.id === projectId)?.filesReady === false)
      throw new ApiError(409, "sync_project_pending", "This project's initial files are still syncing from the desktop. Try again shortly.");
    this.requestedProjects.add(projectId);
    const store = await projectSyncStore(this.config), link = store.linkByWorkspace(projectId);
    if (this.settings.role === "executor" && this.files.initialize(`project:${projectId}`, workspace.path)) {
      if (link) { store.clearFileBase(link.projectId); store.clearReviewBase(link.projectId); store.clearReviewBase(`private:${link.projectId}`); store.updateLink(projectId, { filesReconciledAt: null }); }
      await mkdir(workspace.path, { recursive: true });
    }
    if (link && allowDeletions) store.updateLink(projectId, { allowDeletions: true });
    return workspace;
  }
  async prepareWorkspace(projectId: string, allowDeletions = false, refresh = false, batch?: Promise<ProjectSyncResult>, privateResources?: StorageAdapter) {
    const workspace = this.config.workspaces.find(workspace => workspace.id === projectId && workspace.workspaceType !== "remote");
    if (!workspace) throw new ApiError(404, "sync_project_missing", "This project is not registered on this replica.");
    // A refresh of an already available project must not block new engine
    // requests. Only first hydration requires the materialization barrier.
    if (!refresh && this.files.isHydrated(`project:${projectId}`, workspace.path)) return;
    const pending = this.materializing.get(projectId);
    if (pending) return pending;
    const operation = (async () => {
      if (!batch) await this.initializeProject(projectId, allowDeletions);
      const store = await projectSyncStore(this.config);
      const requestedAt = Date.now();
      let result = await (batch ?? runProjectSync(this.config, { workspaceIds: [projectId] }));
      if (!result.ran || result.error) throw new ApiError(503, "sync_project_unavailable", result.error ?? "Connect Eigenwelt before syncing projects.");
      // An existing targeted round can have passed this project before it was requested.
      const passed = store.linkByWorkspace(projectId);
      if (!batch && (!passed?.lastSyncAt || passed.lastSyncAt < requestedAt || passed.filesReconciledAt === null))
        result = await runProjectSync(this.config, { workspaceIds: [projectId] });
      if (!result.ran || result.error) throw new ApiError(503, "sync_project_unavailable", result.error ?? "Project sync is unavailable.");
      const updated = store.linkByWorkspace(projectId);
      const scope = updated?.settings.scope;
      const filesEnabled = scope && (scope.documents || scope.notes || scope.recordings || scope.reviews || scope.calendar !== false);
      if (!updated?.confirmed || filesEnabled && updated.filesReconciledAt === null || updated.lastError || (updated.report?.pending ?? 0) > 0) {
        throw new ApiError(409, "sync_project_pending", updated?.lastError ?? "This project still has pending file changes. Retry after sync finishes.");
      }
      if (this.objects instanceof PlatformObjects) {
        // These directories occupy disjoint prefixes in the same private project.
        // Share its listing for this project round; each write still uses the
        // platform's version condition. A new round obtains a fresh listing.
        const resources = privateResources ?? await this.objects.adapter();
        if (scope && !scope.reviews) {
          const reviews = await syncProjectReviews({ root: workspace.path,
            remote: resourceStorage(resources, `resources/${projectId}/reviews`, REVIEW_SYNC_PREFIX),
            base: store.reviewBase(`private:${updated.projectId}`), reconcile: true,
            runner: { userId: updated.ownerUserId ?? this.settings.deviceId, name: this.settings.deviceName }, runningHere: id => reviewRunActive(workspace.path, id) });
          if (reviews.pending || reviews.stale) throw new ApiError(409, "sync_resource_pending", "Private reviews still have pending changes.");
        }
        // Files excluded from team sharing still belong to the owner's VM.
        const reviewed = scope?.reviews && !scope.documents ? await reviewDocumentKeys(workspace.path) : undefined;
        const attached = new Set((await calendarStore(this.config)).list(projectId).flatMap(item => item.attachmentPaths.map(fileKey)));
        const privateFiles = await this.files.sync(resourceStorage(resources, `resources/${projectId}/private-files`), `${projectId}:private-files`, workspace.path,
          this.settings.deviceName, allowDeletions, path => !/^opencode\.jsonc?$/i.test(path) && !!scope && !scopeIncludes(scope, path, reviewed, attached));
        if (privateFiles.pending || privateFiles.stale) throw new ApiError(409, "sync_resource_pending", "Private project files still have pending changes.");
        const directories = [["skills", ".opencode/skills"], ["claude-skills", ".claude/skills"], ["commands", ".opencode/commands"],
          ["agents", ".opencode/agents"], ["inbox", ".opencode/legalwork/inbox"], ["outbox", ".opencode/legalwork/outbox"]];
        for (const [scope, subdirectory] of directories) {
          const root = join(workspace.path, subdirectory);
          if (this.settings.role !== "executor" && !existsSync(root)) continue;
          const result = await this.files.sync(resourceStorage(resources, `resources/${projectId}/${scope}`), `${projectId}:${scope}`, root, this.settings.deviceName, allowDeletions);
          if (result.pending || result.stale) throw new ApiError(409, "sync_resource_pending", "Project skills still have pending changes.");
        }
      }
      this.files.markHydrated(`project:${projectId}`, workspace.path);
      await this.publishProjectReady(projectId);
      return updated.report;
    })();
    this.materializing.set(projectId, operation);
    try { return await operation; } finally { this.materializing.delete(projectId); }
  }
  async syncFiles(allowDeletions = false, priorityProjects?: readonly string[], startup = false) {
    await this.syncCatalog();
    const selected = priorityProjects ?? (this.settings.projectIds.length ? this.settings.projectIds : this.settings.role !== "executor"
      ? this.config.workspaces.filter(workspace => workspace.workspaceType !== "remote").map(workspace => workspace.id)
      : this.config.workspaces.filter(workspace => workspace.preset === "main-assistant" || this.files.isHydrated(`project:${workspace.id}`, workspace.path)).map(workspace => workspace.id));
    for (const id of selected) await this.initializeProject(id, allowDeletions);
    const requestedAt = Date.now();
    const batch = (selected.length ? runProjectSync(this.config, { workspaceIds: selected }) :
      Promise.resolve<ProjectSyncResult>({ ran: false, pushed: 0, pulled: 0, arrived: 0, removed: 0, error: null })).then(async result => {
      if (!result.ran || result.error) return result;
      const store = await projectSyncStore(this.config);
      const missed = selected.filter(id => (store.linkByWorkspace(id)?.lastSyncAt ?? 0) < requestedAt);
      return missed.length ? runProjectSync(this.config, { workspaceIds: missed }) : result;
    });
    let failed = false;
    const privateResources = this.objects instanceof PlatformObjects ? await this.objects.adapter() : undefined;
    const results = await syncBatches(selected, 2, async id => {
      try { return { projectId: id, result: await this.prepareWorkspace(id, allowDeletions, true, batch, privateResources) }; }
      catch (error) { failed = true; return { projectId: id, error }; }
    });
    // Even an empty project selection must drain its metadata round.
    const outcome = await batch;
    if (selected.length && (!outcome.ran || outcome.error)) throw new ApiError(503, "sync_project_unavailable", outcome.error ?? "Project sync is unavailable.");
    if (this.settings.role !== "executor") await this.syncCatalog();
    // Global skills are needed at startup; bulk task attachments follow in the background.
    const roots = [["global-skills", globalSkillsDir()], ...(!startup ? [["task-attachments", join(dirname(runtimeDbPath(this.config)), "task-attachments")]] : [])];
    for (const [id, root] of roots) {
      if (privateResources && (this.settings.role === "executor" || existsSync(root))) {
        const result = await this.files.sync(resourceStorage(privateResources, `resources/${id}`), id, root, this.settings.deviceName, allowDeletions);
        if (result.pending || result.stale) throw new ApiError(409, "sync_resource_pending", "Private resources still have pending changes.");
      }
    }
    if (failed) throw new ApiError(409, "sync_project_pending", "Some project files are still syncing. Other projects remain available; sync will retry automatically.");
    return results;
  }
  /** Publish the assistant's dependencies first. Other projects never block VM creation. */
  async prepareAssistant() {
    const projects = this.config.workspaces.filter(workspace => workspace.preset === "main-assistant" && workspace.workspaceType !== "remote" &&
      (!this.settings.projectIds.length || this.settings.projectIds.includes(workspace.id))).map(workspace => workspace.id);
    await this.syncFiles(false, projects, true);
    await this.syncPreferences();
  }
  syncStatus() {
    return { running: this.round !== null, error: this.syncError, pendingProjects: this.config.workspaces.filter(workspace => workspace.workspaceType !== "remote" &&
      (!this.settings.projectIds.length || this.settings.projectIds.includes(workspace.id)) && !this.files.isHydrated(`project:${workspace.id}`, workspace.path)).length };
  }
  async tick(checkpoint = false) {
    if (this.stopped || this.quiescing && !checkpoint) return;
    if (this.round) return this.round;
    this.round = (async () => {
      if (this.settings.role === "executor") await this.renew();
      const files = await this.syncFiles();
      await syncPreferences(this.config, this.objects);
      if (this.settings.role === "executor") await this.publishState();
      return files;
    })();
    try { const result = await this.round; this.syncError = null; return result; }
    catch (error) { this.syncError = "Some files could not sync. Sync will retry automatically."; throw error; }
    finally { this.round = null; }
  }
  syncPreferences() { return syncPreferences(this.config, this.objects); }
  start(immediate = false) {
    const run = () => { void this.tick().catch(error => console.warn("[cloud-sync]", error instanceof Error ? error.message : "Sync failed")); };
    const timer = setInterval(run, this.settings.intervalMs);
    if (immediate) run();
    timer.unref();
    return async () => {
      clearInterval(timer); this.stopped = true;
      if (this.heartbeat) clearInterval(this.heartbeat);
      if (this.leaseTimer) clearTimeout(this.leaseTimer);
      await this.round?.catch(() => {});
      await Promise.allSettled(this.materializing.values());
      if (this.epoch !== null) await this.release();
      this.objects.close?.();
    };
  }
  close() { this.stopped = true; if (this.heartbeat) clearInterval(this.heartbeat); if (this.leaseTimer) clearTimeout(this.leaseTimer); this.objects.close?.(); }
}

export async function readCloudSyncConfig(path: string) { return SyncConfigSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
