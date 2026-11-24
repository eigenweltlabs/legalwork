import type { WorkdayModel } from "@legalwork/types/time-capture";
import { createEngineClient, workspaceEngineLocation } from "../engine-client.js";
import { requireAssistantWorkspaceSubscription } from "../assistant-subscription.js";
import { ApiError, findApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { RETIRED_FREE_PROVIDER_IDS, WORKDAY_INTERNAL_SESSION } from "../native-shared-values.js";

type Choice = Pick<WorkdayModel, "providerID" | "modelID">;
type Catalog = { models: Choice[]; defaultModel?: Choice };
const readiness = new WeakMap<ServerConfig, Map<string, { expires: number; value: Promise<Catalog> }>>();

async function readCatalog(config: ServerConfig, workspace: WorkspaceInfo, signal: AbortSignal): Promise<Catalog> {
  await requireAssistantWorkspaceSubscription(config, workspace.id);
  const client = createEngineClient(config, workspace);
  const location = workspaceEngineLocation(workspace);
  // The native model list activates project plugins before their providers and defaults are read.
  const { data } = await client.model.list({ location }, { signal });
  const [providers, selected] = await Promise.all([
    client.provider.list({ location }, { signal }), client.model.default({ location }, { signal }).catch(() => {
      signal.throwIfAborted();
      return undefined;
    }),
  ]);
  const connected = new Set(providers.data
    .filter(item => item.activation !== "disabled" && !RETIRED_FREE_PROVIDER_IDS.has(item.id.trim().toLowerCase()))
    .map(item => item.id));
  const models = data.filter(item => item.enabled !== false && connected.has(item.providerID)
    && item.capabilities.input.includes("text") && item.capabilities.output.includes("text"))
    .map(item => ({ providerID: item.providerID, modelID: item.id }));
  const defaultModel = models.find(item => item.providerID === selected?.data?.providerID && item.modelID === selected.data.id);
  return { models, defaultModel };
}

function catalogFor(config: ServerConfig, workspace: WorkspaceInfo, signal: AbortSignal, passive: boolean) {
  // Day/week/month reads request the same availability simultaneously. Share only
  // discovery metadata. Generation rechecks and replaces any earlier readiness hint.
  let cache = readiness.get(config);
  if (!cache) { cache = new Map(); readiness.set(config, cache); }
  const key = JSON.stringify([workspace.id, workspace.path, workspace.directory, workspace.baseUrl]);
  const cached = cache.get(key);
  if (passive && cached && cached.expires > Date.now()) return cached.value;
  const requestSignal = passive ? AbortSignal.timeout(3_000) : AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  const value = readCatalog(config, workspace, requestSignal).catch(error => {
    if (cache.get(key)?.value === value) cache.delete(key);
    throw error;
  });
  cache.set(key, { expires: Date.now() + 10_000, value });
  return value;
}

export async function connectedWorkdayModel(config: ServerConfig, workspaces: WorkspaceInfo[], preferences: Choice[],
  signal: AbortSignal, passive: boolean, explicitProvider?: string): Promise<WorkdayModel | undefined> {
  const catalogs: { workspaceId: string; catalog: Catalog }[] = [];
  for (const workspace of workspaces) {
    try {
      const catalog = await catalogFor(config, workspace, signal, passive);
      const selected = preferences[0];
      const exact = selected && catalog.models.find(item => item.providerID === selected.providerID && item.modelID === selected.modelID);
      if (exact) return { workspaceId: workspace.id, ...exact };
      if (catalog.models.length) {
        catalogs.push({ workspaceId: workspace.id, catalog });
        if (!selected) break;
      }
    } catch { signal.throwIfAborted(); }
  }
  // Recover explicit request hints or the last successful model if the saved choice disappeared.
  for (const preference of preferences.slice(1)) {
    for (const { workspaceId, catalog } of catalogs) {
      const match = catalog.models.find(item => item.providerID === preference.providerID && item.modelID === preference.modelID);
      if (match) return { workspaceId, ...match };
    }
  }
  for (const { workspaceId, catalog: { defaultModel, models } } of catalogs) {
    const provider = preferences[0]?.providerID;
    const withinProvider = (defaultModel?.providerID === provider ? defaultModel : undefined)
      ?? models.find(item => item.providerID === provider);
    const automatic = defaultModel ?? models.find(item => item.providerID === "eigenwelt") ?? models[0];
    const model = withinProvider ?? (explicitProvider ? undefined : automatic);
    if (model) return { workspaceId, ...model };
  }
}

export async function generateConnectedTimeText(config: ServerConfig, workspace: WorkspaceInfo, model: WorkdayModel,
  prompt: string, verify: () => Promise<void>, signal: AbortSignal) {
  await requireAssistantWorkspaceSubscription(config, workspace.id);
  if (RETIRED_FREE_PROVIDER_IDS.has(model.providerID.trim().toLowerCase()))
    throw new ApiError(409, "timesheet_model_unavailable", "Choose a connected chat model for this project.");
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
