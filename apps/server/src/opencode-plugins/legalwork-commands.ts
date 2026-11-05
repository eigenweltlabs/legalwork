import { Plugin } from "@opencode/plugin";
import type { CommandInvocation } from "@opencode/plugin/promise/command";
import { Agent } from "@opencode/schema/agent";
import { ConfigCommand } from "@opencode/schema/config/command";
import { commandDefinitionsSchema } from "../native-command-schema.js";
import { commandSettingsRpc } from "../native-command-rpc.js";
import { SessionMessage } from "@opencode/schema/session-message";
import { Tool } from "@opencode/schema/tool";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { nativeEvents } from "./native-events.js";
import { expandCommandTemplate } from "./native-command-template.js";
import { resolveWorkspaceId, serverUrl, workspaceToolHeaders } from "./office-plugin-shared.js";

const executionResult = Schema.Struct({ output: Schema.String, exitCode: Schema.Number, truncated: Schema.Boolean });
export { commandSettingsRpc };

/** Native commands with normal LegalWork permissions, cancellation and sandbox.
 * Disable the released ConfigCommand loader in the managed bootstrap. */
export const LegalWorkCommands = Plugin.define({
  id: "legalwork.commands",
  async setup(ctx) {
    const running = new Map<string, Set<{ controller: AbortController; settled: Promise<void> }>>();
    const delegatedRoles = new Map<string, { dispose(): Promise<void> }>();
    const registrations: Array<{ dispose(): Promise<void> }> = [];
    const read = async () => {
      const context = { directory: ctx.location.directory };
      const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
      const url = new URL(serverUrl() + "/workspace/" + encodeURIComponent(workspace) + "/commands/definitions");
      url.searchParams.set("directory", context.directory);
      const response = await fetch(url, { headers: await workspaceToolHeaders(context) });
      if (!response.ok) throw new Error("Command definitions unavailable (" + response.status + "): " + await response.text());
      return Schema.decodeUnknownSync(commandDefinitionsSchema)(await response.json());
    };
    let definitions = await read();
    const refresh = async () => { definitions = await read(); await ctx.agent.reload(); await ctx.command.reload(); return { refreshed: true }; };
    registrations.push(await ctx.agent.transform(editor => {
      const delegated = Object.values(definitions.commands).filter(command => (command.subagent ?? command.subtask) === true);
      const anyPrimary = delegated.some(command => !command.agent);
      const targets = new Set(delegated.flatMap(command => command.agent ? [command.agent] : []));
      for (const agent of editor.list()) {
        // V1 commands could explicitly delegate to primary agents. Keep their
        // real permission/role identity using the native dual-purpose mode.
        if (agent.mode === "primary" && (anyPrimary || targets.has(agent.id))) editor.update(agent.id, value => { value.mode = "all"; });
      }
    }));
    const cancel = async (sessionID: string) => {
      const active = [...running.get(sessionID) ?? []];
      for (const item of active) item.controller.abort(new Error("Command cancelled."));
      await Promise.all(active.map(item => item.settled));
      return { cancelled: active.length > 0 };
    };
    registrations.push(await ctx.rpc.register(commandSettingsRpc, { refresh, cancel: input => cancel(Schema.decodeUnknownSync(Schema.Struct({ sessionID: Schema.String }))(input).sessionID) }));
    const stop = nativeEvents(ctx, async event => {
      if (event.type === "session.execution.interrupted" || event.type === "session.deleted") {
        await cancel(event.data.sessionID);
      }
      if (event.type === "config.updated") await refresh();
    });
    registrations.push(await ctx.command.transform(editor => {
      for (const [name, command] of Object.entries(definitions.commands)) editor.add({
        name, description: command.description,
        async execute(input) {
          const controller = new AbortController(), signal = controller.signal;
          let complete = () => {};
          const invocation = { controller, settled: new Promise<void>(resolve => { complete = resolve; }) };
          const active = running.get(input.sessionID) ?? new Set<typeof invocation>();
          active.add(invocation); running.set(input.sessionID, active);
          try {
            const parent = await ctx.session.get({ sessionID: input.sessionID }, { signal });
            const parentAgent = parent.agent ?? (await ctx.agent.list({}, { signal })).data[0]?.id;
            if (!parentAgent) throw new Error("No agent is available for this command.");
            const agentID = Agent.ID.make(command.agent ?? parentAgent);
            const selected = Schema.decodeUnknownSync(Agent.Info)((await ctx.agent.get({ agentID }, { signal })).data);
            const model = command.model ? { providerID: command.model.providerID, id: command.model.model,
              ...(command.model.variant ? { variant: command.model.variant } : {}) } : selected.model;
            const text = await expandCommandTemplate(command.template, input.prompt.text, async source => {
              signal.throwIfAborted();
              const context = { directory: parent.location.directory, sessionID: input.sessionID };
              const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
              const response = await fetch(serverUrl() + "/workspace/" + encodeURIComponent(workspace) + "/sandbox/command", {
                method: "POST", headers: { ...await workspaceToolHeaders(context), "Content-Type": "application/json" }, signal,
                body: JSON.stringify({ command: source, description: "Expand /" + name, workdir: parent.location.directory,
                  sessionID: input.sessionID, agent: parentAgent, write: true, timeoutMs: null, capture: "complete" }),
              });
              if (!response.ok) throw new Error("Command expansion failed (" + response.status + "): " + await response.text());
              const result = Schema.decodeUnknownSync(executionResult)(await response.json());
              if (result.truncated) throw new Error("Command expansion returned incomplete output.");
              return result.output;
            });
            signal.throwIfAborted();
            if (command.subagent ?? command.subtask ?? selected.mode === "subagent") {
              await delegate(command, name, input, selected, text, model, Agent.ID.make(parentAgent), signal);
              return;
            }
            if (command.agent && parent.agent !== agentID) await ctx.session.switchAgent({ sessionID: input.sessionID, agent: agentID }, { signal });
            if (model) await ctx.session.switchModel({ sessionID: input.sessionID, model }, { signal });
            await ctx.session.prompt({ ...input.prompt, sessionID: input.sessionID, text, delivery: input.delivery }, { signal });
          } catch (error) {
            signal.throwIfAborted();
            throw error;
          } finally {
            active.delete(invocation);
            if (!active.size) running.delete(input.sessionID);
            complete();
          }
        },
      });
    }));
    async function delegate(command: ConfigCommand.Info, name: string, input: CommandInvocation, selected: Agent.Info, text: string,
      model: Agent.Info["model"], parentAgent: Agent.ID, signal: AbortSignal) {
      const agent = selected.id;
      // Native configured agents are folded after external plugin transforms.
      // Register the command's dual-purpose role at invocation time so a saved
      // primary role cannot undo it. Keep the real agent and its permissions.
      if (selected.mode === "primary") {
        await delegatedRoles.get(agent)?.dispose();
        delegatedRoles.set(agent, await ctx.agent.transform(editor => {
          if (editor.get(agent)?.mode === "primary") editor.update(agent, value => { value.mode = "all"; });
        }));
      }
      const tool = (await ctx.tool.list()).find(item => item.name === "subagent");
      if (!tool) throw new Error("The native subagent capability is unavailable for this command.");
      const child = await ctx.session.create({ parentID: input.sessionID, agent, title: command.description ?? name,
        ...(model ? { model } : {}) }, { signal });
      try {
        if (input.prompt.files?.length || input.prompt.skills?.length || input.prompt.agents?.length) {
          await ctx.session.prompt({ ...input.prompt, sessionID: child.id, text: "", resume: false }, { signal });
        }
        const source = await ctx.session.synthetic({ sessionID: input.sessionID, text: "Run /" + name + " in a subagent.",
          metadata: { legalworkCommand: name }, resume: false }, { signal });
        await tool.execute({ agent, description: command.description ?? name, prompt: "You are a subagent spawned by another session.\n" + text,
          sessionID: child.id, background: true,
          ...(model ? { model: model.providerID + "/" + model.id + (model.variant ? "#" + model.variant : "") } : {}) },
          { sessionID: input.sessionID, agent: parentAgent,
            messageID: SessionMessage.ID.make(source.id), id: Tool.CallID.make("command_" + randomUUID()), signal, progress: async () => {} });
      } catch (error) {
        await ctx.session.interrupt({ sessionID: child.id }).catch(() => {});
        await ctx.session.remove({ sessionID: child.id }).catch(() => {});
        throw error;
      }
    }
    return async () => {
      stop();
      await Promise.all([...running.keys()].map(cancel));
      for (const registration of delegatedRoles.values()) await registration.dispose();
      for (const registration of registrations.reverse()) await registration.dispose();
    };
  },
});
export default LegalWorkCommands;
