import type { WorkdayModel } from "@legalwork/types/time-capture";
import { createEngineClient, workspaceEngineLocation } from "../engine-client.js";
import { requireAssistantWorkspaceSubscription } from "../assistant-subscription.js";
import { ApiError, findApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { WORKDAY_INTERNAL_SESSION } from "../native-shared-values.js";

export async function generateConnectedTimeText(config: ServerConfig, workspace: WorkspaceInfo, model: WorkdayModel,
  prompt: string, verify: () => Promise<void>, signal: AbortSignal) {
  await requireAssistantWorkspaceSubscription(config, workspace.id);
  const client = createEngineClient(config, workspace);
  const location = workspaceEngineLocation(workspace);
  try {
    const { data: models } = await client.model.list({ location }, { signal });
    if (!models.some(item => item.providerID === model.providerID && item.id === model.modelID && item.enabled !== false))
      throw new ApiError(409, "timesheet_model_unavailable", "Choose a connected chat model for this project.");
    // The generation request returns text directly without appending to the session transcript.
    const session = await client.session.create({
      location, title: "Timesheet model request", metadata: { legalworkInternal: WORKDAY_INTERNAL_SESSION },
      model: { providerID: model.providerID, id: model.modelID },
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    }, { signal });
    try {
      await verify();
      const result = await client.session.generate({ sessionID: session.id, prompt }, { signal });
      return result.text;
    } finally {
      await client.session.remove({ sessionID: session.id }, { signal: AbortSignal.timeout(10_000) });
    }
  } catch (error) {
    if (signal.aborted || findApiError(error)) throw error;
    throw new ApiError(502, "timesheet_model_request", "The model could not complete the request. Retry or choose another model.");
  }
}
