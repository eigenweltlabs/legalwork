import { AssistantSaveReportSchema, StoredViewSchema } from "../views/schema.js";
import { saveAssistantReport } from "../assistant-reports.js";
import { relative, resolve } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { z } from "zod";
import { AssistantReactionEmojiSchema, AssistantShareFileSchema } from "../assistant-schema.js";
import { assistantReactionTarget } from "../assistant-chat.js";
import { isMainAssistant } from "../main-assistant.js";
import { resolveWithinRoot } from "../paths.js";
import { ApiError } from "../errors.js";
import { addRoute } from "./registry.js";
import type { registerMainAssistantRoutes } from "./main-assistant.js";

export function registerAssistantChatRoutes(options: Parameters<typeof registerMainAssistantRoutes>[0]) {
  const { routes, config, jsonResponse } = options;
  const context = z.object({ workspaceId: z.string().min(1), sessionId: z.string().min(1) });
  const source = async (input: z.infer<typeof context>) => {
    const workspace = await options.resolveWorkspace(config, input.workspaceId);
    if (!isMainAssistant(workspace)) throw new ApiError(403, "assistant_only", "Use this tool in the main Assistant chat.");
    const client = options.client(workspace);
    const session = await client.session.get({ sessionID: input.sessionId }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
    if (!session.data || resolve(session.data.directory) !== resolve(workspace.path) || session.data.time.archived)
      throw new ApiError(404, "assistant_session", "This Assistant chat is no longer available.");
    return { workspace, client };
  };
  addRoute(routes, "POST", "/assistant/save-report", "client", async ctx => {
    options.ensureWritable(config);
    options.requireClientScope(ctx, "collaborator");
    const parsed = context.extend({ ...AssistantSaveReportSchema.shape, sourceSessionId: z.string().min(1) })
      .refine(value => value.sourceSessionId === value.sessionId).safeParse(await options.readJsonBodyLimited(ctx.request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, "assistant_report", "Provide a report key, valid view input and the current Assistant chat.");
    const { workspace } = await source(parsed.data);
    await options.requireApproval(ctx, { workspaceId: workspace.id, action: "view.write", summary: "Save an Assistant report", paths: [parsed.data.input.mode === "report" ? "Reports" : "Dashboards"] });
    const result = await saveAssistantReport(workspace, { key: parsed.data.key, input: parsed.data.input, baseRevision: parsed.data.baseRevision });
    options.changed();
    return jsonResponse(result);
  });
  addRoute(routes, "POST", "/assistant/share-file", "client", async ctx => {
    options.requireClientScope(ctx, "collaborator");
    const parsed = context.extend(AssistantShareFileSchema.shape).safeParse(await options.readJsonBodyLimited(ctx.request, 8000));
    if (!parsed.success) throw new ApiError(400, "assistant_file", "Provide a file path, title and the current Assistant chat.");
    const { workspace } = await source(parsed.data);
    const project = parsed.data.projectId ? await options.resolveWorkspace(config, parsed.data.projectId) : workspace;

    const root = await realpath(project.path);
    const path = await resolveWithinRoot(root, parsed.data.path);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new ApiError(404, "assistant_file", "This file does not exist. Save it before sharing it.");
    const view = /\.view\.json$/i.test(path) && info.size <= 2 * 1024 * 1024
      ? StoredViewSchema.safeParse(await readFile(path, "utf8").then(JSON.parse).catch(() => null)) : null;
    return jsonResponse({ ok: true, file: { ...(view?.success ? { documentType: view.data.mode } : {}), path: relative(root, path).split("\\").join("/"), title: parsed.data.title, description: parsed.data.description, size: info.size,
      ...(project.id !== workspace.id ? { source: { workspaceId: project.id, workspaceRoot: root, projectName: project.displayName || project.name } } : {}),
    } });
  });
  addRoute(routes, "POST", "/assistant/react", "client", async ctx => {
    options.requireClientScope(ctx, "collaborator");
    const parsed = context.extend({ assistantMessageId: z.string().min(1), emoji: AssistantReactionEmojiSchema }).safeParse(await options.readJsonBodyLimited(ctx.request, 2000));
    if (!parsed.success) throw new ApiError(400, "assistant_reaction", "Choose an available reaction for the current Assistant turn.");
    const { client } = await source(parsed.data);
    const messages = await client.session.messages({ sessionID: parsed.data.sessionId, limit: 20 }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
    const messageId = assistantReactionTarget(messages.data ?? [], parsed.data.assistantMessageId);
    return jsonResponse({ ok: true, reaction: { messageId, emoji: parsed.data.emoji } });
  });
}
