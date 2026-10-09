import { createHash } from "node:crypto";
import type { Message, Part } from "@opencode-ai/sdk/v2";
import { AssistantReactionResultSchema } from "@legalwork/types/main-assistant";
import { ChannelLiveEvent } from "./channel-runtime.js";
import type { z } from "zod";

/** App-state reminders are model history, never part of a public tool result. */
export function channelToolOutput(output: string): unknown {
  const start = output.indexOf('\n\n<system-reminder topic="');
  if (start < 0) return JSON.parse(output);
  if (!/^(?:\n\n<system-reminder topic="[^"\r\n]+">\n[\s\S]*?\n<\/system-reminder>)+\s*$/.test(output.slice(start))) throw new Error("Invalid tool result suffix");
  return JSON.parse(output.slice(0, start));
}

/** Only closed public prose and the explicit reaction tool cross this boundary. */
export function channelLiveEvents(messages: { info: Message; parts: Part[] }[], messageId: string): z.infer<typeof ChannelLiveEvent>[] {
  const events: z.infer<typeof ChannelLiveEvent>[] = [];
  for (const message of messages) {
    if (message.info.role !== "assistant" || message.info.parentID !== messageId || message.info.summary) continue;
    for (const part of message.parts) {
      const key = createHash("sha256").update(JSON.stringify([message.info.id, part.id])).digest("hex");
      if (part.type === "text" && !part.synthetic && !part.ignored && part.text.trim() &&
        (part.time?.end !== undefined || (message.info.time.completed && !message.info.error))) {
        const event = ChannelLiveEvent.safeParse({ key, event: { type: "message.created", text: part.text.trim() } });
        if (event.success) events.push(event.data);
      }
      if (part.type !== "tool" || part.tool !== "legalwork_assistant_react" || part.state.status !== "completed") continue;
      try {
        const output = AssistantReactionResultSchema.parse(channelToolOutput(part.state.output));
        if (output.reaction.messageId === messageId) events.push({ key, event: { type: "reaction.changed", ...output.reaction } });
      } catch { /* Arbitrary tool outputs and invalid references remain private. */ }
    }
  }
  return events;
}
