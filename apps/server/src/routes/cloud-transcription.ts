import { z } from "zod";
import { ApiError } from "../errors.js";
import { addRoute } from "./registry.js";
import type { registerSystemOneRoutes } from "./systemone.js";
import { cloudTranscriptionConnection, cloudTranscriptionStatus } from "../cloud-transcription.js";
import { generateMeetingNotes, MeetingNotesInput } from "../meeting-notes.js";

export function registerCloudTranscriptionRoutes(deps: Parameters<typeof registerSystemOneRoutes>[0]) {
  addRoute(deps.routes, "POST", "/transcription/summary", "client", async ctx => {
    deps.requireClientScope(ctx, "collaborator");
    const input = MeetingNotesInput.safeParse(await deps.readJsonBody(ctx.request));
    if (!input.success) throw new ApiError(400, "invalid_request", "Check the meeting notes settings and transcript length.");
    return deps.jsonResponse(await generateMeetingNotes(deps.config, input.data, ctx.request.signal));
  });
  addRoute(deps.routes, "GET", "/transcription/settings", "client", async ctx => {
    deps.requireClientScope(ctx, "viewer");
    return deps.jsonResponse(await cloudTranscriptionStatus(deps.config));
  });
  addRoute(deps.routes, "POST", "/transcription/connection", "client", async ctx => {
    deps.requireClientScope(ctx, "collaborator");
    const input = z.object({ model: z.string().min(1).max(100) }).safeParse(await deps.readJsonBody(ctx.request));
    if (!input.success) throw new ApiError(400, "invalid_request", "Choose a transcription model.");
    return deps.jsonResponse(await cloudTranscriptionConnection(deps.config, input.data.model));
  });
}
