import { isViewFile, copyViewFile } from "../views/schema.js";
import { viewSaveSource, recordViewSaveSource } from "../views/save-source.js";
import { registerWikiProjectRoutes } from "./wiki-projects.js";
import { registerWikiSuggestionRoutes } from "./wiki-suggestions.js";
import { z } from "zod";
import { legalResearchCountries } from "../native-shared-values.js";
import { ViewSaveInputSchema, WikiDataQuerySchema } from "../views/schema.js";
import { ViewRepository } from "../views/repository.js";
import { queryWikiPages, wikiPageFields } from "../wiki/data-query.js";
import { wikiPropertiesPatchSchema } from "../wiki/properties.js";
import { authenticateWikiAgentRequest } from "../wiki/agent-access.js";
import { approveWikiWrite } from "../wiki/write-approval.js";
import type { WikiRegistration, WikiSharingInput, WikiSnapshot, WikiSyncStatus, WikiTeamOverview, WikiTeamRecord, WikiVault } from "@legalwork/types/wiki";
import { ApiError } from "../errors.js";
import type { ApprovalRequest, ServerConfig, TokenScope } from "../types.js";
import { WikiStore, wikiAssetContentType, WIKI_MAX_ASSET_BYTES, WIKI_MAX_PAGE_BYTES } from "../wiki/store.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type Options = {
  routes: Route[];
  config: ServerConfig;
  store?: WikiStore;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
  ensureWikiReadable?: (ctx: RequestContext, wiki: WikiRegistration) => Promise<void>;
  ensureWikiWritable?: (ctx: RequestContext, wiki: WikiRegistration) => Promise<void>;
  onChanged?: (id: string) => void;
  onWorkspacesChanged?: () => void;
  getSyncStatus?: (id: string) => WikiSyncStatus | Promise<WikiSyncStatus>;
  syncWiki?: (id: string) => Promise<WikiSyncStatus>;
  team?: () => Promise<WikiTeamOverview>;
  sharing?: (id: string) => Promise<WikiTeamRecord | null>;
  pendingSharing?: (id: string) => Promise<WikiSharingInput | null>;
  share?: (id: string, input: WikiSharingInput) => Promise<WikiTeamRecord>;
  updateSharing?: (id: string, input: WikiSharingInput) => Promise<WikiTeamRecord>;
  stopSharing?: (id: string) => Promise<void>;
  join?: (input: { wikiId: string; root?: string }) => Promise<WikiRegistration>;
  rename?: (id: string, name: string) => Promise<void>;
};
const sharingSchema = z.object({ access: z.enum(["org", "members"]), memberIds: z.array(z.string().min(1).max(200)).max(500) });
const createSchema = z.object({
  name: z.string().trim().min(1).max(200), root: z.string().trim().min(1).max(4096).optional(),
  template: z.enum(["firm", "blank", "legal-research"]).optional(), sharing: sharingSchema.optional(), attach: z.boolean().optional(),
  language: z.enum(["en", "de"]).optional(),
  country: z.string().refine(value => value === "OTHER" || legalResearchCountries.includes(value)).optional(),
}).strict();
const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(), allowInProjects: z.boolean().optional(), requireAgentApproval: z.boolean().optional(), projectWorkspaceIds: z.array(z.string().min(1).max(200)).max(1000).nullable().optional(),
}).strict();
const writeSchema = z.object({ path: z.string().min(1), content: z.string(), baseRevision: z.string().max(100).nullable().optional() });
const deleteSchema = z.object({ path: z.string().min(1), baseRevision: z.string().min(1).max(100) });
const restoreSchema = z.object({ path: z.string().min(1), revisionId: z.string().uuid(), baseRevision: z.string().max(100).nullable().optional() });
const assetSchema = z.object({ path: z.string().min(1), dataBase64: z.string(), baseRevision: z.string().max(100).nullable().optional() });
const entryOperationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create-folder"), path: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.enum(["move", "copy"]), path: z.string().min(1).max(4096), destination: z.string().min(1).max(4096), baseRevision: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("trash"), path: z.string().min(1).max(4096), baseRevision: z.string().min(1).max(100) }).strict(),
  z.object({ action: z.literal("restore"), trashId: z.string().uuid() }).strict(),
]);
const owner = (ctx: RequestContext) => ctx.actor?.type === "host" || ctx.actor?.scope === "owner";
const editor = (ctx: RequestContext) => owner(ctx) || ctx.actor?.scope === "collaborator";

export function registerWikiRoutes(options: Options): WikiStore {
  const { routes, config, jsonResponse, readJsonBodyLimited, ensureWritable, requireClientScope, requireApproval } = options;
  const store = options.store ?? new WikiStore(config);
  registerWikiSuggestionRoutes({ ...options, store });
  const visible = (ctx: RequestContext, wiki: WikiRegistration) => owner(ctx) || wiki.sync !== null;
  const selected = async (ctx: RequestContext, writing = false): Promise<WikiRegistration> => {
    const wiki = await store.get(ctx.params.wikiId);
    if (!visible(ctx, wiki)) throw new ApiError(404, "wiki_not_found", "This wiki is not available to this client.");
    await options.ensureWikiReadable?.(ctx, wiki);
    if (writing) {
      requireClientScope(ctx, "collaborator");
      ensureWritable(config);
      await options.ensureWikiWritable?.(ctx, wiki);
    }
    return wiki;
  };
  registerWikiProjectRoutes({ routes, config, store, selected, jsonResponse });
  const vault = async (ctx: RequestContext, snapshot: WikiSnapshot): Promise<WikiVault> => {
    let writable = !config.readOnly && editor(ctx);
    if (writable && options.ensureWikiWritable) {
      try { await options.ensureWikiWritable(ctx, snapshot.wiki); } catch { writable = false; }
    }
    const sharing = options.sharing ? await options.sharing(snapshot.wiki.id).catch(() => null) : null;
    const pendingSharing = owner(ctx) && options.pendingSharing ? await options.pendingSharing(snapshot.wiki.id).catch(() => null) : null;
    return { ...snapshot.wiki, writable, sharing, pendingSharing, syncStatus: options.getSyncStatus ? await options.getSyncStatus(snapshot.wiki.id) : snapshot.wiki.syncStatus };
  };
  const change = (id: string) => { options.onChanged?.(id); };
  const authorize = async (ctx: RequestContext, wiki: WikiRegistration, action: string, paths: string[], proposal?: unknown) => {
    const preview = proposal === undefined ? undefined : JSON.stringify(proposal, null, 2);
    await approveWikiWrite(ctx, config, wiki, { workspaceId: wiki.workspaceId, action, summary: `${action.replace("wiki.", "")} in ${wiki.name}`, paths,
      ...(preview ? { description: preview.length <= 16_000 ? preview : preview.slice(0, 16_000) + "\n[Preview truncated. Review the complete proposal in the tool call before allowing.]" } : {}),
    }, requireApproval);
    // Permissions can change while a human is reviewing the pending proposal.
    const currentAgent = await authenticateWikiAgentRequest(config, ctx.request);
    if (currentAgent) ctx.actor = currentAgent.actor;
    await selected(ctx, true);
  };
  const queryPath = (ctx: RequestContext, bodyPath?: string) => {
    const query = ctx.url.searchParams.get("path");
    if (query && bodyPath && query !== bodyPath) throw new ApiError(400, "invalid_wiki_path", "The query and body must refer to the same file.");
    const path = query || bodyPath;
    if (!path) throw new ApiError(400, "invalid_wiki_path", "Provide a wiki file path.");
    return path;
  };
  const sharingUnavailable = () => new ApiError(503, "wiki_sharing_unavailable", "Wiki sharing is unavailable on this server.");
  addRoute(routes, "POST", "/wikis/legal-research/ensure", "host-token", async ctx => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const input = z.object({ language: z.enum(["en", "de"]), country: z.string().refine(value => value === "OTHER" || legalResearchCountries.includes(value)).optional() }).strict().safeParse(await readJsonBodyLimited(ctx.request, 1024));
    if (!input.success) throw new ApiError(400, "invalid_wiki_language", "Choose English or German for the research wiki.");
    const result = await store.ensureLegalResearch(input.data.language, input.data.country);
    if (result.created) options.onWorkspacesChanged?.();
    if ((result.created || result.updated) && result.wiki) change(result.wiki.id);
    return jsonResponse(result);
  });
  addRoute(routes, "GET", "/wikis/deleted", "client", async ctx => {
    requireClientScope(ctx, "owner");
    return jsonResponse({ items: await store.deleted() });
  });
  addRoute(routes, "POST", "/wikis/:wikiId/archive", "client", async ctx => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const input = z.object({ removeOnly: z.boolean().optional() }).strict().safeParse(await readJsonBodyLimited(ctx.request, 1024));
    if (!input.success) throw new ApiError(400, "invalid_wiki_deletion", "Choose whether to delete this wiki or remove your local copy.");
    const wiki = await store.get(ctx.params.wikiId);
    if (wiki.sync && !input.data.removeOnly) {
      if (!("kind" in wiki.sync) || (await options.sharing?.(wiki.id))?.role !== "owner")
        throw new ApiError(403, "wiki_owner_required", "Only the wiki owner can delete a shared wiki. You can remove your local copy.");
      if (!options.stopSharing) throw sharingUnavailable();
      await options.stopSharing(wiki.id);
    }
    await store.archive(wiki.id);
    options.onWorkspacesChanged?.(); change(wiki.id);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", "/wikis/:wikiId/restore-wiki", "client", async ctx => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const entry = (await store.deleted()).find(item => item.wiki.id === ctx.params.wikiId);
    if (!entry) throw new ApiError(404, "wiki_not_found", "This wiki is no longer in Recently deleted.");
    await options.ensureWikiReadable?.(ctx, entry.wiki);
    const wiki = await store.restoreWiki(entry.wiki.id);
    options.onWorkspacesChanged?.(); change(wiki.id);
    return jsonResponse({ wiki: await vault(ctx, await store.snapshot(wiki.id)) });
  });

  const views = (id: string) => new ViewRepository({ kind: "wiki", id }, {
    dashboardFolder: async () => "Dashboards",
    list: async () => (await store.files(id)).map(file => file.path),
    read: path => store.readAsset(id, path),
    write: async (path, bytes, revision) => { await store.writeAsset(id, path, bytes, revision); },
  });
  const viewInput = async (ctx: RequestContext) => {
    const result = ViewSaveInputSchema.safeParse(await readJsonBodyLimited(ctx.request, 2 * 1024 * 1024));
    if (!result.success) throw new ApiError(400, "invalid_view", "Check the view title, program and data bindings.");
    return result.data;
  };
  addRoute(routes, "POST", "/wikis/:wikiId/query", "client", async ctx => {
    const wiki = await selected(ctx);
    const parsed = WikiDataQuerySchema.safeParse(await readJsonBodyLimited(ctx.request, 64 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_query", "Check the selected fields, filters and page size.");
    return jsonResponse({ ...queryWikiPages(await store.indexedPages(wiki.id), parsed.data), sourceOwner: { kind: "wiki", id: wiki.id } });
  });
  addRoute(routes, "PATCH", "/wikis/:wikiId/properties", "client", async ctx => {
    const wiki = await selected(ctx, true);
    const parsed = z.object({ path: z.string().min(1).max(4096), baseRevision: z.string().min(1).max(200), patch: wikiPropertiesPatchSchema }).strict().safeParse(await readJsonBodyLimited(ctx.request, 128 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_properties", "Choose fields to set or remove and provide the current page revision.");
    await authorize(ctx, wiki, "wiki.properties.update", [parsed.data.path], parsed.data);
    const document = await store.updateProperties(wiki.id, parsed.data.path, parsed.data.patch, parsed.data.baseRevision);
    change(wiki.id);
    return jsonResponse(document);
  });
  addRoute(routes, "GET", "/wikis/:wikiId/fields", "client", async ctx => {
    const wiki = await selected(ctx);
    return jsonResponse(wikiPageFields(await store.indexedPages(wiki.id)));
  });
  addRoute(routes, "GET", "/wikis/:wikiId/ui-views", "client", async ctx => {
    const wiki = await selected(ctx);
    return jsonResponse(await views(wiki.id).list());
  });
  addRoute(routes, "GET", "/wikis/:wikiId/ui-views/:viewId", "client", async ctx => {
    const wiki = await selected(ctx);
    return jsonResponse(await views(wiki.id).read(ctx.params.viewId));
  });
  addRoute(routes, "POST", "/wikis/:wikiId/ui-views", "client", async ctx => {
    if (ctx.request.headers.has("x-legalwork-wiki-agent-token")) throw new ApiError(403, "human_save_required", "Only the user can save a dashboard or report. Return a preview first.");
    const wiki = await selected(ctx, true), input = await viewInput(ctx);
    if (input.mode === "report" && Object.keys(input.queries).length) {
      const pages = await store.indexedPages(wiki.id);
      input.datasets = { ...input.datasets, ...Object.fromEntries(Object.entries(input.queries).map(([name, query]) => [name, input.datasets?.[name] ?? { ...queryWikiPages(pages, query), sourceOwner: { kind: "wiki", id: wiki.id } }])) };
    }
    const source = viewSaveSource(ctx.request);
    await authorize(ctx, wiki, "wiki.view.create", [input.mode === "report" ? "Reports" : "Dashboards"], input);
    const result = await views(wiki.id).create(input);
    await recordViewSaveSource(config, result, source);
    change(wiki.id);
    return jsonResponse(result, 201);
  });
  addRoute(routes, "PUT", "/wikis/:wikiId/ui-views/:viewId", "client", async ctx => {
    if (ctx.request.headers.has("x-legalwork-wiki-agent-token")) throw new ApiError(403, "human_save_required", "Only the user can save a dashboard or report. Return a preview first.");
    const wiki = await selected(ctx, true);
    const parsed = z.object({ baseRevision: z.string().min(1).max(200), input: ViewSaveInputSchema }).strict().safeParse(await readJsonBodyLimited(ctx.request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_view", "Read the view before changing its definition.");
    const repository = views(wiki.id);
    const source = viewSaveSource(ctx.request);
    await authorize(ctx, wiki, "wiki.view.update", [await repository.location(ctx.params.viewId)], parsed.data);
    const result = await repository.update(ctx.params.viewId, parsed.data.input, parsed.data.baseRevision);
    await recordViewSaveSource(config, result, source);
    change(wiki.id);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/wikis/team", "client", async (ctx) => {
    requireClientScope(ctx, "owner");
    if (!options.team) throw sharingUnavailable();
    return jsonResponse(await options.team());
  });
  addRoute(routes, "POST", "/wikis/join", "client", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    if (!options.join) throw sharingUnavailable();
    const parsed = z.object({ wikiId: z.string().uuid(), root: z.string().trim().min(1).max(4096).optional() }).strict().safeParse(await readJsonBodyLimited(ctx.request, 8 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_configuration", "Choose a shared wiki and an optional local folder.");
    const wiki = await options.join(parsed.data);
    options.onWorkspacesChanged?.();
    change(wiki.id);
    return jsonResponse({ wiki: await vault(ctx, await store.snapshot(wiki.id)) }, 201);
  });

  addRoute(routes, "GET", "/wikis", "client", async (ctx) => {
    const items: WikiVault[] = [];
    for (const wiki of await store.list()) if (visible(ctx, wiki)) {
      try { await options.ensureWikiReadable?.(ctx, wiki); } catch { continue; }
      try { items.push(await vault(ctx, await store.snapshot(wiki.id))); }
      catch (error) {
        // A disconnected local folder must not hide the other wikis or prevent reconnecting it.
        const status = options.getSyncStatus ? await options.getSyncStatus(wiki.id) : { state: "error", lastSyncedAt: null, error: error instanceof Error ? error.message : "Wiki folder unavailable.", conflicts: [] };
        items.push({ ...wiki, writable: false, pageCount: 0, totalBytes: 0, syncStatus: { ...status, state: "error", error: error instanceof Error ? error.message : "Wiki folder unavailable." } });
      }
    }
    return jsonResponse({ items });
  });
  addRoute(routes, "POST", "/wikis", "client", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    const parsed = createSchema.safeParse(await readJsonBodyLimited(ctx.request, 16 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_configuration", "Provide a name, optional folder, and wiki sharing settings.");
    if (parsed.data.sharing) {
      if (!options.team || !options.share) throw sharingUnavailable();
      await options.team();
    }
    let wiki = await store.create(parsed.data);
    let sharingError: string | undefined;
    if (parsed.data.sharing && options.share) {
      try { await options.share(wiki.id, parsed.data.sharing); wiki = await store.get(wiki.id); }
      catch (error) {
        // Keep the local ID and pending remote ID so an unknown POST outcome can be retried once.
        wiki = await store.get(wiki.id);
        sharingError = error instanceof Error ? error.message : "The wiki was created locally. Sharing could not be completed.";
      }
    }
    options.onWorkspacesChanged?.();
    change(wiki.id);
    return jsonResponse({ wiki: await vault(ctx, await store.snapshot(wiki.id)), ...(sharingError ? { sharingError } : {}) }, 201);
  });
  const sharingBody = async (ctx: RequestContext) => {
    const parsed = sharingSchema.strict().safeParse(await readJsonBodyLimited(ctx.request, 16 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_sharing", "Choose everyone in the firm or selected members.");
    return parsed.data;
  };
  const sharedResult = async (ctx: RequestContext, wikiId: string) => {
    options.onWorkspacesChanged?.();
    change(wikiId);
    return jsonResponse({ wiki: await vault(ctx, await store.snapshot(wikiId)) });
  };
  addRoute(routes, "POST", "/wikis/:wikiId/share", "client", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await selected(ctx);
    if (!options.share) throw sharingUnavailable();
    await options.share(ctx.params.wikiId, await sharingBody(ctx));
    return sharedResult(ctx, ctx.params.wikiId);
  });
  addRoute(routes, "PATCH", "/wikis/:wikiId/share", "client", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await selected(ctx);
    if (!options.updateSharing) throw sharingUnavailable();
    await options.updateSharing(ctx.params.wikiId, await sharingBody(ctx));
    return sharedResult(ctx, ctx.params.wikiId);
  });
  addRoute(routes, "DELETE", "/wikis/:wikiId/share", "client", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    // An unknown DELETE outcome may already have tombstoned the remote record.
    // The remote DELETE still checks ownership and is safe to retry without a read.
    await store.get(ctx.params.wikiId);
    if (!options.stopSharing) throw sharingUnavailable();
    await options.stopSharing(ctx.params.wikiId);
    return sharedResult(ctx, ctx.params.wikiId);
  });
  addRoute(routes, "GET", "/wikis/:wikiId/graph/revision", "client", async (ctx) => {
    await selected(ctx);
    return jsonResponse(await store.graph(ctx.params.wikiId, undefined, true));
  });
  addRoute(routes, "GET", "/wikis/:wikiId/graph", "client", async (ctx) => {
    await selected(ctx);
    const revision = ctx.url.searchParams.get("revision") ?? undefined;
    if (revision && revision.length > 200) throw new ApiError(400, "invalid_graph_revision", "The graph revision is invalid.");
    return jsonResponse(await store.graph(ctx.params.wikiId, revision));
  });
  addRoute(routes, "GET", "/wikis/:wikiId", "client", async (ctx) => {
    await selected(ctx);
    const snapshot = await store.snapshot(ctx.params.wikiId);
    return jsonResponse({ ...snapshot, wiki: await vault(ctx, snapshot) });
  });
  addRoute(routes, "PATCH", "/wikis/:wikiId", "client", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await selected(ctx);
    const parsed = updateSchema.safeParse(await readJsonBodyLimited(ctx.request, 16 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_configuration", "Check the wiki name and project access settings.");
    if (parsed.data.name) await options.rename?.(ctx.params.wikiId, parsed.data.name);
    const wiki = await store.update(ctx.params.wikiId, parsed.data);
    options.onWorkspacesChanged?.();
    change(wiki.id);
    return jsonResponse({ wiki: await vault(ctx, await store.snapshot(wiki.id)) });
  });
  addRoute(routes, "DELETE", "/wikis/:wikiId", "client", async (ctx) => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    // Removing a local registration remains possible after firm access is revoked.
    await store.get(ctx.params.wikiId);
    await store.forget(ctx.params.wikiId);
    options.onWorkspacesChanged?.();
    change(ctx.params.wikiId);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "GET", "/wikis/:wikiId/page", "client", async (ctx) => {
    await selected(ctx);
    return jsonResponse(await store.read(ctx.params.wikiId, queryPath(ctx)));
  });
  addRoute(routes, "GET", "/wikis/:wikiId/entry", "client", async (ctx) => {
    const wiki = await selected(ctx);
    return jsonResponse(await store.entry(wiki.id, queryPath(ctx)));
  });
  addRoute(routes, "GET", "/wikis/:wikiId/trash", "client", async (ctx) => {
    const wiki = await selected(ctx);
    return jsonResponse({ items: await store.trash(wiki.id) });
  });
  addRoute(routes, "POST", "/wikis/:wikiId/entries", "client", async (ctx) => {
    const wiki = await selected(ctx, true);
    const parsed = entryOperationSchema.safeParse(await readJsonBodyLimited(ctx.request, 16 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_operation", "Choose a file action, safe paths and the current revision.");
    const operation = parsed.data;
    const paths = operation.action === "restore" ? (await store.trash(wiki.id)).filter((item) => item.id === operation.trashId).map((item) => item.path)
      : "destination" in operation ? [operation.path, operation.destination] : [operation.path];
    await authorize(ctx, wiki, `wiki.${operation.action}`, paths);
    await store.changeEntry(wiki.id, operation);
    change(wiki.id);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "PUT", "/wikis/:wikiId/page", "client", async (ctx) => {
    const wiki = await selected(ctx, true);
    const parsed = writeSchema.safeParse(await readJsonBodyLimited(ctx.request, WIKI_MAX_PAGE_BYTES + 128 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_page", "Provide a path, Markdown content and optional base revision.");
    const path = queryPath(ctx, parsed.data.path);
    await authorize(ctx, wiki, "wiki.write", [path], parsed.data);
    const document = await store.write(wiki.id, path, parsed.data.content, parsed.data.baseRevision ?? "");
    change(wiki.id);
    return jsonResponse(document);
  });
  addRoute(routes, "DELETE", "/wikis/:wikiId/page", "client", async (ctx) => {
    const wiki = await selected(ctx, true);
    const parsed = deleteSchema.safeParse(await readJsonBodyLimited(ctx.request, 8 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_page", "Provide the path and the current revision before deleting a file.");
    const path = queryPath(ctx, parsed.data.path);
    await authorize(ctx, wiki, "wiki.delete", [path], parsed.data);
    await store.remove(wiki.id, path, parsed.data.baseRevision);
    change(wiki.id);
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "GET", "/wikis/:wikiId/history/:revisionId", "client", async (ctx) => {
    await selected(ctx);
    return jsonResponse(await store.revision(ctx.params.wikiId, ctx.url.searchParams.get("path") ?? "", ctx.params.revisionId));
  });
  addRoute(routes, "GET", "/wikis/:wikiId/history", "client", async (ctx) => {
    await selected(ctx);
    return jsonResponse({ items: await store.history(ctx.params.wikiId, ctx.url.searchParams.get("path") ?? "") });
  });
  addRoute(routes, "POST", "/wikis/:wikiId/restore", "client", async (ctx) => {
    const wiki = await selected(ctx, true);
    const parsed = restoreSchema.safeParse(await readJsonBodyLimited(ctx.request, 8 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_wiki_revision", "Provide a page path and revision to restore.");
    await authorize(ctx, wiki, "wiki.restore", [parsed.data.path]);
    const document = await store.restore(wiki.id, parsed.data.path, parsed.data.revisionId, parsed.data.baseRevision ?? "");
    change(wiki.id);
    return jsonResponse(document);
  });
  addRoute(routes, "GET", "/wikis/:wikiId/asset", "client", async (ctx) => {
    await selected(ctx);
    const path = queryPath(ctx), bytes = await store.readAsset(ctx.params.wikiId, path);
    return new Response(new Uint8Array(bytes), { headers: {
      "content-type": wikiAssetContentType(path), "content-length": String(bytes.length), "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'", "cache-control": "private, no-store",
      ...(/\.(?:html?|svg)$/i.test(path) ? { "content-disposition": "attachment" } : {}),
    } });
  });
  addRoute(routes, "POST", "/wikis/:wikiId/asset", "client", async (ctx) => {
    const wiki = await selected(ctx, true);
    const parsed = assetSchema.safeParse(await readJsonBodyLimited(ctx.request, Math.ceil(WIKI_MAX_ASSET_BYTES * 4 / 3) + 32 * 1024));
    if (!parsed.success || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed.data.dataBase64)) throw new ApiError(400, "invalid_wiki_asset", "Provide a file path and valid base64 data.");
    await authorize(ctx, wiki, "wiki.attach", [parsed.data.path]);
    let bytes = Buffer.from(parsed.data.dataBase64, "base64");
    if (isViewFile(parsed.data.path) && !parsed.data.baseRevision) {
      try { bytes = Buffer.from(copyViewFile(bytes)); }
      catch (error) { throw new ApiError(400, "invalid_view_import", error instanceof Error ? error.message : "Invalid dashboard file."); }
    }
    const result = await store.writeAsset(wiki.id, parsed.data.path, bytes, parsed.data.baseRevision ?? "");
    change(wiki.id);
    return jsonResponse(result);
  });
  addRoute(routes, "GET", "/wikis/:wikiId/search", "client", async (ctx) => {
    await selected(ctx);
    return jsonResponse({ items: await store.search(ctx.params.wikiId, (ctx.url.searchParams.get("q") ?? "").slice(0, 2000), ctx.url.searchParams.get("type") ?? undefined, ctx.url.searchParams.get("match") === "any" ? "any" : "all") });
  });
  addRoute(routes, "POST", "/wikis/:wikiId/sync", "client", async (ctx) => {
    const wiki = await selected(ctx);
    if (!options.syncWiki) throw new ApiError(503, "wiki_sync_unavailable", "Wiki sync is unavailable on this server.");
    return jsonResponse(await options.syncWiki(wiki.id));
  });
  return store;
}
