import { browserPasswordOrigin, browserPasswords } from "../browser-passwords.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerBrowserPasswordRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
}) {
  const { routes, config, jsonResponse, readJsonBody, ensureWritable } = options;
  const passwords = browserPasswords(config);
  // Management is host-only; metadata responses never contain stored values.
  addRoute(routes, "GET", "/browser-passwords", "host-token", async ctx => {
    const origin = new URL(ctx.request.url).searchParams.get("origin");
    return jsonResponse({ items: await passwords.list(origin === null ? undefined : browserPasswordOrigin(origin)) });
  });
  addRoute(routes, "PUT", "/browser-passwords", "host-token", async ctx => {
    ensureWritable(config);
    return jsonResponse({ item: await passwords.save(await readJsonBody(ctx.request)) });
  });
  addRoute(routes, "POST", "/browser-passwords/:id/websites", "host-token", async ctx => {
    ensureWritable(config);
    return jsonResponse({ item: await passwords.addWebsite(ctx.params.id, await readJsonBody(ctx.request)) });
  });
  addRoute(routes, "DELETE", "/browser-passwords/:id/websites", "host-token", async ctx => {
    ensureWritable(config);
    const query = new URL(ctx.request.url).searchParams;
    return jsonResponse({ item: await passwords.removeWebsite(ctx.params.id, {
      ...(query.has("url") ? { url: query.get("url") } : {}),
      ...(query.has("loginUrl") ? { loginUrl: query.get("loginUrl") } : {}),
    }) });
  });
  addRoute(routes, "DELETE", "/browser-passwords/:id", "host-token", async ctx => {
    ensureWritable(config);
    await passwords.delete(ctx.params.id);
    return jsonResponse({ ok: true });
  });
}

export function registerBrowserConnectionRoutes(options: {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const { routes, config, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspace } = options;
  const passwords = browserPasswords(config);
  const metadata = ({ id, label, origin, additionalOrigins, websites }: Awaited<ReturnType<typeof passwords.addWebsite>>) =>
    ({ id, label, origin, additionalOrigins, websites });
  addRoute(routes, "GET", "/workspace/:id/browser-connections", "client", async ctx => {
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const origin = new URL(ctx.request.url).searchParams.get("origin") ?? undefined;
    return jsonResponse({ items: (await passwords.list(origin)).map(metadata) });
  });
  // A session can add metadata for its owner without gaining general vault management.
  addRoute(routes, "POST", "/workspace/:id/browser-connections/:passwordId/websites", "client", async ctx => {
    requireClientScope(ctx, "owner");
    ensureWritable(config);
    await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ item: metadata(await passwords.addWebsite(ctx.params.passwordId, await readJsonBody(ctx.request))) });
  });
}
