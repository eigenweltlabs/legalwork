import type { Plugin } from "@opencode/plugin";
import type { AgentEditor } from "@opencode/plugin/promise/agent";
import type { Config } from "@opencode/schema/config";
import type { Permission } from "@opencode/schema/permission";
import { Agent } from "@opencode/schema/agent";
import { Schema } from "effect";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentDefinitionsSchema } from "../native-agent-schema.js";
import { resolveWorkspaceId, serverUrl, workspaceToolHeaders } from "./office-plugin-shared.js";
import { nativeEvents } from "./native-events.js";

/** The pinned native ConfigAgent fold, after source selection. Other native
 * agent providers remain installed; authored config and Markdown keep order. */
export function foldNativeAgents(editor: AgentEditor, documents: readonly Config.Info[]) {
  const expand = (rules: Permission.Ruleset) => rules.map(rule => {
    if (!["read", "edit", "external_directory"].includes(rule.action)) return rule;
    const resource = rule.resource === "~" || rule.resource === "$HOME" ? homedir()
      : rule.resource.startsWith("~/") ? join(homedir(), rule.resource.slice(2))
      : rule.resource.startsWith("$HOME/") || rule.resource.startsWith("$HOME\\") ? join(homedir(), rule.resource.slice(6)) : rule.resource;
    return { ...rule, resource };
  });
  const permissions = expand(documents.flatMap(document => document.permissions ?? []));
  const configuredDefault = [...documents].reverse().find(document => document.default_agent !== undefined)?.default_agent;
  if (configuredDefault !== undefined) editor.default(Agent.ID.make(configuredDefault));
  for (const current of editor.list()) editor.update(current.id, agent => { agent.permissions.push(...permissions); });
  for (const document of documents) for (const [id, item] of Object.entries(document.agents ?? {})) {
    if (item.disabled) { editor.remove(id); continue; }
    const exists = editor.get(id) !== undefined;
    editor.update(id, agent => {
      if (!exists) agent.permissions.push(...permissions);
      if (item.model !== undefined) agent.model = { id: item.model.model, providerID: item.model.providerID,
        ...(item.model.variant === undefined ? {} : { variant: item.model.variant }) };
      if (item.request !== undefined) { Object.assign(agent.request.headers, item.request.headers ?? {}); Object.assign(agent.request.body, item.request.body ?? {}); }
      if (item.system !== undefined) agent.system = item.system;
      if (item.description !== undefined) agent.description = item.description;
      if (item.mode !== undefined) agent.mode = item.mode;
      if (item.hidden !== undefined) agent.hidden = item.hidden;
      if (item.color !== undefined) agent.color = item.color;
      if (item.steps !== undefined) agent.steps = item.steps;
      if (item.permissions !== undefined) agent.permissions.push(...expand(item.permissions));
    });
  }
}

export async function registerNativeAgents(ctx: Plugin.Context) {
  const controller = new AbortController(), watchers = new Map<string, FSWatcher>();
  const context = { directory: ctx.location.directory };
  const read = async () => {
    const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
    const url = new URL(serverUrl() + "/workspace/" + encodeURIComponent(workspace) + "/agents/definitions");
    url.searchParams.set("directory", context.directory);
    const response = await fetch(url, { headers: await workspaceToolHeaders(context), signal: controller.signal });
    if (!response.ok) throw new Error("Agent definitions unavailable (" + response.status + ")");
    return Schema.decodeUnknownSync(agentDefinitionsSchema)(await response.json());
  };
  let definitions = await read(), timer: ReturnType<typeof setTimeout> | undefined;
  let queued = Promise.resolve();
  const refresh = () => {
    queued = queued.then(async () => {
      if (controller.signal.aborted) return;
      definitions = await read(); syncWatchers(); await ctx.agent.reload();
    }).catch(error => { if (!controller.signal.aborted) console.warn("[legalwork.agents] refresh failed", error instanceof Error ? error.message : "Unknown error"); });
    return queued;
  };
  function syncWatchers() {
    for (const [root, watcher] of watchers) if (!definitions.watchRoots.includes(root)) { watcher.close(); watchers.delete(root); }
    for (const root of definitions.watchRoots) if (!watchers.has(root)) {
      try {
        const watcher = watch(root, { recursive: true }, (_event, name) => {
          if (!name || !/^(agent|agents|mode|modes)([/\\]|$)/.test(name.toString())) return;
          clearTimeout(timer); timer = setTimeout(() => { void refresh(); }, 100);
        });
        watcher.on("error", () => { watcher.close(); watchers.delete(root); });
        watchers.set(root, watcher);
      } catch { /* Missing native discovery roots stay optional. */ }
    }
  }
  const registration = await ctx.agent.transform(editor => foldNativeAgents(editor, definitions.documents));
  syncWatchers();
  const stop = nativeEvents(ctx, async event => { if (event.type === "config.updated") await refresh(); });
  return async () => {
    controller.abort(); clearTimeout(timer); stop();
    for (const watcher of watchers.values()) watcher.close();
    await queued; await registration.dispose();
  };
}
