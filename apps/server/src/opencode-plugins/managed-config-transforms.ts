import type { ProviderEditor } from "@opencode/plugin/promise/provider";
import type { ModelEditor } from "@opencode/plugin/promise/model";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import { Agent } from "@opencode/schema/agent";
import type { NativeConfig } from "../native-opencode-config.js";
import { homedir } from "node:os";
import { join } from "node:path";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function overlay(base: Record<string, unknown> | undefined, value: Record<string, unknown>) {
  const result = { ...base };
  for (const [key, item] of Object.entries(value)) {
    const previous = result[key];
    result[key] = record(previous) && record(item) ? overlay(previous, item) : structuredClone(item);
  }
  return result;
}
function headers(base: Record<string, string> | undefined, value: Record<string, string>) {
  return Object.fromEntries([...Object.entries(base ?? {}), ...Object.entries(value)].reduce((result, entry) => {
    result.set(entry[0].toLowerCase(), entry); return result;
  }, new Map<string, [string, string]>()).values());
}

/** Only per-location differences reach these editors. Shared definitions keep
 * the released native ConfigProvider fold, reasoning and variant generation. */
export function managedProviderDifferences(editor: ProviderEditor, configuration: NativeConfig) {
  for (const [id, item] of Object.entries(configuration.providers ?? {})) {
    const current = editor.get(id), source = editor.get(item.canonical ?? current?.provider.canonical ?? id);
    const changed = item.canonical !== undefined && item.canonical !== current?.provider.canonical;
    editor.update(id, provider => {
      if (changed && source) Object.assign(provider, structuredClone(source.provider), { id: provider.id, integrationID: provider.integrationID });
      provider.activation = "enabled";
      if (item.canonical !== undefined) provider.canonical = item.canonical;
      if (item.name) provider.name = item.name;
      if (item.package !== undefined) provider.package = item.package;
      if (item.compatibility !== undefined) provider.compatibility = { ...provider.compatibility, ...item.compatibility };
      if (item.settings !== undefined) provider.settings = overlay(provider.settings, item.settings);
      if (item.headers !== undefined) provider.headers = headers(provider.headers, item.headers);
      if (item.body !== undefined) provider.body = overlay(provider.body, item.body);
    });
    for (const [modelID, model] of Object.entries(item.models ?? {})) {
      const base = source?.models.get(model.modelID ?? modelID) ?? source?.models.get(modelID);
      editor.models.update(id, modelID, value => {
        if ((changed || !current?.models.has(modelID)) && base) Object.assign(value, structuredClone(base));
        if (item.package !== undefined) value.package = undefined;
        if (model.limit !== undefined) value.limit = { ...value.limit, ...model.limit };
      });
    }
    if (item.settings?.baseURL !== undefined) for (const [modelID] of editor.get(id)?.models ?? []) editor.models.update(id, modelID, value => { delete value.settings?.baseURL; });
  }
}

export function managedModelDifferences(editor: ModelEditor, configuration: NativeConfig) {
  for (const [providerID, provider] of Object.entries(configuration.providers ?? {})) for (const [id, item] of Object.entries(provider.models ?? {})) editor.update(providerID, id, model => {
    if (item.family !== undefined) model.family = item.family;
    if (item.name) model.name = item.name;
    if (item.modelID !== undefined) model.modelID = item.modelID;
    if (item.releaseDate !== undefined) model.time = { released: Date.parse(item.releaseDate) };
    if (item.compatibility !== undefined) model.compatibility = { ...model.compatibility, ...item.compatibility };
    if (item.package !== undefined) model.package = item.package;
    if (item.settings !== undefined) model.settings = overlay(model.settings, item.settings);
    if (item.headers !== undefined) model.headers = headers(model.headers, item.headers);
    if (item.body !== undefined) model.body = overlay(model.body, item.body);
    if (item.limit !== undefined) model.limit = { ...model.limit, ...item.limit };
    if (item.capabilities !== undefined) {
      model.capabilities = { ...model.capabilities,
        ...(item.capabilities.tools === undefined ? {} : { tools: item.capabilities.tools }),
        ...(item.capabilities.input === undefined ? {} : { input: [...item.capabilities.input] }),
        ...(item.capabilities.output === undefined ? {} : { output: [...item.capabilities.output] }),
        ...(item.capabilities.temperature === undefined ? {} : { temperature: item.capabilities.temperature }),
      };
      // The normal custom-provider form writes only {supported:boolean}.
      // Pinned native Variant.supports yields [] for exactly this shape, and
      // Variant.resolve(model, []) yields no generated variants for either bool.
      const reasoning = item.capabilities.reasoning;
      if (reasoning && Object.keys(reasoning).every(key => key === "supported")) model.variants = [];
    }
    for (const variant of item.variants ?? []) {
      let existing = model.variants.find(value => value.id === variant.id);
      if (!existing) { existing = { id: variant.id }; model.variants.push(existing); }
      if (variant.settings !== undefined) existing.settings = overlay(existing.settings, variant.settings);
      if (variant.headers !== undefined) existing.headers = headers(existing.headers, variant.headers);
      if (variant.body !== undefined) existing.body = overlay(existing.body, variant.body);
    }
    if (item.cost !== undefined) model.cost = (Array.isArray(item.cost) ? item.cost : [item.cost]).map(cost => ({ ...cost, cache: { read: cost.cache?.read ?? 0, write: cost.cache?.write ?? 0 } }));
    if (item.disabled !== undefined) model.enabled = !item.disabled;
  });
}

export function managedAgents(editor: AgentEditor, configuration: NativeConfig) {
  const rules = (configuration.permissions ?? []).map(rule => {
    if (!["read", "edit", "glob", "grep", "list", "external_directory"].includes(rule.action)) return rule;
    const resource = rule.resource === "~" || rule.resource === "$HOME" ? homedir()
      : rule.resource.startsWith("~/") ? join(homedir(), rule.resource.slice(2))
      : rule.resource.startsWith("$HOME/") || rule.resource.startsWith("$HOME\\") ? join(homedir(), rule.resource.slice(6)) : rule.resource;
    return { ...rule, resource };
  });
  for (const agent of editor.list()) editor.update(agent.id, value => { value.permissions.push(...rules); });
  for (const [id, item] of Object.entries(configuration.agents ?? {})) {
    if (item.disabled) { editor.remove(id); continue; }
    const existed = editor.get(id) !== undefined;
    editor.update(id, agent => {
      if (!existed) agent.permissions.push(...rules);
      if (item.model !== undefined) agent.model = { id: item.model.model, providerID: item.model.providerID, ...(item.model.variant ? { variant: item.model.variant } : {}) };
      if (item.request !== undefined) { Object.assign(agent.request.headers, item.request.headers); Object.assign(agent.request.body, item.request.body); }
      if (item.system !== undefined) agent.system = item.system;
      if (item.description !== undefined) agent.description = item.description;
      if (item.mode !== undefined) agent.mode = item.mode;
      if (item.hidden !== undefined) agent.hidden = item.hidden;
      if (item.color !== undefined) agent.color = item.color;
      if (item.steps !== undefined) agent.steps = item.steps;
      if (item.permissions !== undefined) agent.permissions.push(...item.permissions);
    });
  }
  editor.default(Agent.ID.make(configuration.default_agent ?? "legalwork"));
}

export function managedProviderAllowed(configuration: NativeConfig, id: string) {
  let allowed = true;
  for (const policy of configuration.policies ?? []) if (policy.action === "provider.use" && matches(id, policy.resource)) allowed = policy.effect !== "deny";
  return allowed;
}
export function matches(input: string, pattern: string) {
  return new RegExp("^" + pattern.replace(/[.+^$()|{}[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s").test(input);
}
