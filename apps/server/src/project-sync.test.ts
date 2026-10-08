import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectField, ProjectSyncSettings } from "@legalwork/types/workspace";

import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import type { IntakeClient } from "./eigenwelt-intake.js";
import type { RemoteProject } from "./eigenwelt-projects.js";
import { ApiError } from "./errors.js";
import { checkCondition, conflict, entry, type StorageAdapter } from "./file-storage/common.js";
import { readProjectDetails, updateProjectDetails, updateProjectPersonalization, updateProjectRemote } from "./project-store.js";
import { projectSyncStore } from "./project-sync-store.js";
import {
  diffFields,
  noteProjectDetailsSaved,
  noteProjectPersonalizationSaved,
  noteProjectFoldersChanged,
  noteProjectRenamed,
  projectSyncOverview,
  projectSyncStatus,
  resolveProjectSync,
  runProjectSync,
  saveProjectSyncSettings,
  stopProjectSync,
  type ProjectSyncPlatform,
} from "./project-sync.js";
import { ReviewStore } from "./reviews/storage.js";
import { registerLocalProject } from "./routes/workspaces.js";
import { taskStore } from "./task-store.js";
import type { RecorderBridge, ServerConfig, WorkspaceInfo } from "./types.js";

const ORG = "org_kanzlei";
const cleanups: Array<() => Promise<void>> = [];
const originalPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const originalRuntimeDb = process.env.LEGALWORK_RUNTIME_DB;

beforeAll(() => {
  process.env.EIGENWELT_PLATFORM_URL = "https://platform.test";
  // Each machine keeps its runtime DB beside its own config.
  delete process.env.LEGALWORK_RUNTIME_DB;
});
afterAll(() => {
  if (originalPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = originalPlatformUrl;
  if (originalRuntimeDb !== undefined) process.env.LEGALWORK_RUNTIME_DB = originalRuntimeDb;
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const ALL = { documents: true, notes: true, tasks: true, recordings: false, metadata: true, reviews: true };

/**
 * The firm's platform, in memory: who sees which project, as the real access
 * rule has it (owner, listed members, or everyone for `org`), and each
 * project's documents with their sha256 as version.
 */
function fakeFirm() {
  let clock = Date.parse("2026-09-25T08:00:00.000Z");
  const tick = () => new Date((clock += 1000)).toISOString();
  type Stored = {
    record: Omit<RemoteProject, "role">;
    deleted: boolean;
    personalizationAt: string | null;
    files: Map<string, { path: string; bytes: Buffer }>;
  };
  const projects = new Map<string, Stored>();
  const userOf = (client: IntakeClient) => client.platformToken.replace(/^tok_/, "");
  const visible = (stored: Stored, userId: string) =>
    !stored.deleted &&
    (stored.record.access === "org" || stored.record.ownerUserId === userId || stored.record.memberIds.includes(userId));
  const wire = (stored: Stored, userId: string): RemoteProject => ({
    ...stored.record,
    fields: stored.record.scope.metadata ? stored.record.fields : [],
    personalizationPrompt: stored.record.scope.metadata ? stored.record.personalizationPrompt ?? null : null,
    role: stored.record.ownerUserId === userId ? "owner" : "member",
  });
  const lookup = (client: IntakeClient, id: string) => {
    const stored = projects.get(id);
    if (!stored || !visible(stored, userOf(client))) throw new ApiError(404, "intake_not_found", "no such project");
    return stored;
  };
  const version = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  const platform: ProjectSyncPlatform = {
    listProjects: async (client, params) => {
      const userId = userOf(client);
      const since = params.updatedSince ?? "";
      const changed = [...projects.values()].filter((stored) => stored.record.updatedAt > since);
      return {
        projects: changed.filter((stored) => visible(stored, userId)).map((stored) => wire(stored, userId)),
        nextCursor: null,
        hidden: params.updatedSince ? changed.filter((stored) => !visible(stored, userId)).map((stored) => stored.record.id) : [],
      };
    },
    createProject: async (client, input) => {
      const now = tick();
      const stored: Stored = {
        record: { ...input, ownerUserId: userOf(client), createdAt: now, updatedAt: now },
        deleted: false,
        personalizationAt: input.personalizationPrompt === undefined ? null : now,
        files: projects.get(input.id)?.files ?? new Map(),
      };
      projects.set(input.id, stored);
      return wire(stored, userOf(client));
    },
    patchProject: async (client, id, patch) => {
      const stored = lookup(client, id);
      const now = tick();
      const scope = patch.scope ?? stored.record.scope;
      let personalizationPrompt = scope.metadata ? stored.record.personalizationPrompt ?? null : null;
      const applied: string[] = [];
      if (!scope.metadata) stored.personalizationAt = null;
      if (scope.metadata && patch.personalizationPrompt !== undefined && (patch.changedAt ?? now) >= (stored.personalizationAt ?? "")) {
        personalizationPrompt = patch.personalizationPrompt;
        stored.personalizationAt = patch.changedAt ?? now;
        applied.push("personalization");
      }
      const fields = [...stored.record.fields];
      for (const change of patch.fieldChanges ?? []) {
        const index = fields.findIndex((field) => field.id === change.id);
        if (change.field === null) {
          if (index >= 0) fields.splice(index, 1);
        } else if (index >= 0) fields[index] = change.field;
        else fields.push(change.field);
      }
      stored.record = {
        ...stored.record,
        name: patch.name ?? stored.record.name,
        remote: patch.remote ?? stored.record.remote,
        fields,
        personalizationPrompt,
        access: patch.access ?? stored.record.access,
        memberIds: patch.memberIds ?? stored.record.memberIds,
        scope,
        updatedAt: now,
      };
      return { project: wire(stored, userOf(client)), applied };
    },
    deleteProject: async (client, id) => {
      const stored = lookup(client, id);
      stored.deleted = true;
      stored.files.clear();
      stored.record = { ...stored.record, updatedAt: tick() };
    },
    storage: (client, projectId): StorageAdapter => {
      const files = () => lookup(client, projectId).files;
      const touch = () => {
        const stored = lookup(client, projectId);
        stored.record = { ...stored.record, updatedAt: tick() };
      };
      return {
        list: async () => ({ entries: [] }),
        listFiles: async (prefix) => ({
          entries: [...files().values()].filter((file) => !prefix || file.path.startsWith(`${prefix}/`)).map((file) => ({
            ...entry(file.path, "file", file.bytes.byteLength, null),
            version: version(file.bytes),
          })),
        }),
        stat: async () => null,
        read: async () => {
          throw new Error("not used");
        },
        download: async (path, destination) => {
          const file = files().get(path.toLowerCase());
          if (!file || destination === undefined) throw new ApiError(404, "intake_not_found", "no such file");
          await writeFile(destination, file.bytes, { flag: "wx" });
          return { size: file.bytes.byteLength, version: version(file.bytes), sha256: version(file.bytes) };
        },
        write: async (path, data, _contentType, condition) => {
          const current = files().get(path.toLowerCase());
          checkCondition(current ? { size: current.bytes.byteLength, version: version(current.bytes) } : null, condition);
          files().set(path.toLowerCase(), { path, bytes: data });
          touch();
        },
        upload: async (path, source, _contentType, condition) => {
          const current = files().get(path.toLowerCase());
          checkCondition(current ? { size: current.bytes.byteLength, version: version(current.bytes) } : null, condition);
          files().set(path.toLowerCase(), { path, bytes: typeof source === "string" ? await readFile(source) : source });
          touch();
        },
        mkdir: async () => {},
        deleteFile: async (path, condition) => {
          const current = files().get(path.toLowerCase());
          if (!current) return;
          if (condition?.version && condition.version !== version(current.bytes)) conflict();
          files().delete(path.toLowerCase());
          touch();
        },
      };
    },
  };
  return { platform, projects };
}

/** One member's computer: its own server config, runtime DB and projects folder. */
async function machine(userId: string, userName: string) {
  const dir = await mkdtemp(join(tmpdir(), `legalwork-${userId}-`));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const config = {
    configPath: join(dir, "server.json"),
    workspaces: [],
    authorizedRoots: [],
    projectsDirectory: join(dir, "Projects"),
  } as unknown as ServerConfig;
  await writeEigenweltConnection(config, {
    platformToken: `tok_${userId}`,
    account: { userId, userName, userEmail: `${userId}@kanzlei.test`, orgId: ORG, orgName: "Kanzlei" },
  });
  return { config, dir, userId };
}

async function localProject(config: ServerConfig, name: string): Promise<WorkspaceInfo> {
  const folderPath = join(config.projectsDirectory ?? "", name);
  await mkdir(folderPath, { recursive: true });
  return (await registerLocalProject(config, { folderPath, name, preset: "starter" })).workspace;
}

function projectsOf(config: ServerConfig): WorkspaceInfo[] {
  return config.workspaces.filter((workspace) => workspace.workspaceType === "local");
}

const read = (workspace: WorkspaceInfo, path: string) => readFile(join(workspace.path, path), "utf8").catch(() => null);

async function write(workspace: WorkspaceInfo, path: string, text: string) {
  await mkdir(join(workspace.path, path, ".."), { recursive: true });
  await writeFile(join(workspace.path, path), text);
  // Past the settle time, as a file saved a moment ago would be by the next round.
  const past = new Date(Date.now() - 60_000);
  await utimes(join(workspace.path, path), past, past);
}

/** Every file of a copy past the settle time, as it is a few seconds after it arrived. */
async function settleFiles(workspace: WorkspaceInfo) {
  const past = new Date(Date.now() - 60_000);
  for (const entry of await readdir(workspace.path, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) await utimes(join(entry.parentPath, entry.name), past, past);
  }
}

function settings(overrides: Partial<ProjectSyncSettings> = {}): ProjectSyncSettings {
  return { access: "members", memberIds: [], scope: ALL, ...overrides };
}

async function changePrompt(config: ServerConfig, workspace: WorkspaceInfo, prompt: string) {
  const before = await readProjectDetails(workspace.path);
  const saved = await updateProjectPersonalization(workspace.path, { revision: before.revision, customInstructions: prompt });
  await noteProjectPersonalizationSaved(config, workspace.id, before.personalizationPrompt ?? "", saved.personalizationPrompt ?? "");
}

describe("project sync between computers", () => {
  test("cloud replicas use the existing project files on demand and keep runtime config out of documents", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("owner", "Owner"), vm = await machine("owner", "Cloud VM");
    const project = await localProject(owner.config, "Matter");
    owner.config.cloudSync = { canExecute: () => false, prepareWorkspace: async () => {}, shouldSyncFiles: () => true, deviceName: "Computer", maintainsProject: () => true };
    await write(project, "Contract.txt", "Existing cloud document");
    await write(project, "opencode.json", "Do not transfer this configuration");
    await saveProjectSyncSettings(owner.config, project, settings());
    await runProjectSync(owner.config, { platform });
    let requested = false;
    vm.config.cloudSync = { canExecute: () => true, prepareWorkspace: async () => {}, shouldSyncFiles: () => requested, deviceName: "Cloud VM" };
    await runProjectSync(vm.config, { platform });
    const copy = projectsOf(vm.config)[0];
    expect(copy).toBeDefined();
    expect(await read(copy, "Contract.txt")).toBeNull();
    requested = true;
    await runProjectSync(vm.config, { platform });
    expect(await read(copy, "Contract.txt")).toBe("Existing cloud document");
    expect(await read(copy, "opencode.json")).not.toBe("Do not transfer this configuration");
    await write(copy, "Contract.txt", "Changed on the VM");
    await runProjectSync(vm.config, { platform });
    await runProjectSync(owner.config, { platform });
    expect(await read(project, "Contract.txt")).toBe("Changed on the VM");
  });

  test("removing teammates preserves an enabled personal cloud copy", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("owner", "Owner"), member = await machine("member", "Member");
    const project = await localProject(owner.config, "Private after sharing");
    owner.config.cloudSync = { canExecute: () => false, prepareWorkspace: async () => {}, shouldSyncFiles: () => true, deviceName: "Computer", maintainsProject: () => true };
    await write(project, "Contract.txt", "Keep the private copy");
    await saveProjectSyncSettings(owner.config, project, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect(projectsOf(member.config)).toHaveLength(1);
    const id = (await projectSyncStore(owner.config)).linkByWorkspace(project.id)!.projectId;
    await stopProjectSync(owner.config, project);
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect(projectsOf(member.config)).toHaveLength(0);
    const link = (await projectSyncStore(owner.config)).linkByWorkspace(project.id);
    expect(link?.projectId).toBe(id);
    expect(link?.settings.memberIds).toEqual([]);
    expect(link?.confirmed).toBe(true);
    expect(await read(project, "Contract.txt")).toBe("Keep the private copy");
  });

  test("instructions arrive with a shared project, edits return, and clearing reaches both computers", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Writing preferences");
    await changePrompt(owner.config, akte, "Use formal English.");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);
    expect((await readProjectDetails(copy.path)).personalizationPrompt).toBe("Use formal English.");
    const previous = await readProjectDetails(akte.path);
    await changePrompt(member.config, copy, "Use short paragraphs.");
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });
    expect((await readProjectDetails(akte.path)).personalizationPrompt).toBe("Use short paragraphs.");
    expect((await readProjectDetails(akte.path)).fields).toEqual(previous.fields);
    await expect(updateProjectPersonalization(akte.path, { revision: previous.revision, customInstructions: "Stale draft" })).rejects.toMatchObject({ code: "project_changed" });
    await changePrompt(owner.config, akte, "");
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    for (const path of [akte.path, copy.path]) expect((await readProjectDetails(path)).personalizationPrompt).toBe("");
  });

  test("a failed upload keeps offline instructions while a newer remote prompt is pulled", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Offline preferences");
    await changePrompt(owner.config, akte, "Original instructions");
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);
    await changePrompt(owner.config, akte, "Remote edit");
    await runProjectSync(owner.config, { platform });
    await changePrompt(member.config, copy, "Offline edit");
    const offline: ProjectSyncPlatform = { ...platform, patchProject: async (client, id, patch) => {
      if (patch.personalizationPrompt !== undefined) throw new ApiError(503, "temporarily_unavailable", "Try later");
      return platform.patchProject(client, id, patch);
    } };
    await runProjectSync(member.config, { platform: offline });
    const refused: ProjectSyncPlatform = { ...platform, patchProject: async (client, id, patch) => {
      if (patch.personalizationPrompt !== undefined) throw new ApiError(409, "retry_instruction_write", "Try later");
      return platform.patchProject(client, id, patch);
    } };
    expect((await runProjectSync(member.config, { platform: refused })).pulled).toBeGreaterThan(0);
    expect((await readProjectDetails(copy.path)).personalizationPrompt).toBe("Offline edit");
    expect((await projectSyncStore(member.config)).outbox().some((entry) => entry.op.kind === "personalization")).toBe(true);
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });
    expect((await readProjectDetails(akte.path)).personalizationPrompt).toBe("Offline edit");
  });

  test("Project details scope keeps instructions local when off and publishes them when enabled", async () => {
    const { platform, projects } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Private preferences");
    await changePrompt(owner.config, akte, "Private instructions");
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org", scope: { ...ALL, metadata: false } }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);
    expect((await readProjectDetails(copy.path)).personalizationPrompt).toBeUndefined();
    await changePrompt(owner.config, akte, "Updated private instructions");
    expect((await projectSyncStore(owner.config)).outbox()).toEqual([]);
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect((await readProjectDetails(copy.path)).personalizationPrompt).toBe("Updated private instructions");
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org", scope: { ...ALL, metadata: false } }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect([...projects.values()][0].record.personalizationPrompt).toBeNull();
    expect((await readProjectDetails(copy.path)).personalizationPrompt).toBe("Updated private instructions");
  });

  test("older services retain queued changes and do not erase local instructions", async () => {
    const { platform } = fakeFirm();
    const legacy: ProjectSyncPlatform = { ...platform,
      createProject: async (client, input) => { const result = await platform.createProject(client, input); delete result.personalizationPrompt; return result; },
      patchProject: async (client, id, patch) => { const result = await platform.patchProject(client, id, patch); if (result.project) delete result.project.personalizationPrompt; return result; },
      listProjects: async (client, params) => { const result = await platform.listProjects(client, params); for (const project of result.projects) delete project.personalizationPrompt; return result; },
    };
    const owner = await machine("user_anna", "Anna");
    const akte = await localProject(owner.config, "Legacy service");
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform: legacy });
    await changePrompt(owner.config, akte, "Keep these instructions");
    await runProjectSync(owner.config, { platform: legacy });
    expect((await readProjectDetails(akte.path)).personalizationPrompt).toBe("Keep these instructions");
    const pending = (await projectSyncStore(owner.config)).outbox();
    expect(pending).toHaveLength(1);
    expect(pending[0].op.kind).toBe("personalization");
    expect((await projectSyncStatus(owner.config, akte)).error).toContain("team service needs an update");
    await runProjectSync(owner.config, { platform });
    expect((await projectSyncStore(owner.config)).outbox()).toEqual([]);
    expect((await projectSyncStatus(owner.config, akte)).error).toBeNull();
  });

  test("an existing shared project's saved local instructions survive service rollout and are published", async () => {
    const { platform, projects } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Existing project");
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform });
    const stored = [...projects.values()][0];
    stored.record.personalizationPrompt = null;
    stored.record.updatedAt = new Date(Date.parse(stored.record.updatedAt) + 1000).toISOString();
    const details = await readProjectDetails(akte.path);
    await updateProjectPersonalization(akte.path, { revision: details.revision, customInstructions: "Previously saved instructions" });
    await runProjectSync(owner.config, { platform });
    expect((await readProjectDetails(akte.path)).personalizationPrompt).toBe("Previously saved instructions");
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect((await readProjectDetails(projectsOf(member.config)[0].path)).personalizationPrompt).toBe("Previously saved instructions");
  });

  test("a shared project and its documents reach a named member, and edits come back", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const outsider = await machine("user_cleo", "Cleo");

    const akte = await localProject(owner.config, "Müller ./. Schmidt");
    await write(akte, "Schriftsätze/Klage.pdf", "klage v1");
    await write(akte, "Notes/Termin.md", "# Termin");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });

    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);
    expect(copy?.name).toBe("Müller ./. Schmidt");
    expect(await read(copy, "Schriftsätze/Klage.pdf")).toBe("klage v1");
    expect(await read(copy, "Notes/Termin.md")).toBe("# Termin");
    // The copy knows which Akte it is, so it is never taken for a new one.
    expect((await readProjectDetails(copy.path)).syncProjectId).toBe((await readProjectDetails(akte.path)).syncProjectId);
    expect((await projectSyncStatus(member.config, copy)).role).toBe("member");

    await runProjectSync(outsider.config, { platform });
    expect(projectsOf(outsider.config)).toEqual([]);

    await write(copy, "Schriftsätze/Klage.pdf", "klage v2 (Ben)");
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });
    expect(await read(akte, "Schriftsätze/Klage.pdf")).toBe("klage v2 (Ben)");
    expect((await projectSyncStatus(owner.config, akte)).state).toBe("synced");
  });

  test("a round on a server that does not list a synced project leaves it synced", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const akte = await localProject(owner.config, "Akte");
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform });

    // The same runtime DB and sign-in with another project list, as a test's server had.
    await runProjectSync({ ...owner.config, workspaces: [] }, { platform });
    expect((await projectSyncStatus(owner.config, akte)).mode).toBe("synced");
  });

  test("a note edited on both computers in different places ends up with both edits, and no copy", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    const note = "Notes/Termin-ee006b29.md";
    await write(akte, note, "# Termin\n\nDer Mandant kommt am Montag um zehn Uhr.\n");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);

    await write(akte, note, "# Termin\n\nDer Mandant kommt am Dienstag um zehn Uhr.\n");
    await write(copy, note, "# Termin\n\nDer Mandant kommt am Montag um zehn Uhr.\n\nVollmacht mitbringen.\n");
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });

    const both = "# Termin\n\nDer Mandant kommt am Dienstag um zehn Uhr.\n\nVollmacht mitbringen.\n";
    expect(await read(akte, note)).toBe(both);
    expect(await read(copy, note)).toBe(both);
    expect((await projectSyncStatus(member.config, copy)).conflicts).toEqual([]);
  });

  test("a Tabular Review goes with the documents, and a colleague's answers come back", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "Vertrag.pdf", "vertrag");
    const reviews = new ReviewStore(akte.path);
    const column = { key: "assign", label: "Abtretung", question: "Ist eine Abtretung erlaubt?", kind: "yes_no" as const, options: [], hint: "" };
    const document = { id: "doc-1", path: "Vertrag.pdf", name: "Vertrag.pdf", sourceHash: null, status: "pending" as const, completedPages: 0, pageCount: 0, error: null };
    const review = await reviews.create({
      id: "5c0ffee0-1111-4222-8333-944445555666", name: "Prüfung", sessionId: "ses_anna", revision: 0, createdAt: 1, updatedAt: 1,
      settings: { mode: "llm", jev: null, llm: { providerId: "firm", model: "chat" } }, columns: [column], documents: [document],
      cells: [{ documentId: "doc-1", columnKey: "assign", status: "pending", result: null, error: null }], status: "draft", runId: null, error: null,
    });
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });

    const [copy] = projectsOf(member.config);
    const arrived = await new ReviewStore(copy.path).read(review.id);
    expect(arrived).toMatchObject({ name: "Prüfung", sessionId: null, documents: [{ path: "Vertrag.pdf" }] });

    await new ReviewStore(copy.path).update(review.id, (current) => {
      current.name = "Prüfung (Ben)";
    });
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });
    expect(await reviews.read(review.id)).toMatchObject({ name: "Prüfung (Ben)", sessionId: "ses_anna" });
    expect((await projectSyncStatus(owner.config, akte)).state).toBe("synced");

    // Without reviews in what is shared, they stay on each computer.
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId], scope: { ...ALL, reviews: false } }));
    await reviews.update(review.id, (current) => {
      current.name = "Nur bei Anna";
    });
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect((await new ReviewStore(copy.path).read(review.id)).name).toBe("Prüfung (Ben)");
  });

  test("with reviews shared and documents not, only the documents a review reviews go with it", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "Verträge/Kaufvertrag.pdf", "kaufvertrag");
    await write(akte, "Verträge/Entwurf.pdf", "entwurf");
    await write(akte, "Notes/Termin.md", "# Termin");
    const column = { key: "assign", label: "Abtretung", question: "Ist eine Abtretung erlaubt?", kind: "yes_no" as const, options: [], hint: "" };
    const document = { id: "doc-1", path: "Verträge/Kaufvertrag.pdf", name: "Kaufvertrag.pdf", sourceHash: null, status: "pending" as const, completedPages: 0, pageCount: 0, error: null };
    const review = await new ReviewStore(akte.path).create({
      id: "5c0ffee0-1111-4222-8333-944445555777", name: "Prüfung", sessionId: null, revision: 0, createdAt: 1, updatedAt: 1,
      settings: { mode: "llm", jev: null, llm: { providerId: "firm", model: "chat" } }, columns: [column], documents: [document],
      cells: [{ documentId: "doc-1", columnKey: "assign", status: "pending", result: null, error: null }], status: "draft", runId: null, error: null,
    });
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId], scope: { ...ALL, documents: false, notes: false } }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });

    const [copy] = projectsOf(member.config);
    expect((await new ReviewStore(copy.path).read(review.id)).documents[0].path).toBe("Verträge/Kaufvertrag.pdf");
    expect(await read(copy, "Verträge/Kaufvertrag.pdf")).toBe("kaufvertrag");
    expect(await read(copy, "Verträge/Entwurf.pdf")).toBeNull();
    expect(await read(copy, "Notes/Termin.md")).toBeNull();
    expect((await projectSyncStatus(owner.config, akte)).state).toBe("synced");
  });

  test("renames and project details reach the other computer; each detail keeps the newer edit", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    const client: ProjectField = { id: "client", label: "Mandant", type: "text", value: "Müller GmbH" };
    await updateProjectDetails(akte.path, { revision: 0, fields: [client] });
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);
    expect((await readProjectDetails(copy.path)).fields).toEqual([client]);

    // Ben renames it and sets the status; Anna changes the client meanwhile.
    await noteProjectRenamed(member.config, copy.id, "Müller GmbH – Kündigung");
    const status: ProjectField = { id: "status", label: "Sachstand", type: "text", value: "Offen" };
    const before = (await readProjectDetails(copy.path)).fields;
    const saved = await updateProjectDetails(copy.path, { revision: (await readProjectDetails(copy.path)).revision, fields: [...before, status] });
    await noteProjectDetailsSaved(member.config, copy.id, before, saved.fields);
    const ownerBefore = (await readProjectDetails(akte.path)).fields;
    const renamedClient = { ...client, value: "Müller AG" };
    const ownerSaved = await updateProjectDetails(akte.path, { revision: (await readProjectDetails(akte.path)).revision, fields: [renamedClient] });
    await noteProjectDetailsSaved(owner.config, akte.id, ownerBefore, ownerSaved.fields);

    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });

    expect(projectsOf(owner.config)[0]?.name).toBe("Müller GmbH – Kündigung");
    for (const path of [akte.path, copy.path]) {
      expect((await readProjectDetails(path)).fields).toEqual([renamedClient, status]);
    }
  });

  test("keeps both versions when two members edit the same document", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "Vertrag.docx", "base");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);

    await write(akte, "Vertrag.docx", "Anna's edit");
    await write(copy, "Vertrag.docx", "Ben's edit");
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });

    // What shows Ben's project reloads: its files changed on his computer.
    expect((await projectSyncOverview(member.config)).contents[copy.id]).toBeGreaterThan(0);
    const status = await projectSyncStatus(member.config, copy);
    // Not a state of the project: Home asks which version stays.
    expect(status.state).not.toBe("error");
    expect(status.conflicts).toHaveLength(1);
    const copyName = status.conflicts[0]?.copyPath ?? "";
    expect(copyName).toMatch(/^Vertrag \(Ben, \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\)\.docx$/);
    for (const workspace of [akte, copy]) {
      expect(await read(workspace, "Vertrag.docx")).toBe("Anna's edit");
      expect(await read(workspace, copyName)).toBe("Ben's edit");
    }
    await resolveProjectSync(member.config, copy, { action: "dismiss_conflict", copyPath: copyName });
    expect((await projectSyncStatus(member.config, copy)).conflicts).toEqual([]);
  });

  test("after a conflict, keeping mine puts it back for everyone, and taking theirs drops mine, both into the sync trash", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "Vertrag.docx", "base");
    await write(akte, "Vollmacht.docx", "base");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);

    for (const name of ["Vertrag.docx", "Vollmacht.docx"]) {
      await write(akte, name, "Anna's edit");
      await write(copy, name, "Ben's edit");
    }
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const conflicts = (await projectSyncStatus(member.config, copy)).conflicts;
    const copyOf = (path: string) => conflicts.find((conflict) => conflict.path === path)?.copyPath ?? "";

    await resolveProjectSync(member.config, copy, { action: "keep_mine", copyPath: copyOf("Vertrag.docx") });
    await resolveProjectSync(member.config, copy, { action: "use_theirs", copyPath: copyOf("Vollmacht.docx") });
    expect((await projectSyncStatus(member.config, copy)).conflicts).toEqual([]);
    expect(await read(copy, "Vertrag.docx")).toBe("Ben's edit");
    expect(await read(copy, "Vollmacht.docx")).toBe("Anna's edit");
    expect(await read(copy, copyOf("Vertrag.docx"))).toBeNull();
    expect(await read(copy, copyOf("Vollmacht.docx"))).toBeNull();
    expect(await readdir(join(copy.path, ".legalwork", "sync-trash"))).not.toEqual([]);

    // The next rounds take the choice to the firm and to Anna, copies gone there too
    // (once the restored file has settled, as every file saved a moment ago waits).
    const past = new Date(Date.now() - 60_000);
    await utimes(join(copy.path, "Vertrag.docx"), past, past);
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });
    expect(await read(akte, "Vertrag.docx")).toBe("Ben's edit");
    expect(await read(akte, "Vollmacht.docx")).toBe("Anna's edit");
    expect(await read(akte, copyOf("Vertrag.docx"))).toBeNull();
    expect(await read(akte, copyOf("Vollmacht.docx"))).toBeNull();
    await expect(resolveProjectSync(member.config, copy, { action: "keep_mine", copyPath: "../Vertrag.docx" })).rejects.toMatchObject({ code: "project_conflict_not_found" });
  });

  test("a member taken off the project loses the copy — or decides, when changes made there had not reached the firm", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "a.txt", "a");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);

    // Offline edit on Ben's computer, then Anna takes him off the Akte.
    await write(copy, "b.txt", "Ben's note");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [] }));
    await runProjectSync(owner.config, { platform });
    const pull = await runProjectSync(member.config, { platform: { ...platform, storage: () => {
      throw new ApiError(502, "intake_unreachable", "offline for documents");
    } } });
    expect(pull.removed).toBe(0);
    expect(await projectSyncStatus(member.config, copy)).toMatchObject({ state: "revoked", pendingChanges: 1 });
    expect(await read(copy, "b.txt")).toBe("Ben's note");

    // Given access again, the held-back copy syncs again, changes included.
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await settleFiles(copy);
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });
    expect((await projectSyncStatus(member.config, copy)).state).toBe("synced");
    expect(await read(akte, "b.txt")).toBe("Ben's note");

    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [] }));
    await runProjectSync(owner.config, { platform });
    await write(copy, "c.txt", "another offline note");
    await runProjectSync(member.config, { platform: { ...platform, storage: () => {
      throw new ApiError(502, "intake_unreachable", "offline for documents");
    } } });
    expect((await projectSyncStatus(member.config, copy)).state).toBe("revoked");
    await resolveProjectSync(member.config, copy, { action: "keep_local" });
    expect((await projectSyncStatus(member.config, copy)).mode).toBe("local");
    expect(await read(copy, "c.txt")).toBe("another offline note");

    // Without such changes the copy simply goes.
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const second = projectsOf(member.config).find((workspace) => workspace.id !== copy.id);
    expect(second).toBeDefined();
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect(projectsOf(member.config).map((workspace) => workspace.id)).toEqual([copy.id]);
    expect(await readdir(second?.path ?? "").catch(() => null)).toBeNull();
    // The app's own list forgets it too.
    expect((await projectSyncOverview(member.config)).removed).toEqual([second?.id ?? ""]);
  });

  test("a file whose time alone moved is no change: without real changes, the copy goes when access ends", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "a.txt", "a");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);
    const touched = new Date(Date.now() - 30_000);
    await utimes(join(copy.path, "a.txt"), touched, touched);

    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect(projectsOf(member.config)).toEqual([]);
  });

  test("stopping sync keeps the owner's project local and takes every copy away", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "a.txt", "a");
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect(projectsOf(member.config)).toHaveLength(1);

    await stopProjectSync(owner.config, akte);
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });

    expect(projectsOf(member.config)).toEqual([]);
    expect((await projectSyncOverview(member.config)).removed).toHaveLength(1);
    expect((await projectSyncOverview(owner.config)).removed).toEqual([]);
    expect(await read(akte, "a.txt")).toBe("a");
    expect((await projectSyncStatus(owner.config, akte)).mode).toBe("local");
    expect((await readProjectDetails(akte.path)).syncProjectId).toBeUndefined();
  });

  test("shared again after stopping, it is the same project: a copy held back takes it up again, with its changes and nothing lost", async () => {
    const { platform, projects } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "a.txt", "a");
    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);
    const firstId = (await readProjectDetails(akte.path)).syncProjectId;

    // Ben writes a note that has not reached the firm when Anna stops: his copy is held back.
    await write(copy, "Notes/Ben.md", "Ben's note");
    await stopProjectSync(owner.config, akte);
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform: { ...platform, storage: () => {
      throw new ApiError(502, "intake_unreachable", "offline for documents");
    } } });
    expect((await projectSyncStatus(member.config, copy)).state).toBe("revoked");

    await saveProjectSyncSettings(owner.config, akte, settings({ access: "org" }));
    await runProjectSync(owner.config, { platform });
    expect((await readProjectDetails(akte.path)).syncProjectId).toBe(firstId);
    expect(projects.size).toBe(1);

    await settleFiles(copy);
    await runProjectSync(member.config, { platform });
    await runProjectSync(owner.config, { platform });
    expect(projectsOf(member.config).map((workspace) => workspace.id)).toEqual([copy.id]);
    expect((await projectSyncStatus(member.config, copy)).state).toBe("synced");
    expect((await projectSyncStatus(member.config, copy)).conflicts).toEqual([]);
    expect(await read(copy, "a.txt")).toBe("a");
    expect(await read(akte, "Notes/Ben.md")).toBe("Ben's note");
  });

  test("an arrival interrupted after its folder was made is picked up again, not duplicated", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    await write(akte, "a.txt", "a");
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);

    // Ben's computer loses its registry and sync state (a reinstall), but the folder stays.
    const fresh = { ...member.config, workspaces: [], authorizedRoots: [], configPath: join(member.dir, "fresh", "server.json") };
    await writeEigenweltConnection(fresh, {
      platformToken: "tok_user_ben",
      account: { userId: "user_ben", userName: "Ben", userEmail: "ben@kanzlei.test", orgId: ORG, orgName: "Kanzlei" },
    });
    await runProjectSync(fresh, { platform });

    expect(projectsOf(fresh).map((workspace) => workspace.path)).toEqual([copy.path]);
    expect(await readdir(member.config.projectsDirectory ?? "")).toEqual(["Akte"]);
  });

  /** One folder both computers see (a shared drive), each has as its own project; the owner shares it. */
  async function sameFolderOnBoth() {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const folderPath = join(owner.dir, "Laufwerk", "Akte");
    await mkdir(folderPath, { recursive: true });
    const akte = (await registerLocalProject(owner.config, { folderPath, name: "Akte", preset: "starter" })).workspace;
    const own = (await registerLocalProject(member.config, { folderPath, name: "Akte", preset: "starter" })).workspace;
    await write(akte, "a.txt", "a");
    const tasks = await taskStore(member.config);
    const task = tasks.createTask({ title: "Privat", projectId: own.id }, { userId: "user_ben", name: "Ben", email: null });
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    const projectId = (await readProjectDetails(folderPath)).syncProjectId;
    return { platform, owner, member, akte, own, tasks, task, folderPath, projectId };
  }

  test("a member's own folder that already is the shared project is not taken over unasked; kept apart, the project gets its own", async () => {
    const { platform, member, own, tasks, task, folderPath } = await sameFolderOnBoth();

    // Nothing is taken over and nothing of Ben's is sent: he is asked.
    expect(await projectSyncStatus(member.config, own)).toMatchObject({
      mode: "local",
      state: "offered",
      offer: { name: "Akte", ownerUserId: "user_anna" },
    });
    expect((await projectSyncOverview(member.config)).states[own.id]).toBe("offered");
    expect(projectsOf(member.config).map((workspace) => workspace.id)).toEqual([own.id]);
    expect(tasks.listOutbox().filter((entry) => entry.taskId === task.id)).toEqual([]);
    await expect(saveProjectSyncSettings(member.config, own, settings())).rejects.toMatchObject({ code: "project_sync_offer_pending" });

    await resolveProjectSync(member.config, own, { action: "keep_apart" });
    await runProjectSync(member.config, { platform });
    const copy = projectsOf(member.config).find((workspace) => workspace.id !== own.id);
    expect(copy?.path).toBeDefined();
    expect(copy?.path).not.toBe(folderPath);
    expect(copy ? await read(copy, "a.txt") : null).toBe("a");
    expect(await projectSyncStatus(member.config, own)).toMatchObject({ mode: "local", state: "local", offer: null });
    expect(tasks.listOutbox().filter((entry) => entry.taskId === task.id)).toEqual([]);
  });

  test("used as the member's copy, their own folder stays theirs when they are taken off or leave", async () => {
    const { platform, owner, member, akte, own, folderPath, projectId } = await sameFolderOnBoth();
    await resolveProjectSync(member.config, own, { action: "use_folder" });
    await runProjectSync(member.config, { platform });
    expect(await projectSyncStatus(member.config, own)).toMatchObject({ mode: "synced", role: "member", ownFolder: true });
    expect(projectsOf(member.config).map((workspace) => workspace.id)).toEqual([own.id]);

    // Taken off: the project stays Ben's own, and Anna's id in the shared folder is left alone.
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect(projectsOf(member.config).map((workspace) => workspace.id)).toEqual([own.id]);
    expect((await projectSyncStatus(member.config, own)).mode).toBe("local");
    expect(await read(own, "a.txt")).toBe("a");
    expect((await readProjectDetails(folderPath)).syncProjectId).toBe(projectId);

    // Given access again, he chose this folder before; leaving keeps it too.
    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId] }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(member.config, { platform });
    expect((await projectSyncStatus(member.config, own)).mode).toBe("synced");
    await resolveProjectSync(member.config, own, { action: "remove", force: true });
    expect(projectsOf(member.config).map((workspace) => workspace.id)).toEqual([own.id]);
    expect(await read(own, "a.txt")).toBe("a");
    await runProjectSync(member.config, { platform });
    expect((await projectSyncStatus(member.config, own)).state).toBe("local");
  });

  test("recordings linked to the project reach colleagues when recordings are in the scope", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const member = await machine("user_ben", "Ben");
    const akte = await localProject(owner.config, "Akte");
    const exported: string[] = [];
    const idle = { available: false, recordingActive: false, liveTranscriptActive: false, fileName: null, error: null };
    const recorder: RecorderBridge = {
      listProjectRecordings: async (projectId) =>
        projectId === akte.id
          ? [
              { id: "rec_done", title: "Mandantengespräch", durationMs: 1000, status: "complete", segmentCount: 1 },
              { id: "rec_live", title: "Läuft noch", durationMs: 0, status: "recording", segmentCount: 0 },
            ]
          : [],
      exportProjectRecording: async (_projectId, id, root) => {
        exported.push(id);
        await mkdir(join(root, "recordings", "2026-09-25-mandantengesprach"), { recursive: true });
        await writeFile(join(root, "recordings", "2026-09-25-mandantengesprach", "transcript.md"), "# Mandantengespräch");
        const past = new Date(Date.now() - 60_000);
        await utimes(join(root, "recordings", "2026-09-25-mandantengesprach", "transcript.md"), past, past);
        return true;
      },
      status: () => idle,
      setLiveTranscript: () => idle,
    };
    owner.config.recorder = recorder;

    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId], scope: { ...ALL, recordings: false } }));
    await runProjectSync(owner.config, { platform });
    expect(exported).toEqual([]);

    await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId], scope: { ...ALL, recordings: true } }));
    await runProjectSync(owner.config, { platform });
    await runProjectSync(owner.config, { platform });
    // Only the finished recording, and only once.
    expect(exported).toEqual(["rec_done"]);

    await runProjectSync(member.config, { platform });
    const [copy] = projectsOf(member.config);
    expect(await read(copy, "recordings/2026-09-25-mandantengesprach/transcript.md")).toBe("# Mandantengespräch");
  });

  test("tasks of a local project stay on this computer; turning sync on sends them", async () => {
    const { platform } = fakeFirm();
    const owner = await machine("user_anna", "Anna");
    const akte = await localProject(owner.config, "Akte");
    const tasks = await taskStore(owner.config);
    const actor = { userId: "user_anna", name: "Anna", email: null };
    const task = tasks.createTask({ title: "Frist prüfen", projectId: akte.id }, actor);
    expect(tasks.listOutbox().filter((entry) => entry.taskId === task.id)).toEqual([]);

    await saveProjectSyncSettings(owner.config, akte, settings());
    expect(tasks.listOutbox().filter((entry) => entry.taskId === task.id).map((entry) => entry.op.kind)).toEqual(["create"]);

    // Taking tasks out of the scope keeps them here again.
    await runProjectSync(owner.config, { platform });
    await saveProjectSyncSettings(owner.config, akte, settings({ scope: { ...ALL, tasks: false } }));
    expect(tasks.getTask(task.id)?.sync.orgId).toBeNull();
    tasks.patchTask(task.id, { title: "Frist prüfen (lokal)" }, actor);
    expect(tasks.listOutbox().filter((entry) => entry.taskId === task.id)).toEqual([]);
  });
});

describe("diffFields", () => {
  const a: ProjectField = { id: "a", label: "A", type: "text", value: "1" };
  const b: ProjectField = { id: "b", label: "B", type: "text", value: null };

  test("names changed, added and removed details, and the order only when it moved", () => {
    expect(diffFields([a, b], [a, { ...b, value: "2" }])).toEqual({ changes: [{ id: "b", field: { ...b, value: "2" } }], order: null });
    expect(diffFields([a], [a, b])).toEqual({ changes: [{ id: "b", field: b }], order: ["a", "b"] });
    expect(diffFields([a, b], [b])).toEqual({ changes: [{ id: "a", field: null }], order: null });
    expect(diffFields([a, b], [b, a])).toEqual({ changes: [], order: ["b", "a"] });
  });
});

test("team project configuration shares folder references and setup status even with document sync disabled", async () => {
  const { platform } = fakeFirm();
  const owner = await machine("user_anna", "Anna");
  const member = await machine("user_ben", "Ben");
  const akte = await localProject(owner.config, "Remote matter");
  const remote = { version: 1 as const, initialization: "ready" as const, folders: [{ id: crypto.randomUUID(), connectionId: `team:${crypto.randomUUID()}`, connectionName: "Team drive", organizationId: ORG, connectionFingerprint: "a".repeat(64), folder: { id: "100", namespace: "box", path: "Matter", name: "Matter" } }] };
  await updateProjectRemote(akte.path, remote);
  await saveProjectSyncSettings(owner.config, akte, settings({ memberIds: [member.userId], scope: { documents: false, notes: false, tasks: false, recordings: false, metadata: false, reviews: false } }));
  await runProjectSync(owner.config, { platform });
  await runProjectSync(member.config, { platform });
  const [copy] = projectsOf(member.config);
  expect((await readProjectDetails(copy.path)).remote).toEqual(remote);
  expect((await readProjectDetails(copy.path)).syncProjectId).toBe((await readProjectDetails(akte.path)).syncProjectId);
  await updateProjectRemote(copy.path, { ...remote, folders: [] });
  await noteProjectFoldersChanged(member.config, copy.id);
  await runProjectSync(member.config, { platform });
  await runProjectSync(owner.config, { platform });
  expect((await readProjectDetails(akte.path)).remote?.folders).toEqual([]);
  expect((await readProjectDetails(akte.path)).remote).not.toHaveProperty("context");
});
