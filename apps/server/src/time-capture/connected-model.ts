import { workdayWordingSchema, type CaptureProposal, type WorkdayModel } from "../back-office/timesheet-schema.js";
import { createEngineClient, workspaceEngineLocation } from "../engine-client.js";
import { requireAssistantWorkspaceSubscription } from "../assistant-subscription.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { WORKDAY_INTERNAL_SESSION } from "../native-shared-values.js";
import { previewWorkdayWording, workdayPrompt } from "./local-model.js";

export async function connectedWorkdayWording(config: ServerConfig, workspace: WorkspaceInfo, model: WorkdayModel,
  proposals: CaptureProposal[], verify: () => Promise<void>, signal: AbortSignal) {
  await requireAssistantWorkspaceSubscription(config, workspace.id);
  const client = createEngineClient(config, workspace);
  const location = workspaceEngineLocation(workspace);
  if (!proposals.length) return {};
  const { data: models } = await client.model.list({ location }, { signal });
  if (!models.some(item => item.providerID === model.providerID && item.id === model.modelID && item.enabled !== false))
    throw new ApiError(409, "timesheet_model_unavailable", "Choose a connected chat model for this project.");
  // Session-scoped generation applies the same project and provider policy as chat.
  // generate() returns text directly and does not append a user or assistant message.
  const session = await client.session.create({ location, title: "Time suggestions", metadata: { legalworkInternal: WORKDAY_INTERNAL_SESSION }, model: { providerID: model.providerID, id: model.modelID },
    permissions: [{ action: "*", resource: "*", effect: "deny" }] }, { signal });
  try {
    return await previewWorkdayWording(proposals, verify, signal, async batch => {
      const prompt = await workdayPrompt(batch);
      const result = await client.session.generate({ sessionID: session.id, prompt }, { signal });
      try {
        return workdayWordingSchema.parse(JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")));
      } catch {
        throw new ApiError(502, "timesheet_model_format", "The model returned an unreadable suggestion. Retry or choose another model.");
      }
    });
  } finally {
    await client.session.remove({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) });
  }
}
