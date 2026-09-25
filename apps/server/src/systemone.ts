import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import { eigenweltHasPremiumModels } from "./eigenwelt-auth.js";
import { readEigenweltConnection } from "./eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { readCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import { callSystemOne, listSystemOneModels } from "./systemone-client.js";
import {
  SystemOneConfigurationSchema,
  SystemOneProviderInputSchema,
  SystemOneSelectionSchema,
  type SystemOneQuestions,
  type SystemOneResult,
  type SystemOneProvider,
  type SystemOneProviderInput,
  type SystemOneRequest,
  type SystemOneSelection,
  type SystemOneSettings,
} from "./systemone-schema.js";
import type { ServerConfig } from "./types.js";

const CurrentStoredProviderSchema = SystemOneProviderInputSchema.extend({ apiKey: z.string().min(1) });
// Read older one-model connections without changing IDs, keys, or the selected model.
const LegacyStoredProviderSchema = CurrentStoredProviderSchema.omit({ models: true }).extend({
  model: z.string().min(1),
  questionTypes: z.array(z.enum(["noul", "choice", "score"])).min(1),
}).transform(({ model, questionTypes, ...provider }) => ({
  ...provider, models: [{ id: model, name: model, questionTypes }],
}));
const StoredProviderSchema = z.union([CurrentStoredProviderSchema, LegacyStoredProviderSchema]);
const StoreSchema = z.object({
  providers: z.array(StoredProviderSchema),
  selection: SystemOneSelectionSchema,
});
type Store = z.infer<typeof StoreSchema>;
const pathFor = (config: ServerConfig) =>
  join(runtimeStorageDir(config), "systemone.json");
const writes = new Map<string, Promise<void>>();

async function readStore(config: ServerConfig): Promise<Store> {
  try {
    return StoreSchema.parse(
      JSON.parse(await readFile(pathFor(config), "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {
        providers: [],
        selection: { providerId: "eigenwelt", model: "EigenJev" },
      };
    throw new ApiError(
      500,
      "systemone_configuration_invalid",
      "SystemOne settings could not be read. Restore the configuration before making changes.",
    );
  }
}
async function updateStore(
  config: ServerConfig,
  update: (store: Store) => Store,
) {
  const path = pathFor(config);
  const previous = writes.get(path) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const value = update(await readStore(config));
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, path);
    });
  writes.set(path, next);
  try {
    await next;
  } finally {
    if (writes.get(path) === next) writes.delete(path);
  }
}

/** Fetch authoritative enablement before a managed call; outages never become permission. */
async function managedProvider(config: ServerConfig, signal?: AbortSignal) {
  const token = await ensureFreshPlatformToken(config);
  const connection = await readEigenweltConnection(config);
  const manifest = await readCachedEigenweltPaidManifest(config);
  const base: SystemOneProvider = {
    id: "eigenwelt",
    name: "Eigenwelt",
    endpoint: "https://api.eigenweltlabs.com/v1/systemone",
    models: [{ id: "EigenJev", name: "EigenJev Europe", questionTypes: ["noul", "choice", "score"], source: "configured" }],
    enabled: false,
    managed: true,
    region: "EU",
    status: "disconnected",
  };
  if (!token || !manifest || !connection.platformURL)
    return { view: base, target: null };
  if (!eigenweltHasPremiumModels(connection.entitlements))
    return { view: { ...base, status: "disabled" }, target: null };
  let response: Response;
  try {
    response = await fetch(`${connection.platformURL}/api/desktop/systemone`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(10_000),
      ]),
    });
  } catch {
    return { view: { ...base, status: "unavailable" }, target: null };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return {
      view: {
        ...base,
        status:
          response.status === 401
            ? "disconnected"
            : response.status === 403
              ? "disabled"
              : "unavailable",
      },
      target: null,
    };
  }
  const parsed = SystemOneConfigurationSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success)
    return { view: { ...base, status: "unavailable" }, target: null };
  const remote = parsed.data;
  // Re-read after the request: never resurrect credentials if sign-out/account switch won a race.
  const current = await readEigenweltConnection(config);
  const currentManifest = await readCachedEigenweltPaidManifest(config);
  if (
    !current.platformToken ||
    current.account?.orgId !== connection.account?.orgId ||
    !currentManifest ||
    currentManifest.apiKey !== manifest.apiKey
  )
    return { view: base, target: null };
  const endpoint = `${remote.baseURL.replace(/\/+$/, "")}/v1/systemone`;
  const view: SystemOneProvider = {
    ...base,
    endpoint,
    enabled: remote.enabled,
    models: [{ id: remote.model, name: "EigenJev Europe", questionTypes: remote.questionTypes, source: "configured" }],
    status: !remote.enabled
      ? "disabled"
      : remote.available
        ? "ready"
        : "unavailable",
  };
  return {
    view,
    target:
      view.status === "ready"
        ? {
            endpoint,
            apiKey: manifest.apiKey,
            model: remote.model,
            questionTypes: remote.questionTypes,
            deploymentRevision: remote.deploymentRevision,
          }
        : null,
  };
}

async function customProviderView(
  provider: z.infer<typeof CurrentStoredProviderSchema>, signal?: AbortSignal,
): Promise<SystemOneProvider> {
  const { apiKey: _secret, models, ...base } = provider;
  const configured: SystemOneProvider["models"] = models.map((model) => ({ ...model, source: "configured" }));
  if (!provider.enabled) return { ...base, models: configured, managed: false, status: "disabled" };
  try {
    const discovered = await listSystemOneModels(provider, { signal });
    const catalog: SystemOneProvider["models"] = discovered.map((model) => ({ ...model, source: "discovered" }));
    return { ...base, models: [...catalog.filter((model) => !models.some((pin) => pin.id === model.id)), ...configured], managed: false, status: "ready" };
  } catch (error) {
    return { ...base, models: configured, managed: false, status: error instanceof ApiError && (error.status === 401 || error.status === 403) ? "disconnected" : configured.length ? "ready" : "unavailable",
      modelsError: error instanceof ApiError ? error.message : "Could not load the provider's models." };
  }
}

export async function readSystemOneSettings(
  config: ServerConfig,
): Promise<SystemOneSettings> {
  const store = await readStore(config);
  const [managed, providers] = await Promise.all([
    managedProvider(config),
    Promise.all(store.providers.map((provider) => customProviderView(provider))),
  ]);
  // Constrain inferred status strings from unavailable branches to the public enum.
  const status = managed.view.status;
  providers.unshift({
    ...managed.view,
    status:
      status === "ready" || status === "disabled" || status === "disconnected"
        ? status
        : "unavailable",
  });
  return { providers, selection: store.selection };
}

export async function saveSystemOneProvider(
  config: ServerConfig,
  input: SystemOneProviderInput,
) {
  const parsed = SystemOneProviderInputSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      "systemone_invalid_provider",
      "Provide a valid provider name, endpoint and model configuration.",
    );
  await updateStore(config, (store) => {
    const existing = store.providers.find((p) => p.id === parsed.data.id);
    if (
      existing &&
      existing.endpoint !== parsed.data.endpoint &&
      !parsed.data.apiKey
    )
      throw new ApiError(
        400,
        "systemone_credential_required",
        "Enter a new API key when changing the endpoint.",
      );
    const key = parsed.data.apiKey ?? existing?.apiKey;
    if (!key)
      throw new ApiError(
        400,
        "systemone_credential_required",
        "Enter an API key.",
      );
    return {
      ...store,
      providers: [
        ...store.providers.filter((p) => p.id !== parsed.data.id),
        { ...parsed.data, apiKey: key },
      ],
    };
  });
}
export async function deleteSystemOneProvider(
  config: ServerConfig,
  id: string,
) {
  if (id === "eigenwelt")
    throw new ApiError(
      400,
      "systemone_managed_provider",
      "Manage EigenJev through your subscription.",
    );
  // Preserve selection: removing a provider must never route work to another provider.
  await updateStore(config, (store) => ({
    ...store,
    providers: store.providers.filter((p) => p.id !== id),
  }));
}
export async function selectSystemOneProvider(
  config: ServerConfig,
  selection: SystemOneSelection,
) {
  const settings = await readSystemOneSettings(config);
  if (
    !settings.providers.some(
      (p) => p.id === selection.providerId && p.models.some((m) => m.id === selection.model),
    )
  )
    throw new ApiError(
      404,
      "systemone_not_configured",
      "The SystemOne model is not configured.",
    );
  await updateStore(config, (store) => ({ ...store, selection }));
}

export function systemOne<const Q extends SystemOneQuestions>(
  config: ServerConfig,
  input: Omit<SystemOneRequest, "questions"> & { questions: Q },
  options?: { providerId?: string; signal?: AbortSignal; retry?: boolean },
): Promise<SystemOneResult<Q>>;
export async function systemOne(
  config: ServerConfig,
  input: SystemOneRequest,
  options: { providerId?: string; signal?: AbortSignal; retry?: boolean } = {},
) {
  const store = await readStore(config);
  const id = options.providerId ?? store.selection.providerId;
  const provider = store.providers.find((p) => p.id === id);
  const model = input.model ?? (id === store.selection.providerId ? store.selection.model : undefined);
  if (!model)
    throw new ApiError(422, "systemone_model_required", "Specify a model when choosing a different provider.");
  let target;
  if (id === "eigenwelt") {
    const managed = await managedProvider(config, options.signal);
    if (options.signal?.aborted)
      throw new ApiError(
        499,
        "systemone_cancelled",
        "SystemOne request cancelled.",
      );
    if (!managed.target)
      throw new ApiError(
        409,
        `systemone_${managed.view.status}`,
        `EigenJev is ${managed.view.status}. Check your subscription connection and platform settings.`,
      );
    target = managed.target;
  } else {
    if (!provider)
      throw new ApiError(
        409,
        "systemone_not_configured",
        "Select a configured SystemOne provider.",
      );
    if (!provider.enabled)
      throw new ApiError(
        409,
        "systemone_disabled",
        "The selected SystemOne provider is disabled.",
      );
    const view = await customProviderView(provider, options.signal);
    const selected = view.models.find((entry) => entry.id === model);
    if (!selected)
      throw new ApiError(422, "systemone_model_unavailable", view.modelsError ?? "The requested model is not in this provider's catalog or configured model IDs.");
    target = { endpoint: provider.endpoint, apiKey: provider.apiKey, model: selected.id, questionTypes: selected.questionTypes };
  }
  if (model !== target.model)
    throw new ApiError(
      422,
      "systemone_model_unavailable",
      "The requested SystemOne model is not configured for this provider.",
    );
  const result = await callSystemOne(target, input, { signal: options.signal, retry: options.retry });
  return { ...result, providerId: id, requestedModel: target.model };
}

export async function testSystemOneProvider(
  config: ServerConfig,
  selection: SystemOneSelection,
  signal?: AbortSignal,
) {
  const settings = await readSystemOneSettings(config);
  const provider = settings.providers.find(
    (p) => p.id === selection.providerId && p.models.some((m) => m.id === selection.model),
  );
  if (!provider)
    throw new ApiError(
      404,
      "systemone_not_configured",
      "The SystemOne model is not configured.",
    );
  const questions: SystemOneRequest["questions"] = {};
  const selected = provider.models.find((model) => model.id === selection.model)!;
  for (const type of selected.questionTypes) {
    if (type === "noul")
      questions.binary = { type, instructions: "Is the item red?" };
    if (type === "choice")
      questions.color = {
        type,
        instructions: "Which color is the item?",
        criteria: { red: null, blue: null },
      };
    if (type === "score")
      questions.rating = {
        type,
        instructions: "How red is the item?",
        criteria: ["Not red", "Red"],
      };
  }
  await systemOne(
    config,
    { state: "The item is red.", model: selection.model, questions },
    { providerId: selection.providerId, signal },
  );
  return { ok: true };
}
