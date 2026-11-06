import { lineChanges } from "../wiki/line-diff.js";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { WikiSuggestionInputSchema } from "../wiki/suggestion-schema.js";
import type { WikiRegistration } from "@legalwork/types/wiki";
import type { WikiContribution, WikiSuggestion } from "@legalwork/types/wiki-suggestions";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope } from "../types.js";
import { WikiSuggestions } from "../wiki/suggestions.js";
import { WikiStore, wikiPath, wikiAssetContentType } from "../wiki/store.js";
import { wikiAgentCanAccess } from "../wiki/access.js";
import { authenticateWikiAgentRequest } from "../wiki/agent-access.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerWikiSuggestionRoutes(options: {
  routes: Route[]; config: ServerConfig; store: WikiStore;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  ensureWritable: (config: ServerConfig) => void;
  ensureWikiReadable?: (ctx: RequestContext, wiki: WikiRegistration) => Promise<void>;
  ensureWikiWritable?: (ctx: RequestContext, wiki: WikiRegistration) => Promise<void>;
  onChanged?: (id: string) => void;
}) {
  const { config, store, routes, jsonResponse } = options;
  const repository = async (ctx: RequestContext, writing = false) => {
    const project = config.workspaces.find(item => item.id === ctx.params.workspaceId);
    if (!project || (await store.list()).some(wiki => wiki.workspaceId === project.id)) throw new ApiError(404, "project_not_found", "Stage wiki suggestions in a project workspace.");
    if (writing) { options.ensureWritable(config); options.requireClientScope(ctx, "collaborator"); }
    await authenticateWikiAgentRequest(config, ctx.request);
    return new WikiSuggestions(project.directory || project.path, project.id);
  };
  const destination = async (ctx: RequestContext, target: { wikiId: string; path: string; createFolders?: boolean }, writing = false) => {
    wikiPath(target.path);
    if (!/\.md$/i.test(target.path)) throw new ApiError(400, "invalid_wiki_page", "Choose a Markdown page ending in .md.");
    const wiki = await store.get(target.wikiId);
    if (ctx.actor?.type !== "host" && ctx.actor?.scope !== "owner" && !wiki.sync) throw new ApiError(404, "wiki_not_found", "This wiki is not available.");
    if (target.createFolders && wiki.purpose !== "legal-research") throw new ApiError(400, "wiki_folder_proposal_unavailable", "New folders can be proposed only in the legal research wiki.");
    const project = config.workspaces.find(item => item.id === ctx.params.workspaceId);
    if (!project || !await wikiAgentCanAccess(config, await store.list(), wiki, await realpath(project.directory || project.path))) throw new ApiError(403, "wiki_access_denied", "This wiki is not available to this project.");
    await options.ensureWikiReadable?.(ctx, wiki);
    const folder = target.path.includes("/") ? target.path.slice(0, target.path.lastIndexOf("/")) : "";
    if (folder && !target.createFolders && !((await store.snapshot(wiki.id)).folders ?? []).includes(folder)) {
      throw new ApiError(400, "wiki_folder_missing", "This folder is not in the selected wiki. Choose an existing folder.");
    }
    if (writing) await options.ensureWikiWritable?.(ctx, wiki);
    return wiki;
  };
  const body = (ctx: RequestContext) => options.readJsonBodyLimited(ctx.request, 3 * 1024 * 1024);
  const parse = async <T>(ctx: RequestContext, schema: z.ZodType<T>) => {
    const result = schema.safeParse(await body(ctx));
    if (!result.success) throw new ApiError(400, "invalid_wiki_suggestion", "Check the suggestion content and destination.", { issues: result.error.issues });
    return result.data;
  };
  const publish = async (ctx: RequestContext, repo: WikiSuggestions, draft: WikiSuggestion, agentPublication = false) => {
    const wiki = await destination(ctx, draft.destination, true);
    const attachments = [];
    for (let index = 0; index < draft.attachments.length; index++) attachments.push(await repo.attachment(draft, index));
    const saved = await store.writeContribution(wiki.id, draft.destination.path, draft.content, draft.destination.baseRevision ?? "", attachments, agentPublication);
    options.onChanged?.(wiki.id);
    return repo.finish({ ...draft, content: saved.content, attachments: draft.attachments.map((file, index) => ({ ...file, path: saved.attachments[index].path })) }, "saved");
  };
  const publishIfAllowed = async (ctx: RequestContext, repo: WikiSuggestions, draft: WikiSuggestion) => {
    if (!await authenticateWikiAgentRequest(config, ctx.request) || (await store.get(draft.destination.wikiId)).requireAgentApproval !== false) return draft;
    return repo.locked(draft.id, async () => publish(ctx, repo, await repo.current(draft.id, draft.revision), true));
  };
  const base = "/workspace/:workspaceId/wiki-suggestions";
  addRoute(routes, "GET", "/wikis/:wikiId/suggestions", "client", async ctx => {
    // This human inbox must not give a wiki agent access to other projects.
    if (ctx.request.headers.has("x-legalwork-wiki-agent-token")) throw new ApiError(403, "human_review_required", "Only the user can browse project contributions.");
    const wiki = await store.get(ctx.params.wikiId);
    if (ctx.actor?.type !== "host" && ctx.actor?.scope !== "owner" && !wiki.sync) throw new ApiError(404, "wiki_not_found", "This wiki is not available.");
    await options.ensureWikiReadable?.(ctx, wiki);
    const wikis = await store.list();
    const items: WikiContribution[] = [];
    const unavailableProjects: string[] = [];
    for (const project of config.workspaces) {
      if (wikis.some(item => item.workspaceId === project.id)) continue;
      try {
        const root = await realpath(project.directory || project.path);
        if (!await wikiAgentCanAccess(config, wikis, wiki, root)) continue;
        for (const { content, ...item } of await new WikiSuggestions(root, project.id).list()) {
          if (item.status !== "pending" || item.destination.wikiId !== wiki.id) continue;
          let current = "";
          try { current = (await store.read(wiki.id, item.destination.path)).content; }
          catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
          items.push({ ...item, projectName: project.name, changes: lineChanges(current, content) });
        }
      } catch { unavailableProjects.push(project.name); }
    }
    return jsonResponse({ items: items.sort((a, b) => b.createdAt - a.createdAt), unavailableProjects });
  });
  addRoute(routes, "GET", base, "client", async ctx => {
    const repo = await repository(ctx);
    return jsonResponse({ items: (await repo.list()).map(({ content, ...item }) => item) });
  });
  addRoute(routes, "GET", `${base}/:suggestionId`, "client", async ctx => jsonResponse(await (await repository(ctx)).read(ctx.params.suggestionId)));
  addRoute(routes, "GET", `${base}/:suggestionId/attachments/:sha256`, "client", async ctx => {
    const repo = await repository(ctx);
    const draft = await repo.read(ctx.params.suggestionId);
    if (new URL(ctx.request.url).searchParams.get("revision") !== draft.revision) throw new ApiError(409, "suggestion_changed", "This draft changed. Reload it before opening the source file.");
    const index = draft.attachments.findIndex(file => file.sha256 === ctx.params.sha256);
    const file = await repo.attachment(draft, index);
    return new Response(new Uint8Array(file.data), { headers: {
      "content-type": wikiAssetContentType(file.path), "content-length": String(file.data.length),
      "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'", "cache-control": "private, no-store",
    } });
  });
  addRoute(routes, "POST", base, "client", async ctx => {
    const repo = await repository(ctx, true);
    const input = await parse(ctx, WikiSuggestionInputSchema);
    await destination(ctx, input.destination);
    const agent = await authenticateWikiAgentRequest(config, ctx.request);
    return jsonResponse(await publishIfAllowed(ctx, repo, await repo.create(input, agent?.sessionId ?? null)), 201);
  });
  addRoute(routes, "PUT", `${base}/:suggestionId`, "client", async ctx => {
    const repo = await repository(ctx, true);
    const input = await parse(ctx, WikiSuggestionInputSchema.extend({ revision: z.string().min(1) }));
    await destination(ctx, input.destination);
    return jsonResponse(await publishIfAllowed(ctx, repo, await repo.update(ctx.params.suggestionId, input.revision, input)));
  });
  for (const action of ["save", "dismiss"]) addRoute(routes, "POST", `${base}/:suggestionId/${action}`, "client", async ctx => {
    // This endpoint is deliberately absent from the agent credential allowlist.
    if (ctx.request.headers.has("x-legalwork-wiki-agent-token")) throw new ApiError(403, "human_review_required", "Only the user can save or dismiss a wiki suggestion.");
    const repo = await repository(ctx, true);
    const input = await parse(ctx, z.object({ revision: z.string().min(1) }).strict());
    return repo.locked(ctx.params.suggestionId, async () => {
      const draft = await repo.current(ctx.params.suggestionId, input.revision);
      if (action === "dismiss") return jsonResponse(await repo.finish(draft, "dismissed"));
      return jsonResponse(await publish(ctx, repo, draft));
    });
  });
}
