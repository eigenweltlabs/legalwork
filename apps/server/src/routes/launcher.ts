import { AssistantContextItemSchema, AssistantWorkStatusSchema, LAUNCHER_SEARCH_KINDS, LauncherFileTransferInputSchema, LauncherFileSourceKindSchema, LauncherSortSchema, compareLauncherResults, LauncherInvocationSchema, LauncherInvocationSourceSchema, LauncherSearchKindSchema, LauncherSearchResultSchema, QuickActionInputSchema } from "../native-shared-values.js";
import { workspaceContentPath, workspaceFileRoot } from "../project-storage-paths.js";
import { assistantSubscriptionAvailable } from "../assistant-subscription.js";
import { existingLauncherFiles } from "../launcher-file-visibility.js";
import { createLauncherDocument } from "../launcher-document.js";
import { browseLauncherDirectory } from "../launcher-browse.js";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { searchFolderFiles } from "../launcher-folder-search.js";
import { basename, extname, relative, resolve, sep } from "node:path";
import { recordAudit } from "../audit.js";
import { shortId } from "../utils.js";
import { launcherDestination } from "../launcher-file-destination.js";
import { copyLauncherTransferFile } from "../launcher-file-source.js";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { assistantRequestAuthority, assertAssistantDispatchAuthority } from "../assistant-session-access.js";
import { isMainAssistant } from "../main-assistant.js";
import { readPendingAssistantRequests } from "../assistant-attention.js";
import { terminalDelegationResult } from "../assistant-delegation-result.js";
import { listAssistantWork } from "../assistant-work.js";
import { launcherDraftAccount } from "../launcher-draft-account.js";
import { launcherCatalog, renderQuickActionPrompt } from "../launcher-actions.js";
import { assemblePreview, clampPreview, messagesPreview } from "../launcher-preview.js";
import { readAuthorizedRecording } from "../recording-library.js";
import { extractCorpusText } from "../corpus/extract.js";
import { isSupportedWorkspaceTextFilePath, normalizeWorkspaceRelativePath } from "./files.js";
import { filterRecordings, searchLauncher, titleScore } from "../launcher-search.js";
import { searchFileContents, searchSessionContents } from "../content-search.js";
import { taskStore } from "../task-store.js";
import { connectedTaskOrgId } from "../tasks-api.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import type { LauncherInvocation } from "@legalwork/types/launcher";
import type { WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext } from "./registry.js";
import type { registerMainAssistantRoutes } from "./main-assistant.js";

function parse<T>(schema: z.ZodType<T>, value: unknown, code: string, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, code, message, parsed.error.issues);
  return parsed.data;
}

export function registerLauncherRoutes(options: Parameters<typeof registerMainAssistantRoutes>[0]) {
  const { config, routes, jsonResponse, quickActions, stagedContext, fileIndex, delegations, sessionQueue, conversations, submissions } = options;
  const read = (ctx: RequestContext) => options.requireClientScope(ctx, "viewer");
  addRoute(routes, "GET", "/launcher/draft-account", "client", async ctx => {
    read(ctx);
    return jsonResponse({ account: await launcherDraftAccount(config) });
  });
  const write = (ctx: RequestContext) => { options.ensureWritable(config); options.requireClientScope(ctx, "collaborator"); };
  const workspaceFor = async (ctx: RequestContext, id: string, method = "GET") => {
    await options.guardLauncherWorkspace(ctx, id, method);
    return options.resolveWorkspace(config, id);
  };
  const visibleFolders = async (ctx: RequestContext) => {
    const folders = options.searchFolders.list();
    const allowed = await Promise.all(folders.map(folder => options.launcherFolderVisible(ctx, folder.path)));
    return folders.filter((_folder, i) => allowed[i]);
  };
  const folderRoot = async (ctx: RequestContext, id: string) => {
    const folder = await options.searchFolders.root(id);
    if (!await options.launcherFolderVisible(ctx, folder.path)) throw new ApiError(404, "search_folder_missing", "Search folder not found.");
    return folder;
  };
  const guardRaycastResult = async (ctx: RequestContext, invocation: LauncherInvocation) => {
    const restricted: RequestContext = { ...ctx, actor: { type: "remote", scope: "collaborator" } };
    if (invocation.projectId) await workspaceFor(restricted, invocation.projectId);
    const result = invocation.result;
    if (result?.workspaceId && result.kind !== "recordings") await workspaceFor(restricted, result.workspaceId);
    if (result?.folderId) await folderRoot(restricted, result.folderId);
  };
  addRoute(routes, "POST", "/launcher/raycast/handoff", "client", async ctx => {
    if (!ctx.tokens.requestHasRaycastToken(ctx.request)) throw new ApiError(401, "unauthorized", "Raycast is no longer paired.");
    const input = parse(LauncherInvocationSchema, await options.readJsonBodyLimited(ctx.request, 24_000), "invalid_invocation", "Invalid Raycast command.");
    if (input.source !== "raycast" || input.workspaceContext || input.captureSelection || input.raycastServerInstanceId || !["ask", "open", "resume", "quick-action"].includes(input.action))
      throw new ApiError(400, "invalid_invocation", "Invalid Raycast command.");
    await guardRaycastResult(ctx, input);
    const id = ctx.tokens.stageRaycast(ctx.request, input);
    if (!id) throw new ApiError(401, "unauthorized", "Raycast is no longer paired.");
    return jsonResponse({ id });
  });
  addRoute(routes, "POST", "/launcher/raycast/handoff/:handoffId", "host-token", async ctx => {
    if (ctx.actor?.type !== "host") throw new ApiError(401, "unauthorized", "Invalid host token.");
    const invocation = ctx.tokens.consumeRaycast(ctx.params.handoffId);
    if (!invocation) throw new ApiError(404, "expired_invocation", "Open the command again in Raycast.");
    await guardRaycastResult(ctx, invocation);
    const response = jsonResponse({ invocation });
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  const projectName = (workspace: WorkspaceInfo) => (isMainAssistant(workspace) ? options.assistant.profile().name : null) ?? (workspace.displayName || workspace.name);
  addRoute(routes, "GET", "/launcher/assistant-availability", "client", async ctx => {
    read(ctx);
    return jsonResponse({ included: await assistantSubscriptionAvailable(config) });
  });
  addRoute(routes, "POST", "/launcher/documents", "client", async ctx => {
    write(ctx);
    const input = parse(z.object({ workspaceId: z.string().min(1), operationId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/), folder: z.string().max(4096), name: z.string().trim().min(1).max(200), format: z.enum(["md", "txt", "docx"]), templatePath: z.string().max(4096).optional(), text: z.string().max(500_000) }), await options.readJsonBodyLimited(ctx.request, 2_100_000), "document_input", "Choose a project, folder and document name.");
    const target = await workspaceFor(ctx, input.workspaceId, "POST");
    const result = await createLauncherDocument(workspaceContentPath(target), input, async path => { await options.requireApproval(ctx, { workspaceId: target.id, action: "workspace.file.write", summary: `Create ${input.name}`, paths: [path] }); }, target.path);
    await recordAudit(target.path, { id: shortId(), workspaceId: target.id, actor: ctx.actor ?? { type: "remote" }, action: "workspace.file.write", target: result.path, summary: `Created ${input.name}`, timestamp: Date.now() });
    fileIndex.invalidate(target.id);
    void fileIndex.ensure(target.id, workspaceContentPath(target), false).catch(() => undefined);
    return jsonResponse(result, 201);
  });
  addRoute(routes, "GET", "/launcher/folders", "client", async ctx => { read(ctx); return jsonResponse({ folders: await visibleFolders(ctx) }); });
  // Read-only validation of cached recent files and configured search roots.
  addRoute(routes, "POST", "/launcher/files/visible", "client", async ctx => {
    read(ctx);
    const { items } = parse(z.object({ items: z.array(LauncherSearchResultSchema).max(100) }), await options.readJsonBodyLimited(ctx.request, 256_000), "launcher_files", "Choose files to check.");
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      if (item.kind !== "files") continue;
      const key = item.folderId ? `folder:${item.folderId}` : `workspace:${item.workspaceId}`;
      const group = groups.get(key) ?? [];
      group.push(item); groups.set(key, group);
    }
    const visible = await Promise.all([...groups.values()].map(async group => {
      const first = group[0];
      try {
        const folder = first.folderId ? await folderRoot(ctx, first.folderId) : null;
        const workspace = !folder && first.workspaceId ? await workspaceFor(ctx, first.workspaceId) : null;
        const root = folder?.path ?? (workspace ? workspaceContentPath(workspace) : undefined);
        const sourceKind = folder ? "folder" : workspace?.preset === "wiki" ? "wiki" : "project";
        return root ? (await existingLauncherFiles(root, group)).map(item => ({ ...item, sourceKind, subtitle: folder?.name ?? (workspace ? projectName(workspace) : item.subtitle) })) : [];
      } catch { return []; }
    }));
    return jsonResponse({ items: visible.flat() });
  });
  addRoute(routes, "GET", "/launcher/browse", "client", async ctx => {
    read(ctx);
    const input = parse(z.object({ workspaceId: z.string().min(1).optional(), folderId: z.string().min(1).optional(), path: z.string().max(4096).default("") }), Object.fromEntries(ctx.url.searchParams), "launcher_browse", "Choose a project or search folder.");
    if (Boolean(input.workspaceId) === Boolean(input.folderId)) throw new ApiError(400, "launcher_browse", "Choose one project or search folder.");
    const folder = input.folderId ? await folderRoot(ctx, input.folderId) : null;
    const workspace = input.workspaceId ? await workspaceFor(ctx, input.workspaceId) : null;
    const root = folder?.path ?? (workspace ? workspaceContentPath(workspace) : undefined);
    if (!root) throw new ApiError(404, "launcher_browse", "Folder unavailable.");
    return jsonResponse(await browseLauncherDirectory({ root, path: input.path, workspaceId: workspace?.id ?? null, folderId: folder?.id, sourceKind: folder ? "folder" : workspace?.preset === "wiki" ? "wiki" : "project", name: folder?.name ?? (workspace ? projectName(workspace) : "") }));
  });
  addRoute(routes, "POST", "/launcher/folders", "client", async ctx => {
    options.ensureWritable(config); options.requireClientScope(ctx, "owner");
    const input = parse(z.object({ path: z.string().trim().min(1).max(4096), name: z.string().trim().max(160).optional() }), await options.readJsonBodyLimited(ctx.request, 8000), "search_folder_input", "Choose a folder to search.");
    const folder = await options.searchFolders.add(input.path, input.name);
    void fileIndex.ensure(`folder:${folder.id}`, folder.path).catch(() => undefined);
    return jsonResponse({ folder }, 201);
  });
  addRoute(routes, "DELETE", "/launcher/folders/:id", "client", async ctx => {
    options.ensureWritable(config); options.requireClientScope(ctx, "owner");
    options.searchFolders.remove(ctx.params.id); fileIndex.invalidate(`folder:${ctx.params.id}`);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "GET", "/launcher/folders/:id/file", "client", async ctx => {
    read(ctx);
    await folderRoot(ctx, ctx.params.id);
    const file = await options.searchFolders.file(ctx.params.id, ctx.url.searchParams.get("path") ?? "");
    return jsonResponse({ path: file.absolute });
  });
  addRoute(routes, "POST", "/launcher/folders/:id/attach", "client", async ctx => {
    write(ctx);
    const input = parse(z.object({ path: z.string().min(1).max(4096), workspaceId: z.string().min(1).max(200).optional() }), await options.readJsonBodyLimited(ctx.request, 8000), "search_folder_file", "Choose a file to attach.");
    await folderRoot(ctx, ctx.params.id);
    const file = await options.searchFolders.file(ctx.params.id, input.path);
    if (file.info.size > 64 * 1024 * 1024) throw new ApiError(413, "attachment_size", "Choose a file smaller than 64 MiB.");
    const workspace = input.workspaceId ? await workspaceFor(ctx, input.workspaceId, "POST") : await options.assistant.workspace();
    const name = basename(file.absolute), folder = `.legalwork/attachments/${randomUUID()}`;
    const destination = await launcherDestination(workspace.path, folder, true);
    await writeFile(resolve(destination, name), await readFile(file.absolute), { flag: "wx", mode: 0o600 });
    return jsonResponse({ item: { id: `ref_${randomUUID()}`, type: "file", workspaceId: workspace.id, path: `${folder}/${name}`, name,
      revision: `${file.info.mtimeMs}:${file.info.size}`, sourceLabel: `${file.folder.name} · ${input.path}` } }, 201);
  });
  const accessible = async (ctx: RequestContext, sourceKind?: z.infer<typeof LauncherFileSourceKindSchema>) => {
    const candidates = config.workspaces.filter(workspace => !isMainAssistant(workspace) && (!sourceKind || sourceKind === (workspace.preset === "wiki" ? "wiki" : "project")));
    const results = await Promise.allSettled(candidates.map(workspace => workspaceFor(ctx, workspace.id)));
    const workspaces: WorkspaceInfo[] = [], unavailable: string[] = [];
    results.forEach((result, index) => { if (result.status === "fulfilled") workspaces.push(result.value); else if (!(result.reason instanceof ApiError && [403, 404].includes(result.reason.status))) unavailable.push(candidates[index].id); });
    return { workspaces, unavailable };
  };
  const recordings = (ctx: RequestContext) => {
    const list = config.recorder?.listRecordings;
    if (!list) return null;
    // The desktop owner can pair Raycast to discover recordings. The token
    // stays collaborator-scoped and cannot read a recording or its transcript.
    const paired = ctx.tokens.requestHasRaycastToken(ctx.request);
    if (!paired) {
      try { options.requireClientScope(ctx, "owner"); }
      catch (error) {
        if (error instanceof ApiError && [401, 403].includes(error.status)) return null;
        throw error;
      }
    }
    return async (query: string) => {
      const access = await options.launcherRecordingAccess(ctx);
      const items = filterRecordings((await list()).filter(meta => !meta.ephemeral && access.visible(meta)).map(meta => ({ id: meta.id, title: meta.title, createdAt: meta.createdAt, durationMs: meta.durationMs, projectIds: meta.projectIds ?? [], status: meta.status })), query).slice(0, 200);
      await access.check();
      if (paired && !ctx.tokens.requestHasRaycastToken(ctx.request)) return [];
      return items;
    };
  };
  addRoute(routes, "GET", "/launcher/search", "client", async ctx => {
    read(ctx);
    const input = parse(z.object({ q: z.string().trim().max(300).default(""), kinds: z.string().max(100).optional(), projectId: z.string().max(200).optional(), content: z.enum(["1", "0"]).optional(), limit: z.coerce.number().int().min(1).max(200).default(80),
      types: z.string().max(200).optional(), since: z.coerce.number().int().positive().optional(), sourceKind: LauncherFileSourceKindSchema.optional(), sort: LauncherSortSchema.optional() }),
      Object.fromEntries(ctx.url.searchParams), "launcher_query", "Check the search query, categories and project scope.");
    const fileTypes = input.types ? input.types.split(",").map(type => type.trim().toLowerCase().replace(/^\./, "")).filter(type => /^[a-z0-9]{1,8}$/.test(type)) : undefined;
    const kinds = input.kinds ? input.kinds.split(",").map(kind => LauncherSearchKindSchema.parse(kind.trim())) : [...LAUNCHER_SEARCH_KINDS];
    const orgId = connectedTaskOrgId(await readEigenweltConnection(config));
    const store = await taskStore(config);
    const folderSources = {
      list: () => visibleFolders(ctx),
      root: (id: string) => folderRoot(ctx, id),
    };
    const [extra, response] = await Promise.all([searchFolderFiles(folderSources, fileIndex, { query: input.q, kinds, projectId: input.projectId, content: input.content === "1", limit: input.limit, fileTypes, modifiedAfter: input.since, sourceKind: input.sourceKind, sort: input.sort },
      (folder, signal) => searchFileContents(folder, input.q, signal, options.preparation), ctx.request.signal), searchLauncher({
      workspaces: () => accessible(ctx, kinds.length === 1 && kinds[0] === "files" ? input.sourceKind : undefined), projectName, fileIndex, recordings: recordings(ctx),
      tasks: async (query, projectId) => store.searchTasks(query, orgId, projectId ?? "", Boolean(projectId)),
      sessionSearch: (workspace, query, signal) => searchSessionContents(config, workspace, query, signal),
      fileContentSearch: (workspace, query, signal) => searchFileContents(workspace, query, signal, options.preparation),
    }, { query: input.q, kinds, projectId: input.projectId, content: input.content === "1", limit: input.limit, fileTypes: fileTypes?.length ? fileTypes : undefined, modifiedAfter: input.since, sourceKind: input.sourceKind, sort: input.sort }, ctx.request.signal)]);
    // The Assistant's own conversations are chats too: resume them in place.
    const assistant = config.workspaces.find(isMainAssistant);
    if (assistant && kinds.includes("chats") && (input.q.length >= 2 || !input.q.trim() && kinds.length === 1) && (!input.projectId || input.projectId === assistant.id)) {
      const page = conversations.list(assistant.id, { query: input.q, limit: 20 });
      for (const conversation of page.items) {
        if (input.since && conversation.updatedAt < input.since) continue;
        const score = titleScore(conversation.title, input.q) ?? { match: "content" as const, score: 300 };
        response.items.push({ id: conversation.id, kind: "chats", workspaceId: assistant.id, sourceId: "assistant", title: conversation.title, subtitle: projectName(assistant), updatedAt: conversation.updatedAt, sessionId: conversation.sessionId, match: score.match, score: score.score, actions: ["resume", "open"] });
      }
      response.sources.push({ id: "chats:assistant", kind: "chats", workspaceId: assistant.id, label: projectName(assistant), coverage: page.nextCursor ? "partial" : "complete", count: page.items.length, limited: Boolean(page.nextCursor) });
      response.items.sort((a, b) => compareLauncherResults(a, b, input.sort));
    }
    response.items.push(...extra.items); response.sources.push(...extra.sources); response.unavailable.push(...extra.unavailable);
    response.items.sort((a, b) => compareLauncherResults(a, b, input.sort));
    response.items = response.items.slice(0, input.limit);
    return jsonResponse(response);
  });
  addRoute(routes, "GET", "/launcher/catalog", "client", async ctx => {
    read(ctx);
    const projectId = ctx.url.searchParams.get("projectId")?.trim() || undefined;
    const groups: { workspaceId: string | null; items: { name: string; description?: string; template?: string; agent?: string }[] }[] = [];
    const sources = [config.workspaces.find(isMainAssistant), projectId ? config.workspaces.find(workspace => workspace.id === projectId) : undefined].filter((workspace): workspace is WorkspaceInfo => Boolean(workspace));
    const unavailable: string[] = [];
    for (const source of sources) {
      try {
        const workspace = await workspaceFor(ctx, source.id);
        const result = await options.client(workspace).native.command.list({ location: { directory: workspace.path } }, { signal: AbortSignal.timeout(10000) });
        groups.push({ workspaceId: isMainAssistant(workspace) ? null : workspace.id, items: result.data ?? [] });
      } catch (error) {
        if (!(error instanceof ApiError && [403, 404].includes(error.status))) unavailable.push(source.id);
      }
    }
    return jsonResponse({ entries: launcherCatalog({ commands: groups, quickActions: quickActions.list() }), unavailable });
  });
  // Copy or move a file into another project: explicit, approved and audited like the file routes.
  addRoute(routes, "POST", "/launcher/files/transfer", "client", async ctx => {
    write(ctx);
    const input = parse(LauncherFileTransferInputSchema, await options.readJsonBodyLimited(ctx.request, 16_000), "launcher_transfer", "Name the file, the destination project and copy or move.");
    if (input.sourceWorkspaceId === input.targetWorkspaceId) throw new ApiError(400, "launcher_transfer", "Choose a different project as the destination.");
    const [source, target] = await Promise.all([workspaceFor(ctx, input.sourceWorkspaceId, input.mode === "move" ? "POST" : "GET"), workspaceFor(ctx, input.targetWorkspaceId, "POST")]);
    const relativePath = normalizeWorkspaceRelativePath(input.path, { allowSubdirs: true });
    const sourceRoot = await realpath(workspaceFileRoot(source, relativePath)), sourceFile = await realpath(resolve(sourceRoot, relativePath)).catch(() => null);
    if (!sourceFile || (sourceFile !== sourceRoot && !sourceFile.startsWith(sourceRoot + sep))) throw new ApiError(400, "invalid_path", "The file is outside this project.");
    const sourceInfo = await stat(sourceFile).catch(() => null);
    if (!sourceInfo?.isFile()) throw new ApiError(404, "file_not_found", "File not found");
    const folder = input.folder ? normalizeWorkspaceRelativePath(input.folder, { allowSubdirs: true }) : "";
    const targetRoot = await realpath(workspaceContentPath(target)), destination = resolve(targetRoot, folder, basename(sourceFile));
    await launcherDestination(targetRoot, folder);
    if (!destination.startsWith(targetRoot + sep)) throw new ApiError(400, "invalid_path", "The destination is outside the project.");
    if (await stat(destination).catch(() => null)) throw new ApiError(409, "file_exists", "A file with that name already exists in the destination project.");
    const destinationPath = relative(targetRoot, destination).split("\\").join("/");
    await options.requireApproval(ctx, { workspaceId: target.id, action: "workspace.file.write", summary: `${input.mode === "move" ? "Move" : "Copy"} ${relativePath} from ${projectName(source)} to ${projectName(target)}`, paths: [destination, ...(input.mode === "move" ? [sourceFile] : [])] });
    await launcherDestination(targetRoot, folder, true);
    await copyLauncherTransferFile({ rootPath: workspaceFileRoot(source, relativePath), root: sourceRoot, relativePath, path: sourceFile, info: sourceInfo }, destination, input.mode === "move");
    const actor = ctx.actor ?? { type: "remote" as const };
    await recordAudit(target.path, { id: shortId(), workspaceId: target.id, actor, action: "workspace.file.write", target: destination, summary: `${input.mode === "move" ? "Moved" : "Copied"} ${relativePath} from ${projectName(source)}`, timestamp: Date.now() });
    if (input.mode === "move") await recordAudit(source.path, { id: shortId(), workspaceId: source.id, actor, action: "workspace.file.write", target: sourceFile, summary: `Moved ${relativePath} to ${projectName(target)}`, timestamp: Date.now() });
    fileIndex.invalidate(source.id);
    void fileIndex.ensure(source.id, workspaceContentPath(source), false).catch(() => undefined);
    fileIndex.invalidate(target.id);
    void fileIndex.ensure(target.id, workspaceContentPath(target), false).catch(() => undefined);
    return jsonResponse({ ok: true, path: destinationPath }, 201);
  });
  // Previews read what the result points at; nothing here reaches a model.
  addRoute(routes, "GET", "/launcher/preview", "client", async ctx => {
    read(ctx);
    const input = parse(z.object({ kind: LauncherSearchKindSchema, id: z.string().min(1).max(4096), workspaceId: z.string().max(200).optional(), folderId: z.string().max(100).optional() }), Object.fromEntries(ctx.url.searchParams), "launcher_preview", "Name the result to preview.");
    const signal = AbortSignal.any([ctx.request.signal, AbortSignal.timeout(15_000)]);
    const workspaceOf = async () => { if (!input.workspaceId) throw new ApiError(400, "launcher_preview", "This preview needs a project."); return workspaceFor(ctx, input.workspaceId); };
    const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    if (input.kind === "projects") {
      const workspace = await workspaceOf();
      return jsonResponse(assemblePreview({ kind: "projects", id: workspace.id, title: projectName(workspace), meta: [workspaceContentPath(workspace)], updatedAt: null }, clampPreview(workspaceContentPath(workspace)), "metadata"));
    }
    if (input.kind === "files") {
      if (input.folderId) await folderRoot(ctx, input.folderId);
      const external = input.folderId ? await options.searchFolders.file(input.folderId, input.id) : null;
      const workspace = external ? { id: external.folder.id, path: external.folder.path, name: external.folder.name } : await workspaceOf();
      const relativePath = normalizeWorkspaceRelativePath(input.id, { allowSubdirs: true });
      const root = await realpath(workspaceFileRoot(workspace, relativePath)), absolute = await realpath(resolve(root, relativePath)).catch(() => null);
      if (!absolute || (absolute !== root && !absolute.startsWith(root + sep))) throw new ApiError(400, "invalid_path", "The file is outside this project.");
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) throw new ApiError(404, "file_not_found", "File not found");
      const source = { kind: "files" as const, id: relativePath, title: relativePath.split("/").pop() ?? relativePath, meta: [external?.folder.name ?? workspace.name, relativePath, size(info.size)], updatedAt: info.mtimeMs };
      if (isSupportedWorkspaceTextFilePath(relativePath) && info.size <= 5_000_000) return jsonResponse(assemblePreview(source, clampPreview(await readFile(absolute, "utf8")), "text"));
      try {
        const prepared = await extractCorpusText(workspace, relativePath, options.preparation, signal);
        if (prepared.text.trim()) return jsonResponse(assemblePreview(source, clampPreview(prepared.text), "prepared"));
      } catch { /* metadata only */ }
      return jsonResponse(assemblePreview({ ...source, meta: [...source.meta, extname(relativePath).replace(/^\./, "").toUpperCase()] }, { text: "", truncated: false }, "metadata"));
    }
    if (input.kind === "chats") {
      const workspace = await workspaceOf();
      const client = options.client(workspace);
      const session = await client.session.get({ sessionID: input.id }, { throwOnError: true, signal });
      if (!session.data || session.data.time.archived || resolve(session.data.directory) !== resolve(workspace.path)) throw new ApiError(404, "session_not_found", "This chat is no longer available in this project.");
      const messages = await client.session.messages({ sessionID: input.id, limit: 12 }, { throwOnError: true, signal });
      const turns = (messages.data ?? []).map(message => ({ role: message.info.role, time: message.info.time.created, text: message.parts.flatMap(part => part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []).join("\n") }));
      return jsonResponse(assemblePreview({ kind: "chats", id: input.id, title: session.data?.title ?? input.id, meta: [projectName(workspace)], updatedAt: session.data?.time.updated ?? null }, messagesPreview(turns), "messages"));
    }
    if (input.kind === "tasks") {
      const task = (await taskStore(config)).getTask(input.id);
      if (!task || task.deletedAt) throw new ApiError(404, "task_not_found", "This task no longer exists.");
      const meta = [task.status, task.dueDate ? `Due ${task.dueDate.slice(0, 10)}` : null, task.assigneeName, ...task.tags].filter((value): value is string => Boolean(value));
      return jsonResponse(assemblePreview({ kind: "tasks", id: task.id, title: task.title, meta, updatedAt: Date.parse(task.updatedAt) || null }, clampPreview(task.description), "metadata"));
    }
    options.requireClientScope(ctx, "owner");
    const access = await options.launcherRecordingAccess(ctx);
    const detail = await readAuthorizedRecording(config, input.id, access.authorize);
    await access.check();
    const meta = [new Date(detail.meta.createdAt).toLocaleString("en-GB"), `${Math.round(detail.meta.durationMs / 60_000)} min`, detail.meta.status].filter((value): value is string => Boolean(value));
    return jsonResponse(assemblePreview({ kind: "recordings", id: detail.meta.id, title: detail.meta.title, meta, updatedAt: detail.meta.createdAt }, clampPreview(detail.segments.filter(segment => segment.final).map(segment => segment.text).join("\n")), "transcript"));
  });
  addRoute(routes, "GET", "/launcher/actions", "client", async ctx => { read(ctx); return jsonResponse({ actions: quickActions.list() }); });
  addRoute(routes, "POST", "/launcher/actions", "client", async ctx => {
    write(ctx);
    const input = parse(QuickActionInputSchema, await options.readJsonBodyLimited(ctx.request, 32_000), "quick_action_input", "Provide a name, prompt, inputs and output for the quick action.");
    return jsonResponse({ action: quickActions.create(input) }, 201);
  });
  addRoute(routes, "PATCH", "/launcher/actions/:id", "client", async ctx => {
    write(ctx);
    const patch = parse(QuickActionInputSchema.partial(), await options.readJsonBodyLimited(ctx.request, 32_000), "quick_action_input", "Check the quick action fields.");
    return jsonResponse({ action: quickActions.update(ctx.params.id, patch) });
  });
  addRoute(routes, "DELETE", "/launcher/actions/:id", "client", async ctx => { write(ctx); quickActions.remove(ctx.params.id); return jsonResponse({ ok: true }); });
  addRoute(routes, "POST", "/launcher/actions/:id/used", "client", async ctx => { write(ctx); return jsonResponse({ action: quickActions.recordUse(ctx.params.id) }); });
  addRoute(routes, "POST", "/launcher/actions/:id/render", "client", async ctx => {
    read(ctx);
    const action = quickActions.get(ctx.params.id);
    if (!action) throw new ApiError(404, "quick_action_not_found", "This quick action no longer exists.");
    const inputs = parse(z.object({ selection: z.string().max(200_000).optional(), clipboard: z.string().max(200_000).optional(), files: z.array(z.string().max(4096)).max(50).optional(), arguments: z.string().max(8000).optional() }),
      await options.readJsonBodyLimited(ctx.request, 512 * 1024), "quick_action_render", "Provide the action inputs.");
    return jsonResponse({ prompt: renderQuickActionPrompt(action, inputs), action });
  });
  // Staged context: external entry points hand over an opaque reference, never the content itself.
  addRoute(routes, "POST", "/launcher/context", "client", async ctx => {
    write(ctx);
    const input = parse(z.object({ items: z.array(AssistantContextItemSchema).min(1).max(20), source: LauncherInvocationSourceSchema, ttlMs: z.number().int().min(1000).max(30 * 60_000).optional() }),
      await options.readJsonBodyLimited(ctx.request, 2 * 1024 * 1024), "launcher_context", "Provide at least one context item.");
    const staged = stagedContext.stage(input.items, input.source, input.ttlMs);
    return jsonResponse({ id: staged.id, expiresAt: staged.expiresAt, items: staged.items.length }, 201);
  });
  addRoute(routes, "POST", "/launcher/context/:id/consume", "client", async ctx => {
    write(ctx);
    const staged = stagedContext.consume(ctx.params.id);
    if (!staged) throw new ApiError(404, "launcher_context_expired", "This staged context has expired or was already used.");
    return jsonResponse(staged);
  });
  addRoute(routes, "POST", "/launcher/invocations", "client", async ctx => {
    write(ctx);
    const invocation = parse(LauncherInvocationSchema, await options.readJsonBodyLimited(ctx.request, 16_000), "launcher_invocation", "Provide a valid launcher invocation.");
    if (invocation.projectId && !config.workspaces.some(workspace => workspace.id === invocation.projectId)) throw new ApiError(404, "workspace_not_found", "The requested project is unknown.");
    const fresh = stagedContext.rememberInvocation(invocation.id);
    return jsonResponse({ invocation, duplicate: !fresh, context: invocation.contextId ? stagedContext.peek(invocation.contextId) : null });
  });
  // Work: every delegated job with its origin, exact destination and live status.
  const sourceWorkspace = async (ctx: RequestContext) => {
    const source = config.workspaces.find(isMainAssistant);
    if (!source) return null;
    await workspaceFor(ctx, source.id);
    return source;
  };
  type WorkList = Awaited<ReturnType<typeof listAssistantWork>>;
  const snapshots = new Map<string, { key: string; expires: number; items: WorkList }>();
  addRoute(routes, "GET", "/assistant/work", "client", async ctx => {
    read(ctx);
    const filter = parse(z.object({ status: AssistantWorkStatusSchema.optional(), projectId: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(40), offset: z.coerce.number().int().nonnegative().default(0) }), Object.fromEntries(ctx.url.searchParams), "work_query", "Check the work filters.");
    const source = await sourceWorkspace(ctx);
    if (!source) return jsonResponse({ items: [] });
    const key = JSON.stringify([ctx.actor, source.id, filter.projectId, filter.status]);
    const page = (items: WorkList, snapshot?: string) => {
      const end = filter.offset + filter.limit;
      return jsonResponse({ items: items.slice(filter.offset, end), nextOffset: end < items.length ? end : null, snapshot });
    };
    const cursor = ctx.url.searchParams.get("snapshot");
    if (cursor) {
      const saved = snapshots.get(cursor);
      if (!saved || saved.key !== key || saved.expires <= Date.now()) throw new ApiError(409, "work_expired", "Refresh the work list.");
      const projects = new Set(saved.items.slice(filter.offset, filter.offset + filter.limit).map(item => item.workspaceId));
      await Promise.all([...projects].map(id => options.guardLauncherWorkspace(ctx, id, "GET")));
      return page(saved.items, cursor);
    }
    const tracked = delegations.list(source.id).filter(delegation => !filter.projectId || delegation.workspaceId === filter.projectId);
    const allowed = new Set<string>();
    await Promise.all([...new Set(tracked.map(job => job.workspaceId))].map(async id => {
      try {
        await options.guardLauncherWorkspace(ctx, id, "GET");
        allowed.add(id);
      } catch (error) {
        if (!(error instanceof ApiError && [403, 404].includes(error.status))) throw error;
      }
    }));
    const statusesByProject = new Map<string, ReturnType<ReturnType<typeof options.client>["session"]["status"]>>();
    const items = await listAssistantWork(tracked.filter(job => allowed.has(job.workspaceId)), {
      originConversationId: sessionId => conversations.bySession(source.id, sessionId)?.id ?? null,
      inspect: async delegation => {
        const workspace = await options.resolveWorkspace(config, delegation.workspaceId);
        const client = options.client(workspace);
        const session = await client.session.get({ sessionID: delegation.sessionId }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
        const available = Boolean(session.data && !session.data.time.archived && resolve(session.data.directory) === resolve(workspace.path));
        if (!available) return { title: delegation.title, projectName: projectName(workspace), createdAt: null, updatedAt: null, queuedMessages: 0, available: false, busy: false, result: null, pendingAttention: 0 };
        const common = { title: session.data?.title ?? delegation.title, projectName: projectName(workspace), createdAt: session.data?.time.created ?? null, updatedAt: session.data?.time.updated ?? null, queuedMessages: sessionQueue.list({ workspaceId: delegation.workspaceId, sessionId: delegation.sessionId }).length };
        let statusesPromise = statusesByProject.get(workspace.id);
        if (!statusesPromise) {
          statusesPromise = client.session.status({}, { throwOnError: true, signal: AbortSignal.timeout(10000) });
          statusesByProject.set(workspace.id, statusesPromise);
        }
        const [statuses, messages, attention] = await Promise.all([
          statusesPromise,
          client.session.messages({ sessionID: delegation.sessionId, limit: 1 }, { throwOnError: true, signal: AbortSignal.timeout(10000) }),
          readPendingAssistantRequests(client, delegation.sessionId),
        ]);
        const status = statuses.data?.[delegation.sessionId];
        const busy = Boolean(status && status.type !== "idle");
        const result = terminalDelegationResult(messages.data?.at(-1), delegation.sessionId, !busy);
        return { ...common, available: true, busy, result, pendingAttention: attention.permissions.length + attention.questions.length };
      },
    }, { status: filter.status, projectId: filter.projectId });
    if (items.length <= filter.offset + filter.limit) return page(items);
    for (const [id, entry] of snapshots) if (entry.expires <= Date.now() || snapshots.size >= 32) snapshots.delete(id);
    const snapshot = randomUUID();
    snapshots.set(snapshot, { key, items, expires: Date.now() + 60_000 });
    return page(items, snapshot);
  });
  addRoute(routes, "POST", "/assistant/work/:workspaceId/:sessionId/:action", "client", async ctx => {
    write(ctx);
    const source = await sourceWorkspace(ctx);
    if (!source) throw new ApiError(404, "assistant_missing", "The Assistant is unavailable.");
    const delegation = delegations.list(source.id).find(item => item.workspaceId === ctx.params.workspaceId && item.sessionId === ctx.params.sessionId);
    if (!delegation) throw new ApiError(404, "attention_scope", "This chat was not delegated by your Assistant.");
    const workspace = await workspaceFor(ctx, delegation.workspaceId);
    const authority = await assistantRequestAuthority(config, ctx.request, ctx.actor);
    assertAssistantDispatchAuthority(authority, workspace.id);
    await options.sessionAccess.checkDirectory(workspace.path, authority);
    const action = parse(z.enum(["stop", "redirect", "reply"]), ctx.params.action, "work_action", "Stop, redirect or reply to one job.");
    const body = ctx.request.body ? await options.readJsonBodyLimited(ctx.request, 20_000) : {};
    const prompt = parse(z.string().trim().min(1).max(12000).optional(), body.prompt, "work_prompt", "Provide the instruction.");
    const requestId = parse(z.string().min(1).max(200).optional(), body.requestId, "work_request", "Provide a request ID.");
    const destination = { workspaceId: delegation.workspaceId, sessionId: delegation.sessionId };
    if (action === "stop") { const result = await sessionQueue.stop(destination); options.changed(); return jsonResponse({ ok: true, ...result }); }
    if (!prompt) throw new ApiError(400, "work_prompt", "Provide the user's instruction before replying or redirecting.");
    const receipt = sessionQueue.receipt(destination, prompt, requestId);
    if (receipt) return jsonResponse({ ok: true, status: receipt.state, message: receipt });
    if (action === "redirect") await sessionQueue.stop(destination);
    const message = await sessionQueue.submit(destination, prompt, authority, requestId);
    options.changed();
    return jsonResponse({ ok: true, status: message.state, message });
  });
  // The execution target bound to a conversation's latest request: the server, not the prompt, is the boundary.
  addRoute(routes, "GET", "/assistant/conversations/:id/constraint", "client", async ctx => {
    read(ctx);
    const source = await sourceWorkspace(ctx);
    const conversation = source ? conversations.find(source.id, ctx.params.id) : null;
    if (!conversation) throw new ApiError(404, "conversation_not_found", "This conversation is no longer available.");
    return jsonResponse({ target: submissions.constraint(conversation.sessionId) });
  });
}
