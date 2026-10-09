import { resolve } from "node:path";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { AssistantSessionQueue, type AssistantSessionTarget } from "./assistant-session-queue.js";
import { readAssistantAttention } from "./assistant-attention.js";
import { isMainAssistant, type MainAssistant } from "./main-assistant.js";
import type { WorkspaceInfo } from "./types.js";

export async function createAssistantSessionQueue(path: string, options: {
  workspace: (id: string) => Promise<WorkspaceInfo>;
  client: (workspace: WorkspaceInfo) => OpencodeClient;
  assistant: MainAssistant;
  changed: () => void;
}) {
  const requestOptions = () => ({ throwOnError: true, signal: AbortSignal.timeout(10000) });
  const read = async (target: AssistantSessionTarget) => {
    const workspace = await options.workspace(target.workspaceId);
    if (workspace.workspaceType === "remote") throw new Error("Choose an accessible local project chat.");
    const client = options.client(workspace);
    const { data: session } = await client.session.get({ sessionID: target.sessionId }, requestOptions());
    if (isMainAssistant(workspace) && !session?.title.startsWith("Call · ")) throw new Error("Choose a project or dedicated call chat.");
    if (!session || session.time.archived || resolve(session.directory) !== resolve(workspace.path)) throw new Error("The project chat is no longer available.");
    return { workspace, client, session };
  };
  return AssistantSessionQueue.open(path, {
    inspect: async target => {
      const { workspace, client, session } = await read(target);
      const { data: statuses } = await client.session.status({}, requestOptions());
      if (!statuses) throw new Error("Chat status is unavailable.");
      if (statuses[session.id] && statuses[session.id].type !== "idle") return { busy: true, pending: false, interrupted: false };
      const [attention, messages] = await Promise.all([
        readAssistantAttention(client, { ...target, projectName: workspace.name, sessionTitle: session.title }),
        client.session.messages({ sessionID: session.id, limit: 1 }, requestOptions()),
      ]);
      const last = messages.data?.at(-1)?.info;
      return { busy: false, pending: attention.some(item => item.kind !== "widget"), interrupted: last?.role === "assistant" && Boolean(last.error) };
    },
    hasMessage: async (target, id) => {
      const { client } = await read(target);
      const response = await client.session.message({ sessionID: target.sessionId, messageID: id }, { signal: AbortSignal.timeout(10000) });
      if (response.response.status === 404) return false;
      if (!response.response.ok || !response.data) throw new Error("Message delivery could not be checked.");
      return response.data.info.id === id;
    },
    send: async entry => {
      const { client } = await read(entry);
      const history = await client.session.messages({ sessionID: entry.sessionId, limit: 1 }, requestOptions());
      const last = history.data?.at(-1)?.info;
      const model = last?.role === "assistant" ? { providerID: last.providerID, modelID: last.modelID } : last?.model;
      const response = await client.session.promptAsync({ sessionID: entry.sessionId, messageID: entry.id, agent: "legalwork", model,
        parts: [{ type: "text", text: entry.prompt, metadata: { legalworkAssistantSender: options.assistant.profile() } }],
      }, { signal: AbortSignal.timeout(30000) });
      if (!response.response.ok) throw new Error("Message delivery could not be confirmed.");
      options.changed();
    },
    abort: async target => {
      const { client, session } = await read(target);
      const sessions = [session];
      // Stop real child agents too, without touching unrelated project chats.
      for (let index = 0; index < sessions.length; index++) {
        if (sessions.length > 100) throw new Error("Too many child chats to stop safely in one request.");
        const children = await client.session.children({ sessionID: sessions[index].id }, requestOptions());
        for (const child of children.data ?? []) if (child.parentID === sessions[index].id && resolve(child.directory) === resolve(session.directory) && !sessions.some(item => item.id === child.id)) sessions.push(child);
      }
      for (const item of sessions.reverse()) {
        const result = await client.session.abort({ sessionID: item.id }, { throwOnError: true, signal: AbortSignal.timeout(30000) });
        if (result.data !== true) throw new Error(`Could not confirm that chat ${item.id} stopped.`);
      }
      const statuses = await client.session.status({}, requestOptions());
      if (!statuses.data || sessions.some(item => statuses.data[item.id] && statuses.data[item.id].type !== "idle")) throw new Error("Stopping was requested but the chat is still busy. Check its status before continuing.");
      options.changed();
      return sessions.map(item => item.id);
    },
  });
}
