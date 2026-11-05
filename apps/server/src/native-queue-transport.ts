import { assistantSubscriptionAvailable, requireAssistantWorkspaceSubscription } from "./assistant-subscription.js";
import type { OpenCodeClient } from "@opencode/client";
import type { QueueEntry } from "./session-queue-schema.js";
import type { QueueTransport } from "./session-message-queue.js";
import { QueuePreparationError } from "./session-message-queue.js";
import { queuedPromptPayload } from "./session-queue-schema.js";
import { withSessionDispatch } from "./session-execution-gate.js";
import type { ServerConfig } from "./types.js";
import { isCompactionCommand, runIdentifiedCommand, runNativeCommand } from "./native-command-control.js";
import { nativeDeliveryRejection } from "./native-delivery.js";
import { findApiError } from "./errors.js";

export const queueMessageID = (entry: Pick<QueueEntry, "id" | "execution" | "messageId">) => entry.execution.kind === "prompt" && entry.execution.id || entry.messageId || `msg_${entry.id.replaceAll("-", "")}`;

async function delivered(client: OpenCodeClient, sessionID: string, id: string) {
  try {
    const message = await client.session.message.get({ sessionID, messageID: id });
    if (message.id !== id || message.type !== "user") throw new Error("The engine returned a different message identity.");
    return true;
  } catch (error) {
    if (findApiError(error)?.status === 404) return false;
    throw error;
  }
}

/** Native prompt retries keep the FIRST delivery mode. Promotion must use the
 * inbox mutation, and a delivery racing that mutation must reconcile history. */
async function reconcileSteer(client: OpenCodeClient, sessionID: string, entry: QueueEntry) {
  if (entry.execution.kind !== "prompt") throw new QueuePreparationError("Only ordinary messages can steer a chat.");
  const id = queueMessageID(entry);
  const pending = (await client.session.inbox.list({ sessionID })).find(item => item.id === id);
  if (!pending) return delivered(client, sessionID, id);
  if (pending.type !== "user") throw new Error("The engine returned a different inbox item type.");
  if (pending.delivery === "queue") {
    try { await client.session.inbox.update({ sessionID, inboxID: id, delivery: "steer" }); }
    catch (error) {
      if (await delivered(client, sessionID, id)) return true;
      // Another caller may have promoted it, or the response may have been lost.
      const current = (await client.session.inbox.list({ sessionID })).find(item => item.id === id);
      if (current?.type !== "user" || current.delivery !== "steer") throw error;
    }
  }
  // Resume an admitted item after an engine/server restart without new hooks,
  // payload changes or a new identity. prompt's default resume also covers the
  // idle-boundary race; inbox.update itself wakes execution after promotion.
  if (!(await client.session.active())[sessionID]) {
    const admitted = await client.session.prompt({ sessionID, ...queuedPromptPayload(entry.execution), id, delivery: "steer" });
    if (admitted.id !== id) throw new Error("The engine did not confirm the steered message identity.");
  }
  return true;
}

/** Editable entries remain in LegalWork until ready; accepted prompts belong to
 * the native durable inbox. Admission acknowledges acceptance, not completion. */
export function nativeQueueTransport(config: ServerConfig, input: {
  client: (workspaceId: string, sessionID: string) => Promise<OpenCodeClient>;
  prepare: (workspaceId: string, sessionID: string, client: OpenCodeClient, entry: QueueEntry) => Promise<void>;
}): QueueTransport {
  return {
    async confirmed(workspaceId, sessionID, entry) {
      if (entry.delivery === "steer") return withSessionDispatch(config, sessionID, async () => {
        await requireAssistantWorkspaceSubscription(config, workspaceId);
        return reconcileSteer(await input.client(workspaceId, sessionID), sessionID, entry);
      });
      const compaction = entry.execution.kind === "command" && isCompactionCommand(entry.execution.command);
      if (entry.execution.kind !== "prompt" && !compaction && !entry.messageId) return false;
      const client = await input.client(workspaceId, sessionID);
      const id = queueMessageID(entry);
      const type = compaction ? "compaction" : "user";
      const pending = (await client.session.inbox.list({ sessionID })).find(item => item.id === id && item.type === type);
      if (pending) {
        // Admission reconciliation is idempotent. Wake work accepted before a
        // server crash without re-running prompt hooks or creating a new turn.
        if (!(await client.session.active())[sessionID]) {
          await requireAssistantWorkspaceSubscription(config, workspaceId);
          if (compaction) {
            const admitted = await client.session.compact({ sessionID, id, delivery: "queue" });
            if (admitted.id !== id) throw new Error("The engine did not confirm the queued compaction identity.");
          } else if (entry.execution.kind === "prompt") await client.session.prompt({ sessionID, id, ...queuedPromptPayload(entry.execution), delivery: "queue" });
          else if (pending.type === "user") await client.session.prompt({ sessionID, id, text: pending.payload.text, delivery: "queue" });
        }
        return true;
      }
      // The queue may already have promoted the item to durable history. A
      // missing/erroring read remains uncertain; the staging queue handles it.
      const message = await client.session.message.get({ sessionID, messageID: id });
      return message.id === id && message.type === type;
    },
    async idle(workspaceId, sessionID) {
      if (config.readOnly) return false;
      if (config.workspaces.some(item => item.id === workspaceId && item.preset === "main-assistant") && !await assistantSubscriptionAvailable(config)) return false;
      const client = await input.client(workspaceId, sessionID);
      const [active, pending] = await Promise.all([client.session.active(), client.session.inbox.list({ sessionID })]);
      return !active[sessionID] && pending.length === 0;
    },
    async settled(workspaceId, sessionID) {
      const client = await input.client(workspaceId, sessionID);
      const [active, pending, session] = await Promise.all([client.session.active(), client.session.inbox.list({ sessionID }), client.session.get({ sessionID })]);
      if (active[sessionID] || pending.length) return;
      return { pause: session.outcome === "failed" || session.outcome === "interrupted", reason: session.outcome === "interrupted" ? "stop" : "error" };
    },
    send: (workspaceId, sessionID, entry) => withSessionDispatch(config, sessionID, async () => {
      let client: OpenCodeClient;
      if (entry.delivery === "steer") {
        await requireAssistantWorkspaceSubscription(config, workspaceId);
        client = await input.client(workspaceId, sessionID);
        if (await reconcileSteer(client, sessionID, entry)) return { accepted: true };
      }
      try {
        await requireAssistantWorkspaceSubscription(config, workspaceId);
        client = await input.client(workspaceId, sessionID);
        await input.prepare(workspaceId, sessionID, client, entry);
        const execution = entry.execution;
        // Model/agent selection belongs to the session in v2. Stage entries
        // until idle so one entry cannot change an earlier entry's execution.
        if (entry.delivery !== "steer" && execution.kind !== "shell") {
          if (execution.agent) await client.session.switchAgent({ sessionID, agent: execution.agent });
          if (execution.model) await client.session.switchModel({ sessionID, model: execution.model });
          else if (execution.kind === "command" && execution.unresolvedModel) {
            const session = await client.session.get({ sessionID });
            const [id, variant] = execution.unresolvedModel.split("#");
            const models = (await client.model.list({ location: session.location })).data.filter(model => model.id === id || model.modelID === id);
            if (models.length !== 1) throw new Error("The saved command model is ambiguous or unavailable. Select a model when editing this queue entry.");
            await client.session.switchModel({ sessionID, model: { providerID: models[0]!.providerID, id: models[0]!.id, ...(variant ? { variant } : {}) } });
          }
        }
        await client.session.update({ sessionID, archived: false });
      } catch (error) {
        throw new QueuePreparationError(error instanceof Error ? error.message : "Could not prepare message delivery.");
      }
      const execution = entry.execution;
      if (execution.kind === "prompt") {
        const id = queueMessageID(entry);
        const admitted = await client.session.prompt({ sessionID, ...queuedPromptPayload(execution), id, delivery: entry.delivery ?? "queue" })
          .catch(error => { throw nativeDeliveryRejection(error) ?? error; });
        if (admitted.id !== id) throw new Error("The engine did not confirm the queued message identity.");
        if (entry.delivery === "steer" && admitted.delivery === "queue" && !await reconcileSteer(client, sessionID, entry)) {
          throw new Error("The engine has not confirmed message steering. Checking delivery automatically.");
        }
      } else if (execution.kind === "command") {
        await (entry.messageId ? runIdentifiedCommand : runNativeCommand)(client, { sessionID, name: execution.command, text: execution.args,
          files: execution.files, agents: execution.agents, skills: execution.skills, delivery: "queue" }, queueMessageID(entry));
      } else {
        await client.session.shell({ sessionID, command: execution.command });
      }
      if (execution.kind !== "shell") return { accepted: true };
      // A future engine failure is an execution outcome. Never claim admission
      // failed or offer to resend a prompt just because its answer failed.
    }),
  };
}
