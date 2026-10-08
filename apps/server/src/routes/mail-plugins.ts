import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { mailActionSchema, mailAccountIdSchema, mailProviderSchema } from "../mail-plugins/schema.js";
import { ApiError } from "../errors.js";
import { workingCopy } from "../file-storage/working-copy.js";
import { MailPlugins } from "../mail-plugins/service.js";
import { requireLocalMailEngine } from "../mail-plugins/access.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type Options = {
  routes: Route[]; config: ServerConfig;
  plugins: MailPlugins;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  ensureWritable: (config: ServerConfig) => void;
};
const attachment = z.object({ filename: z.string().optional(), contentType: z.string().optional(), contentBase64: z.string(), size: z.number() });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, "invalid_mail_arguments", "Check the email connection and operation arguments.");
  return result.data;
}

export function registerMailPluginRoutes(options: Options) {
  const { routes, config, plugins, jsonResponse, readJsonBodyLimited, requireClientScope, resolveWorkspace, ensureWritable } = options;
  const desktop = () => {
    if (!["127.0.0.1", "localhost", "::1"].includes(config.host)) throw new ApiError(403, "mail_desktop_only", "Personal email plugins are available to local desktop tasks.");
  };
  const provider = (ctx: RequestContext) => parse(mailProviderSchema, ctx.params.provider);
  const localWorkspace = async (id: string) => {
    const workspace = await resolveWorkspace(config, id);
    if (workspace.workspaceType === "remote") throw new ApiError(403, "mail_local_project_required", "Personal email plugins are available to local projects.");
    return workspace;
  };
  addRoute(routes, "GET", "/mail-plugins/:provider/status", "host-token", async (ctx) => { desktop(); return jsonResponse(await plugins.oauth.status(provider(ctx), ctx.url.searchParams.get("workspaceId") ?? undefined)); });
  addRoute(routes, "POST", "/mail-plugins/:provider/connect", "host-token", async (ctx) => {
    desktop();
    const { canWrite, workspaceId } = parse(z.object({ canWrite: z.boolean().default(false), workspaceId: z.string().min(1) }).strict(), await readJsonBodyLimited(ctx.request, 1024));
    await localWorkspace(workspaceId);
    return jsonResponse(await plugins.oauth.start(provider(ctx), canWrite, workspaceId), 201);
  });
  addRoute(routes, "GET", "/mail-plugins/:provider/connect/:flowId", "host-token", async (ctx) => { desktop(); return jsonResponse(plugins.oauth.flowStatus(provider(ctx), ctx.params.flowId!)); });
  addRoute(routes, "DELETE", "/mail-plugins/:provider/connect/:flowId", "host-token", async (ctx) => { desktop(); plugins.oauth.cancel(provider(ctx), ctx.params.flowId!); return jsonResponse({ ok: true }); });
  addRoute(routes, "DELETE", "/mail-plugins/:provider/accounts/:accountId", "host-token", async (ctx) => { desktop(); return jsonResponse(await plugins.oauth.disconnect(provider(ctx), parse(mailAccountIdSchema, ctx.params.accountId))); });
  addRoute(routes, "POST", "/mail-plugins/:provider/accounts/:accountId/access", "host-token", async (ctx) => {
    desktop();
    const { workspaceId, enabled } = parse(z.object({ workspaceId: z.string().min(1), enabled: z.boolean() }).strict(), await readJsonBodyLimited(ctx.request, 1024));
    await localWorkspace(workspaceId);
    const account = await plugins.oauth.account(provider(ctx), parse(mailAccountIdSchema, ctx.params.accountId));
    await plugins.vault.update((value) => { const ids = (value.grants[workspaceId] ?? []).filter((id) => id !== account.id); value.grants[workspaceId] = enabled ? [...ids, account.id] : ids; });
    return jsonResponse(await plugins.oauth.status(provider(ctx), workspaceId));
  });
  addRoute(routes, "GET", "/workspace/:id/mail-plugins/accounts", "client", async (ctx) => {
    desktop(); requireClientScope(ctx, "collaborator"); requireLocalMailEngine(config, ctx.request); await localWorkspace(ctx.params.id!);
    const statuses = await Promise.all([plugins.oauth.status("gmail", ctx.params.id!), plugins.oauth.status("outlook", ctx.params.id!)]);
    return jsonResponse({ plugins: statuses.map((status) => ({ ...status, accounts: status.accounts.filter((account) => account.workspaceAccess), connected: status.accounts.some((account) => account.workspaceAccess) })) });
  });
  addRoute(routes, "POST", "/workspace/:id/mail-plugins/:provider/actions", "client", async (ctx) => {
    desktop(); requireClientScope(ctx, "collaborator"); requireLocalMailEngine(config, ctx.request);
    const workspace = await localWorkspace(ctx.params.id!);
    const action = parse(mailActionSchema, await readJsonBodyLimited(ctx.request, 256 * 1024));
    if (!(await plugins.vault.read()).grants[workspace.id]?.includes(action.accountId)) throw new ApiError(403, "mail_project_access_required", "Enable this email account for the current project in Plugins settings.");
    if (["draft", "reply_draft", "send", "attachment"].includes(action.action)) ensureWritable(config);
    const result = await plugins.execute(provider(ctx), action, async (summary) => {
      const approval = await ctx.approvals.requestApproval({ workspaceId: workspace.id, action: "mail.send", summary, paths: [], actor: ctx.actor ?? { type: "remote" } }, ctx.request.signal, { requireExplicit: true });
      if (!approval.allowed) throw new ApiError(403, "mail_send_denied", "The user did not approve this email send.");
    }, ctx.request.signal, workspace.id);
    if (action.action !== "attachment") return jsonResponse({ ok: true, result });
    const file = attachment.parse(result);
    const name = (file.filename || `attachment-${action.attachmentId.slice(0, 16)}`).replace(/[\\/\x00-\x1f]/g, "_").slice(0, 200);
    const local = await workingCopy(workspace.path, name);
    try {
      const bytes = Buffer.from(file.contentBase64, "base64");
      await writeFile(local.path, bytes, { flag: "wx", mode: 0o600 });
      return jsonResponse({ ok: true, result: { path: local.path, relativePath: local.relativePath, filename: name, contentType: file.contentType ?? "application/octet-stream", bytes: bytes.length, untrustedContent: true } });
    } catch (error) { await local.remove(); throw error; }
  });
  return plugins;
}
