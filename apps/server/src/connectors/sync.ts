import { z } from "zod";
import { connectorDefinitions, connectorCloudAccessSchema } from "./schema.js";
import { connectorDefinition, connectionProvider } from "./definition.js";
import { brokerIdentity, brokerRequest, ownerKey } from "./transport.js";
import { readConnectorState, writeConnectorConnections, type StoredConnectorConnection } from "./store.js";
import { connectorIsActivated, recordConnectorActivation } from "./settings.js";
import { localOAuthConnections } from "./local-oauth.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { announceSyncChange } from "../app-sync-events.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";

const Policy = z.object({ active: z.boolean(), cloudEnabled: z.boolean(), writeAccess: z.boolean() });
const Binding = z.object({ id: z.uuid(), provider: z.string(), revision: z.number().int().positive(),
  deleted: z.boolean(), cleanupPending: z.boolean().default(false), createdAt: z.string(), policies: z.record(z.string(), Policy) });
type Binding = z.infer<typeof Binding>;
type State = { owner: string; bindings: Binding[]; until: number; pending?: Promise<Binding[]>; again?: boolean; error?: string;
  retry?: ReturnType<typeof setTimeout>; retryCount?: number; retryNeeded?: boolean };
const states = new WeakMap<ServerConfig, State>();
const stopped = new WeakSet<ServerConfig>();
const worker = (config: ServerConfig) => config.cloudSync?.role === "executor";
const sharing = (config: ServerConfig) => config.cloudSync?.role === "companion";
const providers = [...new Set(connectorDefinitions.map(({ id }) => connectionProvider(id)))];

async function current(config: ServerConfig, owner: string) {
  if (stopped.has(config)) throw new ApiError(409, "connector_sync_stopped", "Connector sync has stopped.");
  const account = (await readEigenweltConnection(config)).account;
  if (!account || ownerKey(account) !== owner) throw new ApiError(409, "connector_account_changed", "Your Eigenwelt account changed. Start again.");
}
async function saveBinding(config: ServerConfig, owner: string, provider: string, saved: Awaited<ReturnType<typeof readConnectorState>>, connection: StoredConnectorConnection, binding: Binding) {
  await current(config, owner);
  if (!await writeConnectorConnections(config, owner, provider, saved.connections.map(item => item.id === connection.id ? { ...item, bindingId: binding.id } : item), saved.snapshot))
    throw new ApiError(409, "connector_state_changed", "Connected accounts changed. Refresh and try again.");
}

/** Adopt an exact local reference, never enumerate accounts at Nango. */
export async function registerConnectorBinding(config: ServerConfig, id: string, connectionId: string, explicit = false) {
  if (worker(config)) throw new ApiError(403, "connector_desktop_required", "Manage connections from your desktop.");
  const { owner } = await brokerIdentity(config);
  const provider = connectionProvider(id);
  const saved = await readConnectorState(config, owner, provider);
  const connection = saved.connections.find(item => item.id === connectionId);
  if (!connection?.nangoConnectionId) return null;
  const registry = z.object({ bindings: z.array(Binding) }).parse(await brokerRequest(config, "GET", "/bindings", undefined, owner));
  const previous = registry.bindings.find(item => item.provider === provider);
  const active = await connectorIsActivated(config, id, connectionId);
  const activeConnectorIds: string[] = [];
  for (const definition of connectorDefinitions.filter(item => connectionProvider(item.id) === provider)) {
    if (await connectorIsActivated(config, definition.id, connectionId)) activeConnectorIds.push(definition.id);
  }
  const result = z.object({ binding: Binding }).parse(await brokerRequest(config, "POST", "/bindings/adopt", {
    connectorId: id, connectionId: connection.nangoConnectionId, expectedRevision: explicit ? previous?.revision ?? null : null,
    active, activeConnectorIds, cloudEnabled: sharing(config) && activeConnectorIds.length > 0,
  }, owner));
  await saveBinding(config, owner, provider, saved, connection, result.binding);
  const cached = states.get(config); if (cached) cached.until = 0;
  return result.binding;
}

async function apply(config: ServerConfig, state: State) {
  let changed = false;
  for (const provider of providers) {
    const saved = await readConnectorState(config, state.owner, provider);
    const binding = state.bindings.find(item => item.provider === provider);
    const connections = saved.connections.filter(item => !item.bindingId || (binding?.id === item.bindingId && !binding.deleted));
    const usable = binding && !binding.deleted && (!worker(config) || Object.values(binding.policies).some(policy => policy.active && policy.cloudEnabled));
    const local = connections.find(item => item.bindingId === binding?.id);
    // A different device-local account is never silently replaced.
    const ownApp = worker(config) ? [] : await localOAuthConnections(config, provider);
    const imported = usable && !local && connections.length === 0 && ownApp.length === 0;
    if (imported) connections.push({ id: binding.id, bindingId: binding.id,
      createdAt: binding.createdAt, needsReconnect: false, source: "nango" });
    if (worker(config) && !usable) connections.splice(0, connections.length);
    await current(config, state.owner);
    if (JSON.stringify(connections) !== JSON.stringify(saved.connections)) {
      if (!await writeConnectorConnections(config, state.owner, provider, connections, saved.snapshot)) {
        state.until = 0; continue;
      }
      if (imported && !worker(config)) for (const [id, policy] of Object.entries(binding.policies)) {
        await recordConnectorActivation(config, id, binding.id, policy.active);
      }
      changed = true;
    }
  }
  if (changed) announceSyncChange(config, "connectors");
}

/** One small registry read, coalesced across tools/settings and refreshed by existing SSE. */
export async function synchronizeConnectorBindings(config: ServerConfig, options: { force?: boolean; publish?: boolean } = {}) {
  const account = (await readEigenweltConnection(config)).account;
  if (!account) { const state = states.get(config); if (state?.retry) clearTimeout(state.retry); states.delete(config); return []; }
  const owner = ownerKey(account);
  let state = states.get(config);
  if (state?.owner !== owner) { if (state?.retry) clearTimeout(state.retry); state = { owner, bindings: [], until: 0 }; states.set(config, state); }
  if (state.pending) { if (options.force || options.publish) state.again = true; return state.pending; }
  if (!options.force && !options.publish && state.until > Date.now()) {
    if (worker(config) && state.error) throw new ApiError(502, "connector_sync_unavailable", "Cloud connector access could not be checked. Try again.");
    return state.bindings;
  }
  const own = state;
  const run = async () => {
    let adoptionFailed = false;
    own.retryNeeded = false;
    if ((options.publish || sharing(config)) && !worker(config)) {
      for (const provider of providers) {
        const saved = await readConnectorState(config, owner, provider);
        const connection = saved.connections.find(item => !item.bindingId && item.nangoConnectionId && !item.needsReconnect);
        if (connection) {
          try { await registerConnectorBinding(config, provider, connection.id); }
          catch (error) {
            adoptionFailed = true;
            if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) own.retryNeeded = true;
          }
        }
      }
    }
    const result = z.object({ bindings: z.array(Binding) }).parse(await brokerRequest(config, "GET", "/bindings", undefined, owner));
    if (!worker(config)) for (const binding of result.bindings.filter(item => item.deleted && item.cleanupPending)) {
      try {
        await brokerRequest(config, "POST", "/bindings/disconnect", { bindingId: binding.id, connectorId: binding.provider }, owner);
        binding.cleanupPending = false;
      } catch { own.retryNeeded = true; }
    }
    await current(config, owner);
    const changed = JSON.stringify(own.bindings) !== JSON.stringify(result.bindings);
    own.bindings = result.bindings; own.until = Date.now() + 30_000;
    own.error = adoptionFailed ? "An account could not be shared. Reconnect it from Integrations and try again." : undefined;
    states.set(config, own);
    await apply(config, own);
    if (changed) announceSyncChange(config, "connectors");
    return own.bindings;
  };
  const pending = run().catch(error => { own.until = Date.now() + 5000; own.retryNeeded = true; own.error = "Cloud connector sync could not finish. Try again."; throw error; });
  own.pending = pending;
  try { return await pending; } finally {
    if (own.pending === pending) own.pending = undefined;
    if (own.again) { own.again = false; own.until = 0; scheduleConnectorSync(config); }
    else if (own.retryNeeded && config.cloudSync && !stopped.has(config) && states.get(config) === own) {
      if (own.retry) clearTimeout(own.retry);
      own.retryCount = (own.retryCount ?? 0) + 1;
      own.retry = setTimeout(() => { own.retry = undefined; scheduleConnectorSync(config); }, Math.min(60_000, 1000 * 2 ** Math.min(own.retryCount, 6)));
      own.retry.unref();
    } else if (!own.retryNeeded) { own.retryCount = 0; if (own.retry) clearTimeout(own.retry); own.retry = undefined; }
  }
}

export function scheduleConnectorSync(config: ServerConfig) {
  if (!config.cloudSync || stopped.has(config)) return;
  const state = states.get(config); if (state) state.until = 0;
  void synchronizeConnectorBindings(config, { force: true }).catch(() => {});
}
export function startConnectorSync(config: ServerConfig) {
  stopped.delete(config);
  return () => {
    stopped.add(config); const state = states.get(config); if (state?.retry) clearTimeout(state.retry); states.delete(config);
  };
}
export async function cloudConnectorPolicy(config: ServerConfig, id: string, force = false) {
  const bindings = await synchronizeConnectorBindings(config, { force });
  const binding = bindings.find(item => item.provider === connectionProvider(id) && !item.deleted);
  return binding ? { binding, policy: binding.policies[id] } : null;
}
export async function connectorCloudAccess(config: ServerConfig, id: string) {
  connectorDefinition(id);
  const value = await cloudConnectorPolicy(config, id, true);
  const account = (await readEigenweltConnection(config)).account;
  const saved = account ? await readConnectorState(config, ownerKey(account), connectionProvider(id)) : null;
  const available = Boolean(value && saved?.connections.some(item => item.bindingId === value.binding.id));
  return connectorCloudAccessSchema.parse({ available, enabled: available && value?.policy?.cloudEnabled === true,
    writeAccess: value?.policy?.writeAccess === true, readOnly: worker(config) || config.readOnly, syncError: Boolean(states.get(config)?.error) });
}
export async function saveConnectorCloudAccess(config: ServerConfig, id: string, input: unknown) {
  if (config.readOnly || worker(config)) throw new ApiError(403, "connector_desktop_required", "Manage cloud connector access from your desktop.");
  const parsed = z.strictObject({ enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_payload", "Choose whether cloud access should be enabled.");
  await synchronizeConnectorBindings(config, { publish: true });
  const value = await cloudConnectorPolicy(config, id, true);
  if (!value?.policy) throw new ApiError(409, "connector_not_connected", "Connect this account first.");
  const { owner } = await brokerIdentity(config);
  await brokerRequest(config, "POST", "/bindings/policy", { bindingId: value.binding.id, connectorId: id,
    expectedRevision: value.binding.revision, policy: { ...value.policy, cloudEnabled: parsed.data.enabled } }, owner);
  await synchronizeConnectorBindings(config, { force: true });
  announceSyncChange(config, "connectors");
  return connectorCloudAccess(config, id);
}
export async function syncConnectorActivation(config: ServerConfig, id: string, connectionId: string, active: boolean) {
  const account = (await readEigenweltConnection(config)).account;
  if (!account) return;
  const owner = ownerKey(account);
  const saved = await readConnectorState(config, owner, connectionProvider(id));
  const connection = saved.connections.find(item => item.id === connectionId);
  if (!connection?.bindingId) return;
  const value = await cloudConnectorPolicy(config, id, true);
  if (!value?.policy || value.binding.id !== connection.bindingId) return;
  await brokerRequest(config, "POST", "/bindings/policy", { bindingId: value.binding.id, connectorId: id,
    expectedRevision: value.binding.revision, policy: { ...value.policy, active } }, owner);
  const cached = states.get(config); if (cached) cached.until = 0;
}
export async function revokeConnectorBinding(config: ServerConfig, id: string, connection: StoredConnectorConnection, owner: string) {
  if (!connection.bindingId) return false;
  await brokerRequest(config, "POST", "/bindings/disconnect", { bindingId: connection.bindingId, connectorId: id }, owner);
  const cached = states.get(config); if (cached) cached.until = 0;
  return true;
}
