import { writeMarkdownChunk } from "./markdown-stream";
import { attachmentFilename } from "@/app/lib/attachment-filename";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { LegalworkControlAction, LegalworkControlSurface } from "../../../shell/control/control-provider";
import type { ArtifactPanelProps } from "./artifact-panel";
import { classifyOpenTarget } from "./open-target";
import { usePanelTabStore, workspacePanelKey } from "../panel/panel-tab-store";
import { storageFileTab } from "../panel/storage-file-tab";
import { createDocumentTaskQueue, checkDocumentTask, type DocumentTaskOptions } from "./document-task-queue";
import { openBackgroundTab } from "../background/open-background-tab";
import { t } from "@/i18n";

export type DocumentProject = { projectId: string; workspaceId: string; workspaceRoot: string; client: LegalworkServerClient; isRemoteWorkspace: boolean };
export type Registration = { surface: LegalworkControlSurface; action: LegalworkControlAction; ready: () => boolean; dirty: () => boolean; updatedAt?: () => number | null };
export type Entry = {
  key: string;
  props: ArtifactPanelProps;
  host: HTMLDivElement;
  sessions: Set<string>;
  tasks: Set<string>;
  dismissed: Set<string>;
  previews: Set<HTMLElement>;
  destinations: Map<HTMLElement, boolean>;
  registration: Registration | null;
  generation: number;
  fileEditing: boolean;
};

export function documentKey(props: ArtifactPanelProps) {
  return JSON.stringify([props.client?.baseUrl, props.workspaceId, props.tab.storage ? [props.tab.storage.root.id, props.tab.storage.file.path] : props.tab.value ?? props.tab.id]);
}
export function stringArg(args: unknown, key: string) {
  const value: unknown = args && typeof args === "object" ? Reflect.get(args, key) : undefined;
  return typeof value === "string" ? value : "";
}
function validPath(path: string) {
  return Boolean(path) && !/[\\\x00-\x1f\x7f]/.test(path) && path.split("/").every(part => part && part !== "." && part !== "..");
}
/** Only these formats register an agent editor; waiting on any other file would hang. */
function editsLive(preview: string | undefined, name: string) {
  return preview === "word" || preview === "markdown" || /\.(xlsx|pptx)$/i.test(name);
}

export function createDocumentRuntime(createHost = () => document.createElement("div"), fallbackProject?: (sessionId: string) => Promise<DocumentProject>, flush = (run: () => void) => run()) {
  const entries = new Map<string, Entry>();
  const selected = new Map<string, string>();
  const taskSessions = new Map<string, string>();
  const listeners = new Set<() => void>();
  const queue = createDocumentTaskQueue();
  const fileQueue = createDocumentTaskQueue();
  const fileEdits = new Map<string, { sessionId: string; finish: () => void; done: Promise<void> }>();
  const activeHandoffs = new Map<string, { matches: (props: ArtifactPanelProps) => boolean; opened: Entry[] }>();
  const projectKey = (project: DocumentProject) => JSON.stringify([project.client.baseUrl, project.workspaceId]);
  const waitForFileEdits = (project: DocumentProject) => fileQueue(projectKey(project), async () => {});
  let version = 0;
  let generation = 0;
  let resolveProject: ((sessionId: string) => DocumentProject) | null = null;
  const changed = () => { version++; listeners.forEach(listener => listener()); };
  const ensure = (props: ArtifactPanelProps) => {
    const key = documentKey(props);
    const existing = entries.get(key);
    if (existing) return existing;
    const host = createHost();
    host.className = "flex h-full min-h-0 min-w-0 flex-col";
    const entry: Entry = { key, props, host, sessions: new Set(), tasks: new Set(), dismissed: new Set(), previews: new Set(), destinations: new Map(), registration: null, generation: ++generation, fileEditing: false };
    entries.set(key, entry);
    for (const handoff of activeHandoffs.values()) if (handoff.matches(props)) {
      entry.fileEditing = true;
      handoff.opened.push(entry);
    }
    changed();
    return entry;
  };
  const close = (entry: Entry) => {
    entries.delete(entry.key);
    for (const [session, key] of selected) if (key === entry.key) selected.delete(session);
    usePanelTabStore.getState().closeTab(entry.props.sessionId, entry.props.tab.id);
    changed();
  };
  const prune = () => {
    for (const entry of entries.values()) {
      if (entry.fileEditing || entry.destinations.size || entry.tasks.size || [...selected.values()].includes(entry.key) || entry.registration?.dirty()) continue;
      if (usePanelTabStore.getState().sessions[entry.props.sessionId]?.tabs.some(tab => tab.id === entry.props.tab.id)) continue;
      close(entry);
    }
  };
  const resolvedProjects = new Map<string, DocumentProject>();
  const getProject = async (sessionId: string) => {
    if (!sessionId) throw new Error("A task identity is required.");
    try { if (resolveProject) return resolveProject(sessionId); } catch (error) { if (!fallbackProject) throw error; }
    const cached = resolvedProjects.get(sessionId);
    if (cached) return cached;
    if (!fallbackProject) throw new Error("The task's project is unavailable.");
    const project = await fallbackProject(sessionId);
    resolvedProjects.set(sessionId, project);
    return project;
  };
  const belongs = (entry: Entry, project: DocumentProject) => entry.props.workspaceId === project.workspaceId && entry.props.client?.baseUrl === project.client.baseUrl;
  const select = (entry: Entry, sessionId: string) => {
    entry.sessions.add(sessionId);
    entry.tasks.add(sessionId);
    entry.dismissed.delete(sessionId);
    selected.set(sessionId, entry.key);
    changed();
  };
  const current = (sessionId: string, project: DocumentProject, path?: string) => {
    const explicit = selected.get(sessionId);
    const candidates = [...entries.values()].filter(entry => belongs(entry, project));
    const entry = path ? candidates.find(entry => (entry.registration?.surface.path ?? entry.props.tab.value) === path)
      : candidates.find(entry => entry.key === explicit) ?? candidates.find(entry => [...entry.destinations.values()].some(Boolean));
    if (!entry) throw new Error("No document is selected for this task. Use inapp_documents_open with its workspace path; no visible tab is required.");
    return entry;
  };
  const waitUntilReady = async (entry: Entry, options: DocumentTaskOptions = {}) => {
    const deadline = Date.now() + 60_000;
    while (entries.get(entry.key) === entry && Date.now() < deadline) {
      checkDocumentTask(options);
      if (entry.fileEditing) throw new Error("This document is being edited as a file. Reopen it with inapp_documents_open after the file edit finishes.");
      if (entry.registration?.ready()) return entry.registration;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("The document could not finish loading. The task can report the failure without changing the user's view.");
  };
  return {
    entries, changed, ensure, close, getProject, taskSessions, prune,
    async openSession(args: unknown, callerSessionId: string | undefined, navigate: (path: string) => void) {
      const sessionId = stringArg(args, "sessionId"), project = await getProject(sessionId);
      if (callerSessionId) {
        taskSessions.set(callerSessionId, sessionId);
        return { ok: true, sessionId, workspaceId: project.projectId, background: true, message: "The session is available to this task. Read it with session.read_transcript. The user's view is unchanged." };
      }
      // Navigation alone does not select the chat when this route is already
      // mounted beside a document. Keep the editor and select its owning chat.
      const panels = usePanelTabStore.getState(), scope = workspacePanelKey(project.projectId);
      const chat = panels.sessions[scope]?.tabs.find(tab => tab.type === "chat" && tab.sessionId === sessionId);
      if (chat) panels.selectTab(scope, chat.id);
      else panels.adoptChat(scope, sessionId, t("session.default_title"), { preserveLayout: true });
      navigate(`/workspace/${encodeURIComponent(project.projectId)}/session/${encodeURIComponent(sessionId)}`);
      return { ok: true, navigatedTo: sessionId };
    },
    dismiss: (entry: Entry, sessionId: string) => { entry.dismissed.add(sessionId); changed(); },
    releaseTask: (sessionId: string) => {
      selected.delete(sessionId); taskSessions.delete(sessionId);
      for (const entry of entries.values()) { entry.tasks.delete(sessionId); entry.dismissed.delete(sessionId); }
      changed(); prune();
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    setResolver: (resolver: (sessionId: string) => DocumentProject) => { resolveProject = resolver; },
    async beginFileEdit(args: unknown, options: DocumentTaskOptions = {}) {
      checkDocumentTask(options);
      const sessionId = stringArg(args, "sessionId"), operationId = stringArg(args, "operationId");
      if (!operationId) throw new Error("A file operation identity is required.");
      const project = await getProject(sessionId);
      const paths: unknown = args && typeof args === "object" ? Reflect.get(args, "paths") : undefined;
      if (paths !== undefined && (!Array.isArray(paths) || !paths.every(path => typeof path === "string" && validPath(path)))) throw new Error("Use workspace-relative file paths.");
      if (fileEdits.has(operationId)) throw new Error("This file operation is already running.");
      let finish!: () => void, ready!: () => void, fail!: (error: unknown) => void;
      const released = new Promise<void>(resolve => { finish = resolve; });
      const prepared = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
      const done = fileQueue(projectKey(project), async () => {
        const held: Promise<void>[] = [];
        const matches = (props: ArtifactPanelProps) => props.workspaceId === project.workspaceId
          && props.client?.baseUrl === project.client.baseUrl && !props.tab.storage
          && ["word", "markdown", "sheet", "slides"].includes(props.tab.preview ?? "")
          && (!Array.isArray(paths) || paths.includes(props.tab.value));
        const handoff = { matches, opened: new Array<Entry>() };
        activeHandoffs.set(operationId, handoff);
        try {
          checkDocumentTask(options);
          // A shell script can compute its destination dynamically. Without
          // explicit paths, protect all live editable files in this project.
          const targets = [...entries.values()].filter(entry => matches(entry.props)
            && entry.registration?.surface.editable !== false);
          for (const entry of targets) {
            let saved!: () => void, saveFailed!: (error: unknown) => void;
            const saving = new Promise<void>((resolve, reject) => { saved = resolve; saveFailed = reject; });
            const hold = queue(entry.key, async () => {
              try {
                if (!entry.fileEditing) {
                  const registration = await waitUntilReady(entry, options);
                  const result = await registration.action.execute({ sessionId: entry.props.sessionId,
                    path: registration.surface.path, toolName: "prepare_file_edit", args: {} }, { setNarration: () => {}, ...options });
                  checkDocumentTask(options);
                  if (!result || typeof result !== "object" || Reflect.get(result, "ok") !== true || Reflect.get(result, "saved") !== true || registration.dirty()) {
                    throw new Error(`Could not save ${entry.props.tab.label} before the file edit. The draft is still open.`);
                  }
                  // Commit the unmount before the process can write. This also
                  // removes the old editor's autosave callbacks synchronously.
                  flush(() => {
                    entry.fileEditing = true;
                    entry.registration = null;
                    changed();
                  });
                }
                saved();
                await released;
              } catch (error) { saveFailed(error); throw error; }
              finally {
                if (entry.fileEditing) {
                  entry.fileEditing = false;
                  entry.registration = null;
                  entry.generation = ++generation;
                  changed();
                  await waitUntilReady(entry);
                }
              }
            });
            held.push(hold);
            void hold.catch(() => {});
            await saving;
          }
          ready();
          await released;
        } catch (error) { fail(error); finish(); }
        finally {
          activeHandoffs.delete(operationId);
          for (const entry of handoff.opened) {
            entry.fileEditing = false;
            entry.generation = ++generation;
          }
          if (handoff.opened.length) changed();
          const results = await Promise.allSettled(held);
          fileEdits.delete(operationId);
          const failed = results.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        }
      });
      fileEdits.set(operationId, { sessionId, finish, done });
      void done.catch(fail);
      try { await prepared; } catch (error) { await done.catch(() => {}); throw error; }
      return { ok: true, operationId };
    },
    async endFileEdit(args: unknown) {
      const operationId = stringArg(args, "operationId"), edit = fileEdits.get(operationId);
      if (!edit) return { ok: true };
      if (edit.sessionId !== stringArg(args, "sessionId")) throw new Error("This file operation belongs to another task.");
      edit.finish();
      await edit.done;
      return { ok: true, reloaded: true };
    },
    async createMarkdown(args: unknown, options: DocumentTaskOptions = {}) {
      checkDocumentTask(options);
      const sessionId = stringArg(args, "sessionId"), path = stringArg(args, "path"), content = stringArg(args, "content");
      if (!validPath(path) || !/\.(md|markdown)$/i.test(path)) throw new Error("Use a new workspace-relative Markdown filename.");
      const project = await getProject(sessionId);
      await waitForFileEdits(project);
      const append = Boolean(args && typeof args === "object" && Reflect.get(args, "append") === true);
      const complete = Boolean(args && typeof args === "object" && Reflect.get(args, "complete") === true);
      return queue(JSON.stringify([project.client.baseUrl, project.workspaceId, path]), async () => {
        const result = await writeMarkdownChunk({
          workspaceId: project.workspaceId, sessionId, path, content, append, complete,
          exists: async () => (await project.client.statWorkspaceFile(project.workspaceId, path)).exists,
          save: value => { checkDocumentTask(options); return project.client.writeWorkspaceFile(project.workspaceId, { path, content: value, createOnly: true }); },
        });
        const entry = ensure({ ...project, sessionId: workspacePanelKey(project.projectId),
          tab: { id: `file:${path}`, type: "artifact", value: path, label: path.split("/").at(-1)!, preview: "markdown" }, onClose: () => {} });
        select(entry, sessionId);
        return result;
      }, options);
    },
    async open(args: unknown, options: DocumentTaskOptions = {}) {
      checkDocumentTask(options);
      const sessionId = stringArg(args, "sessionId");
      const project = await getProject(sessionId);
      await waitForFileEdits(project);
      checkDocumentTask(options);
      let path = stringArg(args, "path"), connectionId = stringArg(args, "connectionId");
      const copyTo = stringArg(args, "copyTo");
      if (!validPath(path)) throw new Error("Use a relative file path within the workspace or connection.");
      if (copyTo) {
        if (!validPath(copyTo) || copyTo.split(".").at(-1)?.toLowerCase() !== (connectionId ? path : attachmentFilename(path)).split(".").at(-1)?.toLowerCase()) throw new Error("Use a new workspace-relative filename with the same file extension as the template.");
        if (connectionId) {
          const copy = await project.client.checkoutStorageFile(project.workspaceId, connectionId, path);
          checkDocumentTask(options);
          await project.client.keepStorageLocalCopy(project.workspaceId, connectionId, copy.localPath, copyTo);
        } else { checkDocumentTask(options); await project.client.copyWorkspaceFile(project.workspaceId, path, copyTo); }
        path = copyTo; connectionId = "";
      }
      const name = connectionId ? path.split("/").at(-1)! : attachmentFilename(path);
      const preview = classifyOpenTarget(name, "file");
      if (preview === "external" || preview === "browser") throw new Error("This file type has no in-app document editor. Use the tools for its saved file.");
      const file = connectionId ? null : await project.client.statWorkspaceFile(project.workspaceId, path);
      if (file && (!file.exists || file.kind !== "file")) throw new Error("File not found in this task's workspace.");
      const root = connectionId ? (await project.client.storageRoots(project.workspaceId)).roots.find(root => root.id === connectionId) : null;
      if (connectionId && !root) throw new Error("This storage connection is unavailable.");
      const tab = root ? storageFileTab(project.workspaceId, root, { path, name, kind: "file", size: null, modifiedAt: null })
        : { id: `file:${path}`, type: "artifact", label: name, value: path, preview, size: file?.size, updatedAt: file?.updatedAt } satisfies ArtifactPanelProps["tab"];
      const entry = ensure({ ...project, sessionId: workspacePanelKey(project.projectId), tab, onClose: () => {} });
      return queue(entry.key, async () => {
        const diskChanged = file && entry.registration?.updatedAt && file.updatedAt !== entry.registration.updatedAt();
        // Never replace an unsaved draft. A clean editor can reload an external
        // revision, and a completed file handoff always starts a fresh editor.
        if (entry.fileEditing || (diskChanged && !entry.registration?.dirty())) {
          entry.fileEditing = false;
          entry.registration = null;
          entry.generation = ++generation;
        }
        select(entry, sessionId);
        const liveEditing = editsLive(preview, path);
        if (liveEditing) await waitUntilReady(entry, options);
        const show = Boolean(args && typeof args === "object" && Reflect.get(args, "show") === true);
        // Same as the user opening the task's card: the tab moves beside the chat.
        if (show) openBackgroundTab(entry.props.sessionId, sessionId, entry.props.tab);
        return { ok: true, name, path: entry.registration?.surface.path ?? path, liveEditing, ...(copyTo ? { copied: true } : {}),
          message: show ? "The document is ready for this task and now open beside the chat." : "The document is ready for this task. Use the matching inapp_* tools. The user's view has not changed." };
      }, options);
    },
    async list(args: unknown) {
      const sessionId = stringArg(args, "sessionId"), project = await getProject(sessionId);
      let active: Entry | undefined;
      try { active = current(sessionId, project); } catch { /* No selected document yet. */ }
      const available = [...entries.values()].filter(entry => belongs(entry, project) && !entry.fileEditing);
      const owned = available.filter(entry => entry.sessions.has(sessionId) || entry === active);
      const surface = (entry: Entry) => ({ ...entry.registration!.surface, sessionId, sessionIds: [sessionId] });
      const files = owned.map(entry => ({
        name: entry.props.tab.label, path: entry.registration?.surface.path ?? entry.props.tab.value,
        sessionId, active: entry === active,
      }));
      return { openFiles: files, surfaces: owned.filter(entry => entry.registration).map(surface), activeSurface: active?.registration ? surface(active) : null,
        // Used only by the file-write guard, never as this chat's document context.
        protectedSurfaces: available.filter(entry => entry.registration).map(surface) };
    },
    async select(args: unknown) {
      const sessionId = stringArg(args, "sessionId");
      const entry = current(sessionId, await getProject(sessionId), stringArg(args, "path"));
      return queue(entry.key, async () => {
        select(entry, sessionId);
        if (editsLive(entry.props.tab.preview, entry.props.tab.label)) await waitUntilReady(entry);
        return { ok: true, path: entry.registration?.surface.path, message: "Selected for this task. The user's view has not changed." };
      });
    },
    async execute(actionId: string, args: unknown, options: DocumentTaskOptions = {}) {
      checkDocumentTask(options);
      const sessionId = stringArg(args, "sessionId");
      // Capture the target before queueing: another task's selection cannot redirect it.
      const entry = current(sessionId, await getProject(sessionId), stringArg(args, "path") || undefined);
      entry.sessions.add(sessionId);
      entry.tasks.add(sessionId);
      entry.dismissed.delete(sessionId);
      if (!selected.has(sessionId)) selected.set(sessionId, entry.key);
      changed();
      return queue(entry.key, async () => {
        const registration = await waitUntilReady(entry, options);
        const handoff = stringArg(args, "toolName") === "prepare_file_edit";
        if (handoff && [...entry.tasks].some(task => task !== sessionId)) throw new Error("Another task is using this live document. Finish that task before switching to file editing.");
        if (registration.action.id !== actionId || (stringArg(args, "format") && stringArg(args, "format") !== registration.surface.format)) throw new Error("This document requires a different format's tools.");
        // The dispatcher has checked project ownership. Address the persistent
        // editor by its pane identity, without waiting for React to propagate a
        // newly attached chat's membership before this call can proceed.
        const editorArgs = args && typeof args === "object" ? { ...args, sessionId: entry.props.sessionId } : args;
        checkDocumentTask(options);
        const result = await registration.action.execute(editorArgs, { setNarration: () => {}, ...options });
        if (handoff && result && typeof result === "object" && Reflect.get(result, "ok") === true && Reflect.get(result, "saved") === true) {
          checkDocumentTask(options);
          if (registration.dirty()) return { ok: false, saved: false, error: "The draft changed while saving. File editing is not ready; the editor remains open." };
          // Keep the destination and task membership, but retire the actual
          // editor so it cannot overwrite a file pipeline's newer bytes.
          entry.fileEditing = true;
          entry.registration = null;
          changed();
        }
        return result;
      }, options);
    },
  };
}
