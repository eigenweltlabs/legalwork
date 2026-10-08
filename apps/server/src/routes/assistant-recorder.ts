import { z } from "zod";
import type { AudioRecordingMeta } from "@legalwork/types/audio";
import { ApiError } from "../errors.js";
import { isMainAssistant } from "../main-assistant.js";
import { matchesSearch, searchExcerpt } from "../search-schema.js";
import { searchFingerprint } from "../assistant-session-search.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

const recordingId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const summary = ({ id, title, createdAt, durationMs, status, segmentCount, projectIds, error }: AudioRecordingMeta) =>
  ({ id, title, createdAt, durationMs, status, segmentCount, projectIds: projectIds ?? [], error });

export function registerAssistantRecorderRoutes(options: {
  routes: Route[]; config: ServerConfig;
  jsonResponse: (value: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
}) {
  const { config, routes, jsonResponse } = options;
  const library = () => {
    if (!config.recorder?.library) throw new ApiError(503, "recorder_unavailable", "The global recorder is available in the desktop app.");
    return config.recorder.library;
  };
  const route = (method: string, path: string, action: (ctx: RequestContext) => Promise<unknown>) => addRoute(routes, method, `/assistant/${path}`, "client", async ctx => {
    options.requireClientScope(ctx, method === "GET" ? "viewer" : "collaborator");
    if (method !== "GET") options.ensureWritable(config);
    try { return jsonResponse(await action(ctx)); }
    catch (error) { if (error instanceof z.ZodError) throw new ApiError(400, "recorder_input", "Check the recording ID, filters and input."); throw error; }
  });
  const read = async (raw: string) => {
    const id = recordingId.parse(raw);
    const detail = await library().read(id);
    if (!detail || detail.meta.ephemeral) throw new ApiError(404, "recording_missing", "Recording not found.");
    return detail;
  };
  const approve = async (ctx: RequestContext, action: string, summary: string) => {
    const assistant = config.workspaces.find(isMainAssistant);
    if (!assistant) throw new ApiError(409, "assistant_required", "Open the main Assistant before managing recordings.");
    await options.resolveWorkspace(config, assistant.id);
    await options.requireApproval(ctx, { workspaceId: assistant.id, action, summary, paths: [] });
  };
  route("GET", "recordings", async ctx => {
    const input = z.object({ query: z.string().trim().max(300).default(""), projectId: z.string().optional(), searchTranscripts: z.enum(["true", "false"]).default("false"), limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.string().max(2000).optional() }).parse(Object.fromEntries(ctx.url.searchParams));
    if (input.projectId) await options.resolveWorkspace(config, input.projectId);
    const fingerprint = searchFingerprint([input.query, input.projectId, input.searchTranscripts]);
    let after: { createdAt: number; id: string } | undefined;
    if (input.cursor) {
      try {
        const cursor = z.object({ fingerprint: z.string(), createdAt: z.number(), id: z.string() }).parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
        if (cursor.fingerprint !== fingerprint) throw new Error("filters changed");
        after = cursor;
      } catch { throw new ApiError(400, "recording_cursor", "Keep the same filters with a valid cursor."); }
    }
    const candidates = (await library().list()).filter(item => !item.ephemeral && (!input.projectId || item.projectIds?.includes(input.projectId)) && (!after || item.createdAt < after.createdAt || (item.createdAt === after.createdAt && item.id.localeCompare(after.id) < 0)))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const items = []; let scanned = 0;
    for (const item of candidates.slice(0, 100)) {
      ctx.request.signal.throwIfAborted(); scanned++;
      let excerpt: string | undefined;
      if (!matchesSearch(item.title, input.query)) {
        if (input.searchTranscripts !== "true") continue;
        const detail = await read(item.id);
        const transcript = detail.segments.map(segment => segment.text).join("\n");
        if (!matchesSearch(transcript, input.query)) continue;
        excerpt = searchExcerpt(transcript, input.query);
      }
      items.push({ ...summary(item), ...(excerpt ? { excerpt } : {}) });
      if (items.length === input.limit) break;
    }
    const last = candidates[scanned - 1];
    return { items, scanned, nextCursor: scanned < candidates.length && last ? Buffer.from(JSON.stringify({ fingerprint, createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
  });
  route("GET", "recordings/:recording", async ctx => {
    const { offset, limit } = z.object({ offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(12000).default(8000) }).parse(Object.fromEntries(ctx.url.searchParams));
    const detail = await read(ctx.params.recording);
    const transcript = detail.segments.map(segment => `[${segment.startMs / 1000}s] ${segment.text}`).join("\n");
    return { recording: summary(detail.meta), transcript: transcript.slice(offset, offset + limit), nextOffset: offset + limit < transcript.length ? offset + limit : null };
  });
  route("PATCH", "recordings/:recording", async ctx => {
    const detail = await read(ctx.params.recording);
    const { title } = z.object({ title: z.string().trim().min(1).max(120) }).parse(await options.readJsonBodyLimited(ctx.request, 2000));
    await approve(ctx, "recorder.rename", `Rename recording ${detail.meta.id} to ${title}`);
    await library().rename(detail.meta.id, title);
    return { recording: summary((await read(detail.meta.id)).meta) };
  });
  route("POST", "recordings/:recording/project", async ctx => {
    const detail = await read(ctx.params.recording);
    const { projectId, linked } = z.object({ projectId: z.string().min(1), linked: z.boolean() }).parse(await options.readJsonBodyLimited(ctx.request, 2000));
    await options.resolveWorkspace(config, projectId);
    await approve(ctx, "recorder.project", `${linked ? "Link" : "Unlink"} recording ${detail.meta.id} ${linked ? "to" : "from"} project ${projectId}`);
    await library().link(detail.meta.id, projectId, linked);
    return { recording: summary((await read(detail.meta.id)).meta) };
  });
  route("DELETE", "recordings/:recording", async ctx => {
    const detail = await read(ctx.params.recording);
    if (detail.meta.status === "recording") throw new ApiError(409, "recording_active", "Stop the recording before moving it to Trash.");
    await approve(ctx, "recorder.trash", `Move recording ${detail.meta.id} to the system Trash`);
    await library().trash(detail.meta.id);
    return { ok: true, id: detail.meta.id, trashed: true };
  });
  route("GET", "recorder", () => library().control({ action: "status" }));
  route("POST", "recorder", async ctx => {
    const input = z.object({ action: z.enum(["start", "stop"]), title: z.string().trim().min(1).max(120).optional(), projectId: z.string().optional(), recordingId: recordingId.optional(), sources: z.array(z.enum(["microphone", "system"])).min(1).max(2).optional() }).parse(await options.readJsonBodyLimited(ctx.request, 2000));
    if (input.projectId) await options.resolveWorkspace(config, input.projectId);
    if (input.action === "stop" && !input.recordingId) throw new ApiError(400, "recording_required", "Use the active recording ID from recorder status.");
    await approve(ctx, `recorder.${input.action}`, `${input.action === "start" ? "Start audio capture" : "Stop recording " + input.recordingId}`);
    return library().control(input);
  });
}
