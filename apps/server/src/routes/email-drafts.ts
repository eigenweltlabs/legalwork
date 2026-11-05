import { z } from "zod";
import { EmailDraftInputSchema, EmailDraftAccountSchema, EmailDraftSchema } from "../email-drafts/schema.js";
import { emailDraftTarget } from "../connectors/drafts.js";
import { hasConnectorRuntimeCapability } from "../connectors/capability.js";
import { ApiError } from "../errors.js";
import { draftPaths, readDraft, saveEmailDraft } from "../email-drafts/store.js";
import { recordAudit } from "../audit.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";

export function registerEmailDraftRoutes(options: {
  routes: Route[]; config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
}) {
  const route = (method: string, suffix: string, action: (ctx: RequestContext, workspace: WorkspaceInfo) => Promise<unknown>) => {
    addRoute(options.routes, method, `/workspace/:id/email-drafts${suffix}`, "client", async ctx => {
      options.requireClientScope(ctx, method === "GET" ? "viewer" : "collaborator");
      if (method !== "GET") options.ensureWritable(options.config);
      const workspace = await options.resolveWorkspace(options.config, ctx.params.id);
      try { return options.jsonResponse(await action(ctx, workspace)); }
      catch (error) {
        if (error instanceof z.ZodError) throw new ApiError(400, "email_draft_input", "Check the email fields.", { issues: error.issues });
        throw error;
      }
    });
  };
  route("GET", "/:draft", async (ctx, workspace) => {
    const draft = EmailDraftSchema.parse(await readDraft(workspace.path, ctx.params.draft));
    if (draft.workspaceId !== workspace.id) throw new ApiError(404, "email_draft_missing", "Email draft not found.");
    return { draft };
  });
  for (const method of ["POST", "PUT"]) route(method, method === "POST" ? "" : "/:draft", async (ctx, workspace) => {
    const body = await options.readJsonBodyLimited(ctx.request, 2_100_000);
    const input = EmailDraftInputSchema.parse(body);
    const account = method === "POST" && body.account !== undefined ? EmailDraftAccountSchema.parse(body.account) : "local";
    if (account !== "local" && ctx.actor?.scope !== "owner" && !hasConnectorRuntimeCapability(options.config, ctx.request)) {
      throw new ApiError(403, "forbidden", "Only the LegalWork server owner or their managed agent can use personal account connections.");
    }
    const target = await emailDraftTarget(options.config, account);
    const previous = method === "PUT" ? { id: z.uuid().parse(ctx.params.draft), revision: z.uuid().parse(body.revision) } : undefined;
    const paths = previous ? await draftPaths(workspace.path, previous.id) : null;
    await options.requireApproval(ctx, { workspaceId: workspace.id, action: "workspace.file.write", summary: "Save email draft", paths: paths ? [paths.artifact, paths.metadata] : [workspace.path + "/.legalwork/email-drafts"] });
    const draft = await saveEmailDraft(workspace.path, workspace.id, input, previous, target);
    await recordAudit(workspace.path, { id: draft.revision, workspaceId: workspace.id, actor: ctx.actor ?? { type: "remote" }, action: "workspace.file.write", target: draft.path, summary: "Saved email draft", timestamp: draft.updatedAt });
    return { draft };
  });
}
