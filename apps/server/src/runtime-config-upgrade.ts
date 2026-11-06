import { Config } from "@opencode/schema/config";
import { Provider } from "@opencode/schema/provider";
import { Schema } from "effect";

export type NativeRuntimeConfiguration = typeof Config.Info.Type;
export const RUNTIME_CONFIGURATION_VERSION = 2;
type RecordValue = Record<string, unknown>;
export type RuntimeConfigUpgradeNotice = {
  code: "legacy_agent_generation_requires_native_support";
  agentId: string;
  fields: string[];
} | { code: "legacy_workspace_tool_permissions_inactive"; fields: string[] }
  | { code: "retired_managed_browser_replaced"; fields: string[] }
  | { code: "sandbox_settings_repaired"; fields: string[] };
export type RuntimeConfigUpgradeResult = {
  configuration: NativeRuntimeConfiguration;
  application: RecordValue;
  notices: RuntimeConfigUpgradeNotice[];
  sourceVersion: number;
  migrated: boolean;
};

const applicationKeys = new Set(["sandbox", "sandboxEdit", "sandboxSync", "sandboxNetworkMode", "personalization", "providerActivation", "providerModelSelection", "projectPermissionApprovals", "nativeSavedApprovalImportIDs"]);
const legacyKeys = new Set(["permission", "provider", "agent", "plugin", "disabled_providers", "enabled_providers", "tools", "subagent_depth"]);
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved configuration must be an object.");
  return Object.fromEntries(Object.entries(value));
}
function optionalRecord(value: unknown): RecordValue { return value === undefined ? {} : record(value); }
function defined(value: RecordValue) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function strings(value: unknown): string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new Error("Saved configuration requires a string list.");
  return value;
}
function action(value: string) { return value === "bash" ? "shell" : value === "task" ? "subagent" : value; }
function permissions(value: unknown) {
  const result: Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }> = [];
  if (value === undefined) return result;
  for (const [name, rule] of typeof value === "string" ? [["*", value]] : Object.entries(record(value))) {
    for (const [resource, effect] of typeof rule === "string" ? [["*", rule]] : Object.entries(record(rule))) {
      if (effect !== "allow" && effect !== "ask" && effect !== "deny") throw new Error(`Invalid saved permission ${name}:${resource}.`);
      result.push({ action: action(String(name)), resource: String(resource), effect });
    }
  }
  return result;
}
function legacyPermissionRules(permission: unknown, tools: unknown) {
  const rules = new Map<string, unknown>();
  for (const [name, enabled] of Object.entries(optionalRecord(tools))) {
    if (typeof enabled !== "boolean") throw new Error(`Invalid saved tool switch ${name}.`);
    // V1 normalized these deprecated tool switches, but not permission keys.
    rules.set(name === "write" || name === "patch" ? "edit" : name, enabled ? "allow" : "deny");
  }
  for (const [name, rule] of typeof permission === "string" ? [["*", permission]] : Object.entries(optionalRecord(permission))) rules.set(String(name), rule);
  return permissions(Object.fromEntries(rules));
}
function packageName(value: unknown) {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error("Saved provider package must be a string.");
  if (value === "@ai-sdk/openai-compatible") return "@opencode/ai/providers/openai-compatible";
  if (value === "@ai-sdk/openai") return "@opencode/ai/providers/openai/responses";
  return value.startsWith("@ai-sdk/") ? `aisdk:${value}` : value;
}
function providerOptions(value: unknown) {
  const { headers, body, setCacheKey, ...settings } = optionalRecord(value);
  const headerOverlay = headers && typeof headers === "object" && !Array.isArray(headers)
    ? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
  const bodyOverlay = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : undefined;
  return defined({ settings, headers: headerOverlay, body: bodyOverlay, compatibility: setCacheKey === undefined ? undefined : { supportsPromptCacheKey: setCacheKey } });
}
const compatibleKeys = new Set(["apiKey", "baseURL", "headers", "body", "extraBody", "timeout", "chunkTimeout", "headerTimeout", "disabled", "reasoningEffort", "textVerbosity", "user", "strictJsonSchema"]);
function modelOptions(value: unknown, compatible: boolean) {
  const input = optionalRecord(value);
  if (!compatible) return { settings: input };
  return { settings: Object.fromEntries(Object.entries(input).filter(([key]) => compatibleKeys.has(key))), body: Object.fromEntries(Object.entries(input).filter(([key]) => !compatibleKeys.has(key))) };
}
function cost(value: unknown) {
  const item = record(value);
  return defined({ input: item.input, output: item.output, cache: defined({ read: item.cache_read, write: item.cache_write }) });
}
function legacyModel(value: unknown, providerPackage: unknown) {
  const item = record(value), provider = optionalRecord(item.provider), modalities = optionalRecord(item.modalities);
  const compatible = (provider.npm ?? providerPackage) === "@ai-sdk/openai-compatible";
  const options = modelOptions(item.options, compatible);
  const thinking = optionalRecord(options.settings.thinking), reasoning = optionalRecord(options.settings.reasoningConfig);
  const noBinding = thinking.blockBinding === false || reasoning.blockBinding === false;
  for (const key of ["thinking", "reasoningConfig"]) {
    const nested = optionalRecord(options.settings[key]);
    if (nested.blockBinding !== false) continue;
    const { blockBinding, ...rest } = nested;
    if (Object.keys(rest).length) options.settings[key] = rest;
    else delete options.settings[key];
  }
  const interleaved = typeof item.interleaved === "string" ? item.interleaved
    : item.interleaved && typeof item.interleaved === "object" && !Array.isArray(item.interleaved) ? Reflect.get(item.interleaved, "field") : undefined;
  const capabilities = defined({ tools: item.tool_call, input: modalities.input, output: modalities.output,
    temperature: item.temperature, reasoning: typeof item.reasoning === "boolean" ? { supported: item.reasoning } : undefined });
  const compatibility = defined({ reasoningField: interleaved, supportsThinkingBlockBinding: noBinding ? false : undefined });
  return defined({ modelID: item.id, family: item.family, name: item.name, releaseDate: item.release_date,
    package: packageName(provider.npm), compatibility: Object.keys(compatibility).length ? compatibility : undefined,
    ...options, settings: { ...options.settings, ...(provider.api ? { baseURL: provider.api } : {}) },
    headers: item.headers, capabilities: Object.keys(capabilities).length ? capabilities : undefined,
    variants: item.variants === undefined ? undefined : Object.entries(record(item.variants)).filter(([, value]) => optionalRecord(value).disabled !== true).map(([id, value]) => {
      const { disabled, ...settings } = record(value); return { id, ...modelOptions(settings, compatible) };
    }),
    cost: item.cost === undefined ? undefined : [cost(item.cost), ...(optionalRecord(item.cost).context_over_200k ? [{ tier: { type: "context", size: 200_000 }, ...cost(optionalRecord(item.cost).context_over_200k) }] : [])],
    disabled: item.status === "deprecated" ? true : undefined, limit: item.limit });
}
function legacyProvider(value: unknown) {
  const item = record(value), options = providerOptions(item.options);
  const allow = strings(item.whitelist); // Also preserved as the app's project-scoped selection below.
  const models = Object.fromEntries(Object.entries(optionalRecord(item.models)).filter(([id]) => allow === undefined || allow.includes(id)).map(([id, model]) => [id, legacyModel(model, item.npm)]));
  for (const id of strings(item.blacklist) ?? []) if (allow === undefined || allow.includes(id)) models[id] = { ...models[id], disabled: true };
  return defined({ name: item.name, env: item.env, package: packageName(item.npm), ...options,
    settings: { ...optionalRecord(options.settings), ...(item.api ? { baseURL: item.api } : {}) },
    models: Object.keys(models).length ? models : undefined });
}

function currentProviderID(id: string) {
  return Provider.ID.make(id === "azure-cognitive-services" ? "azure" : id === "google-vertex-anthropic" ? "google-vertex" : id);
}
function currentProviderKeys<T>(entries: Record<string, T>) {
  // An explicitly configured current ID wins over its retired alias, in either
  // insertion order. Do not merge old endpoints or models into newer settings.
  return Object.fromEntries(Object.entries(entries)
    .filter(([id]) => currentProviderID(id) === id || !Object.hasOwn(entries, currentProviderID(id)))
    .map(([id, value]) => [currentProviderID(id), value]));
}
function currentProvider(id: string, provider: NonNullable<NativeRuntimeConfiguration["providers"]>[string]) {
  if (provider.canonical) provider = { ...provider, canonical: currentProviderID(provider.canonical) };
  if (id === "azure-cognitive-services") {
    const compatible = ["@opencode/ai/providers/openai-compatible", "aisdk:@ai-sdk/openai-compatible"].includes(provider.package ?? "");
    return { ...provider, ...(provider.env && { env: provider.env.filter(name => name !== "AZURE_COGNITIVE_SERVICES_RESOURCE_NAME") }),
      ...(compatible && provider.settings?.baseURL === undefined
        ? { settings: { ...provider.settings, baseURL: "https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.cognitiveservices.azure.com/openai" } } : {}) };
  }
  if (id === "google-vertex-anthropic") {
    // Gemini and Claude now share a provider. The old Claude package belongs on
    // those saved models, rather than replacing the SDK for every Vertex model.
    const { package: providerPackage, ...rest } = provider;
    return { ...rest, ...(provider.models && { models: Object.fromEntries(Object.entries(provider.models)
      .map(([name, model]) => [name, { ...model, package: model.package ?? providerPackage ?? "aisdk:@ai-sdk/google-vertex/anthropic" }])) }) };
  }
  return provider;
}
function upgradeRetiredProviders(result: RuntimeConfigUpgradeResult): RuntimeConfigUpgradeResult {
  const configuration = { ...result.configuration,
    ...(result.configuration.providers && { providers: currentProviderKeys(Object.fromEntries(Object.entries(result.configuration.providers)
      .map(([id, provider]) => [id, currentProvider(id, provider)]))) }),
    ...(result.configuration.agents && { agents: Object.fromEntries(Object.entries(result.configuration.agents)
      .map(([id, agent]) => [id, { ...agent, ...(agent.model && { model: { ...agent.model, providerID: currentProviderID(agent.model.providerID) } }) }])) }),
    ...(result.configuration.model && { model: { ...result.configuration.model, providerID: currentProviderID(result.configuration.model.providerID) } }),
    ...(result.configuration.policies && { policies: result.configuration.policies.map(rule => rule.action === "provider.use"
      ? { ...rule, resource: currentProviderID(rule.resource) } : rule) }),
  };
  const application = { ...result.application };
  for (const name of ["providerActivation", "providerModelSelection"]) {
    if (application[name] !== undefined) application[name] = currentProviderKeys(record(application[name]));
  }
  return { ...result, configuration, application, migrated: result.migrated
    || JSON.stringify(configuration) !== JSON.stringify(result.configuration) || JSON.stringify(application) !== JSON.stringify(result.application) };
}

function retiredManagedBrowser(value: unknown) {
  const spec = typeof value === "string" ? value : value && typeof value === "object" && !Array.isArray(value) ? Reflect.get(value, "package") : undefined;
  if (typeof spec !== "string") return false;
  if (/^(?:npm:)?opencode-chrome-devtools(?:@[^/\\]+)?$/.test(spec)) return true;
  const path = spec.replace(/[?#].*$/, "").replaceAll("\\", "/");
  return /(?:^|\/)legalwork-chrome-devtools\.(?:js|ts)$/.test(path) || /(?:^|\/)legalwork-chrome-devtools\/index\.js$/.test(path);
}
function legacyAgent(value: unknown, agentId: string, notices: RuntimeConfigUpgradeNotice[]) {
  const item = record(value);
  // Keep the same ordered merge as upstream V1: deprecated tool switches first,
  // followed by explicit permissions. A scalar rule is a wildcard, not {}.
  const known = new Set(["name", "model", "variant", "temperature", "top_p", "prompt", "tools", "disable", "description", "mode", "hidden", "options", "color", "steps", "maxSteps", "permission"]);
  const options = { ...optionalRecord(item.options), ...Object.fromEntries(Object.entries(item).filter(([name]) => !known.has(name))) };
  const body = defined({ ...options, temperature: item.temperature, top_p: item.top_p });
  if (Object.keys(body).length) notices.push({ code: "legacy_agent_generation_requires_native_support", agentId, fields: Object.keys(body) });
  return defined({ model: typeof item.model === "string" && item.variant ? `${item.model}#${item.variant}` : item.model,
    system: item.prompt, description: item.description, mode: item.mode, hidden: item.hidden,
    color: typeof item.color === "string" ? /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color : "#aaaaaa" : undefined,
    steps: item.steps ?? item.maxSteps, disabled: item.disable, permissions: legacyPermissionRules(item.permission, item.tools),
    request: Object.keys(body).length ? { body } : undefined });
}
function legacyMcp(value: unknown) {
  const { enabled, disabled, oauth, timeout, ...rest } = record(value), auth = optionalRecord(oauth === false ? undefined : oauth);
  const { clientId, clientSecret, callbackPort, redirectUri, ...nativeAuth } = auth;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new Error("Invalid saved connector enablement.");
  if (disabled !== undefined && typeof disabled !== "boolean" || enabled !== undefined && disabled !== undefined && enabled === disabled) throw new Error("Conflicting saved connector enablement.");
  return defined({ ...rest, disabled: enabled === undefined ? disabled : !enabled,
    oauth: oauth === false ? false : oauth === undefined ? undefined : defined({ ...nativeAuth, client_id: Object.hasOwn(auth, "client_id") ? auth.client_id : clientId,
      client_secret: Object.hasOwn(auth, "client_secret") ? auth.client_secret : clientSecret,
      callback_port: Object.hasOwn(auth, "callback_port") ? auth.callback_port : callbackPort, redirect_uri: Object.hasOwn(auth, "redirect_uri") ? auth.redirect_uri : redirectUri }),
    timeout: typeof timeout === "number" ? { startup: timeout, catalog: timeout, execution: timeout } : timeout });
}
function upgradeMcp(value: unknown) {
  const mcp = record(value);
  try { Schema.decodeUnknownSync(Config.Info)({ mcp }, { onExcessProperty: "error" }); return mcp; }
  catch { /* Historical connector fields still require normalization. */ }
  const servers = optionalRecord(mcp.servers);
  // A legacy connector can itself be named "servers". Its type identifies
  // the definition; an actual namespace retains its timeout and other fields.
  const nested = mcp.servers !== undefined && !["local", "remote"].includes(String(servers.type));
  const definitions = Object.fromEntries(Object.entries(nested ? servers : mcp).map(([id, item]) => [id, legacyMcp(item)]));
  return nested ? { ...mcp, servers: definitions } : { servers: definitions };
}
function split(input: RecordValue) {
  const application: RecordValue = {}, configuration: RecordValue = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "configurationVersion" || value === undefined) continue;
    (applicationKeys.has(key) ? application : configuration)[key] = structuredClone(value);
  }
  return { application, configuration };
}
export function decodeNativeRuntimeConfigRecord(value: unknown): RuntimeConfigUpgradeResult {
  const input = record(value);
  if (input.configurationVersion !== undefined && input.configurationVersion !== RUNTIME_CONFIGURATION_VERSION) throw new Error("Unsupported saved configuration version.");
  const { application, configuration } = split(input);
  for (const name of legacyKeys) if (Object.hasOwn(configuration, name)) throw new Error(`Legacy field ${name} cannot be written to native configuration.`);
  return { configuration: Schema.decodeUnknownSync(Config.Info)(configuration, { onExcessProperty: "error" }), application, notices: [], sourceVersion: RUNTIME_CONFIGURATION_VERSION, migrated: false };
}

/** Upgrade boundary only. Normal settings reads/writes must use the native decoder.
 * Top-level provider/agent versus providers/agents declares the entry format;
 * native entries are never inferred from a handful of nested field names. */
export function upgradeRuntimeConfigRecord(value: unknown, options: { scope?: "configuration" | "workspace" | "host" } = {}): RuntimeConfigUpgradeResult {
  const input = record(value);
  if (input.configurationVersion === RUNTIME_CONFIGURATION_VERSION) {
    let result: RuntimeConfigUpgradeResult;
    try { result = decodeNativeRuntimeConfigRecord(input); }
    catch (error) {
      if (input.mcp === undefined) throw error;
      result = { ...decodeNativeRuntimeConfigRecord({ ...input, mcp: upgradeMcp(input.mcp) }), migrated: true };
    }
    return upgradeRetiredProviders(result);
  }
  if (input.configurationVersion !== undefined && input.configurationVersion !== 1) throw new Error("Unsupported saved configuration version.");
  const { application, configuration: source } = split(input);
  const { permission, provider, agent, plugin, disabled_providers, enabled_providers, tools, subagent_depth, ...native } = source;
  if (native.policies !== undefined && !Array.isArray(native.policies)) throw new Error("Saved native policies must be an ordered list.");
  if (native.plugins !== undefined && !Array.isArray(native.plugins)) throw new Error("Saved native plugins must be a list.");
  const notices: RuntimeConfigUpgradeNotice[] = [];
  const modelSelection = { ...optionalRecord(application.providerModelSelection) };
  for (const [id, value] of Object.entries(optionalRecord(provider))) {
    const allow = strings(record(value).whitelist);
    if (allow !== undefined && !Object.hasOwn(optionalRecord(native.providers), id)
      && !Object.hasOwn(optionalRecord(native.providers), currentProviderID(id))) modelSelection[id] = allow;
  }
  if (Object.keys(modelSelection).length) application.providerModelSelection = modelSelection;
  const providers = { ...Object.fromEntries(Object.entries(optionalRecord(provider)).map(([id, item]) => [id, legacyProvider(item)])), ...optionalRecord(native.providers) };
  const agents = { ...Object.fromEntries(Object.entries(optionalRecord(agent)).map(([id, item]) => [id, legacyAgent(item, id, notices)])), ...optionalRecord(native.agents) };
  let rules = legacyPermissionRules(permission, tools);
  const inactive = options.scope === "workspace" ? rules.filter(rule => rule.action !== "external_directory").map(rule => rule.action) : [];
  if (options.scope === "workspace") rules = rules.filter(rule => rule.action === "external_directory");
  if (inactive.length) notices.push({ code: "legacy_workspace_tool_permissions_inactive", fields: [...new Set(inactive)] });
  const nativeRules = native.permissions === undefined ? [] : Schema.decodeUnknownSync(Config.Info)({ permissions: native.permissions }, { onExcessProperty: "error" }).permissions ?? [];
  const policies = [...(strings(enabled_providers) ? [{ action: "provider.use", resource: "*", effect: "deny" }, ...strings(enabled_providers)!.map(resource => ({ action: "provider.use", resource, effect: "allow" }))] : []),
    ...(strings(disabled_providers) ?? []).map(resource => ({ action: "provider.use", resource, effect: "deny" })), ...(Array.isArray(native.policies) ? native.policies : [])];
  const mcp = native.mcp === undefined ? undefined : upgradeMcp(native.mcp);
  const skills = Array.isArray(native.skills) ? native.skills : [...strings(optionalRecord(native.skills).paths) ?? [], ...strings(optionalRecord(native.skills).urls) ?? []];
  const experimental = optionalRecord(native.experimental);
  delete experimental.continue_loop_on_deny;
  if (experimental.subagent_depth === undefined && subagent_depth !== undefined) experimental.subagent_depth = subagent_depth;
  const plugins = [...strings(plugin) ?? [], ...(Array.isArray(native.plugins) ? native.plugins : [])];
  if (plugins.some(retiredManagedBrowser)) notices.push({ code: "retired_managed_browser_replaced", fields: ["plugins"] });
  const configuration = Schema.decodeUnknownSync(Config.Info)(defined({ ...native,
    providers: provider !== undefined || native.providers !== undefined ? providers : undefined,
    agents: agent !== undefined || native.agents !== undefined ? agents : undefined,
    permissions: permission !== undefined || tools !== undefined || native.permissions !== undefined ? [...rules, ...nativeRules] : undefined,
    policies: enabled_providers !== undefined || disabled_providers !== undefined || native.policies !== undefined ? policies : undefined,
    plugins: plugin !== undefined || native.plugins !== undefined ? plugins.filter(value => !retiredManagedBrowser(value)) : undefined,
    mcp,
    skills: native.skills === undefined ? undefined : skills,
    experimental: native.experimental === undefined && subagent_depth === undefined ? undefined : experimental,
  }), { onExcessProperty: "error" });
  return upgradeRetiredProviders({ configuration, application, notices, sourceVersion: typeof input.configurationVersion === "number" ? input.configurationVersion : 0, migrated: true });
}

export function nativeRuntimeConfigRecord(result: Pick<RuntimeConfigUpgradeResult, "configuration" | "application">): RecordValue {
  return { ...result.application, ...result.configuration, configurationVersion: RUNTIME_CONFIGURATION_VERSION };
}

/** Native-only normal-operation boundary; never calls the one-time importer. */
export function runtimeEngineConfiguration(value: unknown): NativeRuntimeConfiguration {
  return decodeNativeRuntimeConfigRecord(value).configuration;
}
