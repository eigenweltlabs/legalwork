import { Config } from "@opencode/schema/config";
import { Schema } from "effect";

type RecordValue = Record<string, unknown>;
export type NativeConfig = typeof Config.Info.Type;
export type ModelFilter = { allow?: string[]; deny?: string[] };

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}
function present(value: RecordValue) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
/** Retire only LegalWork's former managed browser adapter. Its functionality is
 * supplied by the native browser and LegalWork extensions; saved files stay intact. */
export function isRetiredBrowserPlugin(spec: unknown): boolean {
  if (typeof spec !== "string") return false;
  if (/^(?:npm:)?opencode-chrome-devtools(?:@[^/\\]+)?$/.test(spec)) return true;
  const path = spec.replace(/[?#].*$/, "").replaceAll("\\", "/");
  return /(?:^|\/)legalwork-chrome-devtools\.(?:js|ts)$/.test(path) || /(?:^|\/)legalwork-chrome-devtools\/index\.js$/.test(path);
}
export function nativeAction(action: string): string {
  return action === "bash" ? "shell" : action === "task" ? "subagent" : ["write", "patch", "apply_patch"].includes(action) ? "edit" : action;
}
export function nativePermissions(value: unknown): Array<{ action: string; resource: string; effect: "allow" | "ask" | "deny" }> {
  const result: ReturnType<typeof nativePermissions> = [];
  const entries = typeof value === "string" ? [["*", value]] : Object.entries(record(value));
  for (const [name, rule] of entries) {
    const action = nativeAction(String(name));
    for (const [resource, effect] of typeof rule === "string" ? [["*", rule]] : Object.entries(record(rule))) {
      if (effect !== "allow" && effect !== "ask" && effect !== "deny") throw new Error(`Invalid permission effect for ${action}:${resource}`);
      result.push({ action, resource: String(resource), effect });
    }
  }
  return result;
}
function packageName(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  if (value === "@ai-sdk/openai-compatible") return "@opencode/ai/providers/openai-compatible";
  if (value === "@ai-sdk/openai") return "@opencode/ai/providers/openai/responses";
  return value.startsWith("@ai-sdk/") ? `aisdk:${value}` : value;
}
function overlays(value: unknown) {
  const { headers, body, setCacheKey, ...settings } = record(value);
  return { settings, ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }),
    ...(setCacheKey === undefined ? {} : { compatibility: { supportsPromptCacheKey: setCacheKey } }) };
}
const compatibleSettings = new Set(["apiKey", "baseURL", "headers", "body", "extraBody", "timeout", "chunkTimeout", "headerTimeout", "disabled", "reasoningEffort", "textVerbosity", "user", "strictJsonSchema"]);
function modelOptions(value: unknown, compatible: boolean) {
  const options = record(value);
  if (!compatible) return { settings: options };
  return {
    settings: Object.fromEntries(Object.entries(options).filter(([key]) => compatibleSettings.has(key))),
    body: Object.fromEntries(Object.entries(options).filter(([key]) => !compatibleSettings.has(key))),
  };
}
function cost(value: unknown) {
  const item = record(value);
  return { input: item.input, output: item.output, cache: present({ read: item.cache_read, write: item.cache_write }) };
}
function migrateModel(value: unknown, providerPackage: unknown): RecordValue {
  const item = record(value), provider = record(item.provider), modalities = record(item.modalities);
  const compatible = (provider.npm ?? providerPackage) === "@ai-sdk/openai-compatible";
  const options = modelOptions(item.options, compatible);
  const thinking = record(options.settings.thinking), reasoning = record(options.settings.reasoningConfig);
  const noBinding = thinking.blockBinding === false || reasoning.blockBinding === false;
  for (const [key, nested] of [["thinking", thinking], ["reasoningConfig", reasoning]]) {
    if (typeof key !== "string" || typeof nested !== "object" || !nested || !("blockBinding" in nested) || nested.blockBinding !== false) continue;
    const { blockBinding, ...rest } = nested;
    if (Object.keys(rest).length) options.settings[key] = rest;
    else delete options.settings[key];
  }
  const interleaved = item.interleaved;
  const compatibility = present({
    ...(typeof interleaved === "string" ? { reasoningField: interleaved } : {}),
    ...(typeof record(interleaved).field === "string" ? { reasoningField: record(interleaved).field } : {}),
    ...(noBinding ? { supportsThinkingBlockBinding: false } : {}),
  });
  return present({
    modelID: item.id, name: item.name, family: item.family,
    package: packageName(provider.npm),
    ...(Object.keys(compatibility).length ? { compatibility } : {}),
    ...options, settings: { ...options.settings, ...(provider.api ? { baseURL: provider.api } : {}) },
    headers: item.headers,
    ...(item.tool_call !== undefined || Object.keys(modalities).length ? { capabilities: present({ tools: item.tool_call, input: modalities.input, output: modalities.output }) } : {}),
    variants: item.variants === undefined ? undefined : Object.entries(record(item.variants)).filter(([, options]) => record(options).disabled !== true).map(([id, options]) => ({ id, ...modelOptions(options, compatible) })),
    cost: item.cost === undefined ? undefined : [cost(item.cost), ...(record(item.cost).context_over_200k ? [{ tier: { type: "context", size: 200_000 }, ...cost(record(item.cost).context_over_200k) }] : [])],
    disabled: item.status === "deprecated" ? true : undefined,
    limit: item.limit,
  });
}
export function nativeProvider(value: unknown): RecordValue {
  const item = record(value);
  // A nested provider is entirely native or legacy, matching upstream's rule.
  if (["package", "settings", "body", "compatibility", "canonical"].some(key => Object.hasOwn(item, key))) return item;
  const options = overlays(item.options);
  return present({ name: item.name, env: item.env, package: packageName(item.npm), ...options,
    settings: { ...options.settings, ...(item.api ? { baseURL: item.api } : {}) },
    models: item.models === undefined ? undefined : Object.fromEntries(Object.entries(record(item.models)).map(([id, model]) => [id, migrateModel(model, item.npm)])),
  });
}
export function nativeAgent(value: unknown): RecordValue {
  const item = record(value);
  if (["system", "permissions", "request", "disabled"].some(key => Object.hasOwn(item, key))) return item;
  const tools = Object.fromEntries(Object.entries(record(item.tools)).map(([name, enabled]) => [name, enabled ? "allow" : "deny"]));
  return present({ model: typeof item.model === "string" && item.variant ? `${item.model}#${item.variant}` : item.model,
    system: item.prompt, description: item.description, mode: item.mode, hidden: item.hidden,
    color: typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color : undefined,
    steps: item.steps ?? item.maxSteps, disabled: item.disable,
    permissions: nativePermissions({ ...tools, ...record(item.permission) }),
  });
}
export function nativeMcpServer(value: unknown): RecordValue {
  const item = record(value), { enabled, oauth, timeout, ...rest } = item;
  const auth = record(oauth);
  return present({ ...rest,
    ...(enabled === undefined ? {} : { disabled: !enabled }),
    oauth: oauth === false ? false : oauth === undefined ? undefined : present({
      client_id: auth.client_id ?? auth.clientId, client_secret: auth.client_secret ?? auth.clientSecret,
      scope: auth.scope, callback_port: auth.callback_port ?? auth.callbackPort, redirect_uri: auth.redirect_uri ?? auth.redirectUri,
    }),
    timeout: typeof timeout === "number" ? { startup: timeout, catalog: timeout, execution: timeout } : timeout,
  });
}

/** App-owned inputs only. User files stay untouched and are normalized by the
 * released engine. Mappings follow pinned upstream v1/config/migrate.ts. */
export function nativeOpencodeConfig(input: RecordValue): { config: NativeConfig; modelFilters: Record<string, ModelFilter>; agentRequests: Record<string, RecordValue> } {
  const { permission, provider, agent, plugin, disabled_providers, enabled_providers, tools, personalization,
    sandbox, sandboxEdit, sandboxSync, sandboxNetworkMode, providerActivation, ...native } = input;
  const modelFilters: Record<string, ModelFilter> = {};
  const providers: RecordValue = { ...record(provider), ...record(native.providers) };
  for (const [id, value] of Object.entries(providers)) {
    const item = record(value);
    if (item.whitelist !== undefined || item.blacklist !== undefined) modelFilters[id] = { allow: strings(item.whitelist), deny: strings(item.blacklist) };
    providers[id] = nativeProvider(value);
  }
  const agents: RecordValue = { ...record(agent), ...record(native.agents) }, agentRequests: Record<string, RecordValue> = {};
  for (const [id, value] of Object.entries(agents)) {
    const item = record(value);
    // V2 ignores agent.request.body. Preserve active V1 generation settings in
    // the primary context hook rather than storing an ineffective config field.
    const request = present({ ...record(item.options), temperature: item.temperature, topP: item.top_p });
    if (Object.keys(request).length) agentRequests[id] = request;
    agents[id] = nativeAgent(item);
  }
  const permissions = [...nativePermissions(permission), ...nativePermissions(Object.fromEntries(Object.entries(record(tools)).map(([name, enabled]) => [name, enabled ? "allow" : "deny"]))),
    ...(Array.isArray(native.permissions) ? native.permissions : [])];
  const policies = [
    ...(strings(enabled_providers) ? [{ action: "provider.use", resource: "*", effect: "deny" }, ...strings(enabled_providers)!.map(resource => ({ action: "provider.use", resource, effect: "allow" }))] : []),
    ...(strings(disabled_providers) ?? []).map(resource => ({ action: "provider.use", resource, effect: "deny" })),
    ...(Array.isArray(native.policies) ? native.policies : []),
  ];
  const mcp = record(native.mcp), servers = Object.hasOwn(mcp, "servers") ? record(mcp.servers) : mcp;
  const { continue_loop_on_deny, ...experimental } = record(native.experimental);
  if (Object.hasOwn(native, "subagent_depth")) {
    if (experimental.subagent_depth === undefined) experimental.subagent_depth = native.subagent_depth;
    delete native.subagent_depth;
  }
  const config = Schema.decodeUnknownSync(Config.Info)(present({ ...native, permissions, policies, providers, agents,
    plugins: [...(strings(plugin) ?? []), ...(Array.isArray(native.plugins) ? native.plugins : [])].filter(spec => !isRetiredBrowserPlugin(spec)),
    mcp: present({ ...(Object.hasOwn(mcp, "servers") ? { timeout: mcp.timeout } : {}), servers: Object.fromEntries(Object.entries(servers).map(([name, value]) => [name, nativeMcpServer(value)])) }),
    skills: Array.isArray(native.skills) ? native.skills : [...(strings(record(native.skills).paths) ?? []), ...(strings(record(native.skills).urls) ?? [])],
    experimental: { ...experimental, todo: true },
  }), { onExcessProperty: "error" });
  return { config, modelFilters, agentRequests };
}
