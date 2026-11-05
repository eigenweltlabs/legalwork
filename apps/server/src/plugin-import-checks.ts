import { createHash, randomUUID } from "node:crypto";
import type { ConnectorImportCheck, PluginImportScope } from "@legalwork/types/plugin-import";
import { ApiError } from "./errors.js";
import { connectorConfigVariables, isCredentialHeader } from "./connector-config.js";
import { importRecord } from "./connector-import-compatibility.js";
import { mergeConnectorSetup, normalizePluginMcpConfig, resolveWorkspaceInstallPath, readInstalledCloudPlugins, type CloudImportedPlugin } from "./cloud-plugins.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { probeMcpServer, registerMcpClient, legalworkMcpClientIdentity, type McpProbeOptions } from "./mcp-probe.js";
import type { PluginImportPlan } from "./plugin-imports.js";
import { evaluateImportRequirements } from "./plugin-import-requirements.js";
import { connectorProgramAvailable } from "./connector-program.js";

type ImportTarget = { workspace: string; scope: PluginImportScope; current: Record<string, unknown>; installed?: CloudImportedPlugin; available?: CloudImportedPlugin[] };
export async function currentPluginImportTarget(config: ServerConfig, workspaceId: string, workspace: string, scope: PluginImportScope, pluginId: string): Promise<ImportTarget> {
  const global = await readInstalledCloudPlugins(config, GLOBAL_MCP_ID);
  const local = scope === "project" ? await readInstalledCloudPlugins(config, workspaceId) : global;
  const registry = scope === "global" ? GLOBAL_MCP_ID : workspaceId;
  return { workspace, scope, current: (await readRuntimeOpencodeConfig(config, registry)).mcp || {}, installed: local.plugins[pluginId], available: Object.values({ ...global.plugins, ...local.plugins }) };
}
type Prepared = { key: string; expires: number; plan: PluginImportPlan; bytes: number };
const preparations = new Map<string, Prepared>();
const pendingPreparations = new Map<string, Promise<PluginImportPlan>>();
const TTL = 15 * 60_000;
const MAX_PREPARATIONS = 20;
const MAX_PREPARED_BYTES = 256 * 1024 * 1024;

function keyFor(plan: PluginImportPlan, target: ImportTarget): string {
  // Re-review if an owned connector's setup changes, including an endpoint change.
  const owned = new Set(target.installed?.files.filter(file => file.objectType === "mcp").map(file => file.path.replace(/^opencode\.jsonc#mcp\./, "")));
  const setup = Object.fromEntries(Object.keys(plan.connectorConfigs ?? {}).filter(name => owned.has(name)).map(name => [name, target.current[name]]));
  return createHash("sha256").update(JSON.stringify([plan.preview.id, plan.preview.digest, target.workspace, target.scope, plan.preview.provenance?.convertPluginSkills, plan.preview.provenance?.workflowSkillPaths, setup, target.installed?.connectorDefaults, process.env.LEGALWORK_MCP_CLIENT_METADATA_URL, target.available?.map(item => [item.pluginId, item.provenance?.digest, item.importState?.readiness])])).digest("hex");
}

/** Check from the actual LegalWork server; never execute imported programs or read another app's credentials. */
async function checkRemote(check: ConnectorImportCheck, config: Record<string, unknown>, options: McpProbeOptions): Promise<ConnectorImportCheck> {
  const blocked = (code: string, message: string, retryable = false): ConnectorImportCheck => ({ ...check, status: "blocked", code, message, retryable, inputs: undefined });
  const url = typeof config.url === "string" ? config.url : "";
  const inputs = connectorConfigVariables(config);
  if (!url || connectorConfigVariables(url).length) return { ...check, status: "setup", code: inputs.length ? "inputs" : "local_program", inputs: inputs.length ? inputs : undefined };
  const oauth = importRecord(config.oauth) ? config.oauth : {};
  const hasCredentials = check.code === "api_key" || importRecord(config.headers) && Object.keys(config.headers).some(isCredentialHeader);
  if ([...new URL(url).searchParams.keys()].some(name => /token|api.?key|secret|password|authorization/i.test(name))) return { ...check, status: "setup", code: "address_credentials", inputs, message: "This address contains a credential. Configure and check it after importing. Import checks do not send credentials from the source address to the provider." };
  const credentialSetup: ConnectorImportCheck = { ...check, status: "setup", code: "credentials", inputs, message: new URL(url).hostname === "api.githubcopilot.com" ? "Enter a GitHub personal access token after importing. The original app's GitHub login cannot be reused. Your firm may also require token approval and allowlisting the LegalWork server's IP address." : "Finish credential setup after importing. Credentials saved in the original app are not transferred; your account's access is checked when you connect." };
  // Anonymous access cannot test account permissions or static credential validity.
  // Never send source secrets to redirects, discovery or registration endpoints.
  const probe = await probeMcpServer(url, { ...options, headers: undefined, exactUrl: true });
  if (check.declaredTransport && probe.transport && check.declaredTransport !== probe.transport) return blocked("transport_mismatch", "This endpoint does not accept the portable connector’s declared Streamable HTTP transport. Obtain the correct endpoint before importing.");
  if (!probe.reachable) return blocked("unreachable", "This connector could not be reached from the LegalWork server. Check the address, network access and any provider IP allowlist, then check again.", true);
  if (!probe.steps.find(step => step.id === "connect")?.ok) {
    if (hasCredentials && probe.steps[0]?.status === 403) return credentialSetup;
    return blocked("access_refused", "The provider did not accept a connection from the LegalWork server. Check provider access, the address and any IP allowlist, then check again. Sign-in alone may not resolve this.", true);
  }
  if (hasCredentials || inputs.length) return credentialSetup;
  if (probe.auth === "none") {
    return { ...check, status: "compatible", code: "public", message: "The provider accepts connections without sign-in. Enable the connector after importing." };
  }
  if (config.oauth === false) return blocked("missing_authentication", "This provider requires authentication, but this export has no usable sign-in or credential configuration. Obtain a complete configuration from the provider.");
  if (probe.auth !== "oauth") return blocked("unknown_authentication", "The provider requires credentials but does not describe a supported sign-in method. Obtain an API key or registered OAuth configuration from the provider before importing.");
  if (probe.transport === "sse") return blocked("legacy_sse_oauth", "This connector requires OAuth on a legacy SSE-only endpoint. LegalWork's sign-in flow requires a Streamable HTTP endpoint. Ask the provider for its current HTTP configuration.");
  // Native v2 sends an explicit configured scope unchanged. Advertising broader
  // permissions does not justify replacing or rejecting the source restriction.
  if (typeof oauth.clientId === "string" && oauth.clientId) {
    if (oauth.clientId === (options.clientMetadataUrl || process.env.LEGALWORK_MCP_CLIENT_METADATA_URL)) {
      try { await legalworkMcpClientIdentity(probe, typeof oauth.redirectUri === "string" ? oauth.redirectUri : "http://127.0.0.1:19876/mcp/oauth/callback", options); }
      catch (error) { return blocked("client_metadata", error instanceof Error ? error.message : "LegalWork's client metadata is unavailable.", true); }
    }
    const methods = probe.oauth?.tokenEndpointAuthMethods;
    if (methods?.length && !methods.includes("none") && !methods.includes("client_secret_post")) return blocked("client_authentication", "This provider requires a client authentication method LegalWork cannot use.");
    if (methods?.length && !methods.includes("none") && methods.includes("client_secret_post") && !oauth.clientSecret) {
      config.oauth = { ...oauth, clientSecret: "${OAUTH_CLIENT_SECRET}" };
      return { ...check, status: "setup", code: "inputs", inputs: ["OAUTH_CLIENT_SECRET"], message: "This provider requires the registered application's client secret. Enter it in connector setup after importing; secrets saved in the original app are not transferred." };
    }
    return { ...check, status: "setup", code: "sign_in", message: "Sign in after importing. The provider must allow this registered application's callback, your account and connections from the LegalWork server." };
  }
  const redirectUri = typeof oauth.redirectUri === "string" ? oauth.redirectUri : `http://127.0.0.1:${typeof oauth.callbackPort === "number" ? oauth.callbackPort : 19876}/mcp/oauth/callback`;
  try {
    const identity = await legalworkMcpClientIdentity(probe, redirectUri, options);
    if (identity) {
      config.oauth = { ...oauth, clientId: identity, redirectUri };
      return { ...check, status: "setup", code: "sign_in", message: "LegalWork's own OAuth client identity is configured. Sign in after importing; the provider will check approval and account access." };
    }
  } catch (error) { return blocked("client_metadata", error instanceof Error ? error.message : "LegalWork's OAuth client metadata is unavailable.", true); }
  if (!probe.oauth?.dynamicRegistration) return blocked("registration_required", probe.oauth?.clientIdMetadataDocuments ? "This provider requires an OAuth client metadata identity. Configure LegalWork's own public client metadata or a registered OAuth application; the original app's identity cannot be transferred." : "This provider does not allow automatic OAuth registration. Ask your administrator or the provider for an OAuth application registered for LegalWork.");
  const registration = await registerMcpClient(url, { ...options, headers: undefined, probe, redirectUri, ...(typeof oauth.scope === "string" ? { scope: oauth.scope } : {}) });
  if (!registration.registered) {
    const temporary = registration.reason === "unreachable" || registration.status === 429 || registration.status !== null && registration.status >= 500;
    const message = temporary ? "The sign-in provider is unavailable or is limiting requests. Check again before importing."
      : /trusted partner|approved app|pre.registered.*partner/i.test(registration.message) ? "This provider only accepts approved applications. LegalWork needs an approved OAuth registration before this connector can be imported."
      : /IP (?:address|allow|white)|whitelist|allowlist/i.test(registration.message) ? "The sign-in provider reports an IP access restriction. Ask your administrator to allow connections from the LegalWork server, then check again."
      : /redirect|callback/i.test(registration.message) ? "The provider rejected this sign-in callback. Correct the source callback configuration or register a compatible OAuth application before importing."
      : registration.reason === "unsupported" ? "The provider requires a client registration method LegalWork cannot use. Obtain a compatible OAuth registration before importing."
      : "The sign-in provider did not register LegalWork. Ask your administrator to check application approval and network access, including any IP allowlist, then check again.";
    return blocked(temporary ? "registration_unreachable" : "registration_refused", message, registration.reason !== "unsupported");
  }
  // Retain the registered identity only in the server-owned prepared plan. It is
  // installed with exactly the callback/scopes checked here, without a second DCR.
  config.oauth = { ...oauth, ...registration.client, redirectUri };
  return { ...check, status: "setup", code: "sign_in", message: "LegalWork's sign-in application is registered. Sign in after importing; the provider will then check your account's access." };
}

async function checkLocal(check: ConnectorImportCheck, config: Record<string, unknown>, plan: PluginImportPlan, target: ImportTarget): Promise<ConnectorImportCheck> {
  if (connectorConfigVariables(config).length) return { ...check, status: "setup", code: "inputs", inputs: connectorConfigVariables(config) };
  const program = Array.isArray(config.command) && typeof config.command[0] === "string" ? config.command[0] : "";
  const packaged = plan.resourceFiles.some(file => resolveWorkspaceInstallPath(target.workspace, file.path, target.scope === "global") === program && (process.platform === "win32" || (file.mode & 0o111) !== 0));
  const available = packaged || await connectorProgramAvailable(program);
  if (!available) return { ...check, status: "blocked", code: "program_missing", message: `The program “${program}” is not available on the LegalWork server. Install it there or correct the source configuration, then check again.`, retryable: true };
  return { ...check, status: "setup", code: "local_program", message: "The program is available on the LegalWork server. Configure any dependencies and enable the connector after importing. Import checks do not execute the program." };
}

async function prepare(plan: PluginImportPlan, target: ImportTarget, options: McpProbeOptions, recheck: boolean): Promise<PluginImportPlan> {
  for (const [id, value] of preparations) if (value.expires <= Date.now()) preparations.delete(id);
  const key = keyFor(plan, target);
  const cached = [...preparations.values()].find(value => value.key === key);
  if (cached && !recheck) return cached.plan;
  const prepared = structuredClone(plan);
  const checks = prepared.preview.connectors ?? [];
  const configs: Record<string, unknown> = {};
  const defaults: Record<string, Record<string, unknown>> = {};
  const deadline = AbortSignal.timeout(60_000);
  const originalFetch = options.fetch ?? fetch;
  const boundedOptions: McpProbeOptions = { ...options, timeoutMs: options.timeoutMs ?? 6000, fetch: (input, init) => originalFetch(input, { ...init, signal: init?.signal ? AbortSignal.any([deadline, init.signal]) : deadline }) };
  const owned = new Set(target.installed?.files.filter(file => file.objectType === "mcp").map(file => file.path.replace(/^opencode\.jsonc#mcp\./, "")));
  // Bound network work; checks are sequential to avoid flooding provider DCR.
  if (checks.length > 25) throw new ApiError(400, "too_many_import_connectors", "Import at most 25 connectors at a time. Split this package into smaller imports.");
  for (let index = 0; index < checks.length; index++) {
    let check = checks[index];
    const raw = prepared.connectorConfigs?.[check.installedName];
    if (!raw) continue;
    let config = normalizePluginMcpConfig(raw);
    const sourceDefault = config ? structuredClone(config) : null;
    const current = target.current[check.installedName];
    if (config && owned.has(check.installedName) && importRecord(current)) config = mergeConnectorSetup(config, current, target.installed?.connectorDefaults?.[check.installedName]);
    if (cached?.plan.preview.connectors?.find(previous => previous.installedName === check.installedName)?.status !== "blocked") {
      const registered = cached?.plan.connectorConfigs?.[check.installedName];
      if (registered) config = normalizePluginMcpConfig(registered);
    }
    if (config && check.status === "blocked" && ["provider_approval", "missing_registration"].includes(check.code) && importRecord(config.oauth) && typeof config.oauth.clientId === "string" && config.oauth.clientId && !connectorConfigVariables(config.oauth.clientId).length) check = { ...check, status: "unchecked", documentationUrl: undefined };
    if (!config || check.status === "blocked") continue;
    checks[index] = config.type === "local" ? await checkLocal(check, config, prepared, target) : await checkRemote(check, config, boundedOptions);
    if (prepared.connectorConfigs) prepared.connectorConfigs[check.installedName] = config;
    if (checks[index].status !== "blocked") {
      configs[check.installedName] = config;
      if (sourceDefault) {
        // A client registered here is an import default, unlike credentials
        // carried over from a user's previously configured connection.
        if (importRecord(config.oauth) && !importRecord(current) && !connectorConfigVariables(config.oauth).length) sourceDefault.oauth = config.oauth;
        defaults[check.installedName] = sourceDefault;
      }
    }
  }
  const excluded = checks.filter(check => check.status === "blocked");
  const blockedNames = new Set(excluded.map(check => check.installedName));
  prepared.preview.components = prepared.preview.components.filter(component => !blockedNames.has(component.installedName));
  // A previously configured provider-approved connector may be restored on reimport.
  for (const check of checks) if (!blockedNames.has(check.installedName) && !prepared.preview.components.some(component => component.installedName === check.installedName)) prepared.preview.components.push({ type: "mcp", name: check.name, installedName: check.installedName });
  prepared.resolved.memberships = prepared.resolved.memberships.filter(membership => membership.configObject?.objectType !== "mcp");
  if (Object.keys(configs).length) prepared.resolved.memberships.push({ configObjectId: `${prepared.preview.id}/mcp`, configObject: { id: `${prepared.preview.id}/mcp`, objectType: "mcp", title: prepared.preview.name, description: null, currentRelativePath: null, status: "active", updatedAt: null, latestVersion: { id: "mcp", rawSourceText: null, normalizedPayloadJson: { mcpServers: configs } } } });
  prepared.resolved.plugin.excludedConnectors = excluded.map(check => ({ name: check.name, message: check.message }));
  prepared.resolved.plugin.connectorDefaults = defaults;
  evaluateImportRequirements(prepared.preview, target.available);
  prepared.resolved.plugin.importState = { readiness: prepared.preview.readiness || "ready", requirements: prepared.preview.requirements || [] };
  // Keep durable diagnostics credential-free. Prepared registration is not source metadata.
  const report = prepared.resourceFiles.at(-1);
  if (report && /\/LEGALWORK-IMPORT(?:-\d+)?\.json$/.test(report.path)) report.bytes = Buffer.from(JSON.stringify(prepared.preview, null, 2));
  const id = randomUUID();
  prepared.preview.validationId = id;
  for (const [previousId, value] of preparations) if (value.key === key) preparations.delete(previousId);
  preparations.set(id, { key, expires: Date.now() + TTL, plan: prepared, bytes: prepared.resourceFiles.reduce((total, file) => total + file.bytes.length, 0) });
  while (preparations.size > MAX_PREPARATIONS || [...preparations.values()].reduce((total, value) => total + value.bytes, 0) > MAX_PREPARED_BYTES) preparations.delete(preparations.keys().next().value ?? "");
  return prepared;
}

/** Concurrent preview requests share registration rather than creating orphan clients. */
export async function preparePluginImport(plan: PluginImportPlan, target: ImportTarget, options: McpProbeOptions = {}, recheck = false): Promise<PluginImportPlan> {
  const key = keyFor(plan, target);
  const pending = pendingPreparations.get(key);
  if (pending) return pending;
  const work = prepare(plan, target, options, recheck);
  pendingPreparations.set(key, work);
  try { return await work; } finally { pendingPreparations.delete(key); }
}

/** Client-supplied assessment cannot authorize an install. Source/config changes require review again. */
export function reviewedPluginImport(plan: PluginImportPlan, target: ImportTarget, validationId?: string): PluginImportPlan {
  if (!plan.preview.connectors?.length && !plan.preview.provenance && !plan.preview.requirements?.length) return plan;
  const prepared = validationId ? preparations.get(validationId) : undefined;
  if (!prepared || prepared.expires <= Date.now() || prepared.key !== keyFor(plan, target)) throw new ApiError(409, "connector_review_expired", "The connector review expired or its configuration changed. Check the import again.");
  if (!prepared.plan.preview.components.length) throw new ApiError(400, "connectors_not_supported", "None of these connectors can be used by LegalWork. Review the reasons before choosing another configuration.");
  return structuredClone(prepared.plan);
}

export function assertImportable(plan: PluginImportPlan, acknowledgePartial = false) {
  const required = plan.preview.requirements?.filter(item => item.required && item.status === "blocked");
  if (required?.length) throw new ApiError(400, "plugin_requirements_unmet", required.map(item => item.message).join(" "));
  if (!plan.preview.components.length) throw new ApiError(400, "no_importable_components", "This package has no supported items to import.");
  if (plan.preview.readiness === "partial" && !acknowledgePartial) throw new ApiError(409, "partial_import_confirmation", "Review the omitted behavior and confirm that you want to import only the supported contents.");
}
