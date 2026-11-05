import { Plugin } from "@opencode/plugin";
import { Error as ToolError, type Result } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import { nativeEvents } from "./native-events.js";
import { toolProgressGuard } from "./tool-progress-guard.js";

const savedError = z.object({ error: z.object({ message: z.string() }) });

export default Plugin.define({ id: "legalwork.tool-recovery", async setup(ctx) {
  const pending = new Map<string, { reason: string; messageID: string }>();
  const executing = new Map<string, Set<string>>();
  const recovery = toolProgressGuard(async (sessionID, reason, messageID) => { pending.set(sessionID, { reason, messageID }); });
  await ctx.session.hook("prompt", event => { recovery.reset(event.sessionID); pending.delete(event.sessionID); executing.delete(event.sessionID); });
  await ctx.session.hook("context", async event => {
    // Code Mode hides nested tools from the model-facing catalog. Read the
    // registered definitions so nested failures get the same guidance.
    for (const tool of await ctx.tool.list()) {
      const schema = z.record(z.string(), z.unknown()).safeParse(tool.input);
      await recovery.definition({ toolID: tool.id }, { description: tool.description, ...(schema.success ? { jsonSchema: schema.data } : {}) });
    }
    // Saved guidance replays unchanged. Observe its admission without rewriting
    // earlier model-facing history after progress, resets or a service restart.
    if (!recovery.guidance(event.sessionID)) return;
    for (const message of event.messages) {
      for (const part of message.content) {
        if (part.type !== "tool-result" || !recovery.guidance(event.sessionID, part.id)) continue;
        const error = savedError.safeParse(part.result.value);
        const text = typeof part.result.value === "string" ? part.result.value
          : part.result.type === "content" ? part.result.value.flatMap(value => value.type === "text" ? [value.text] : []).join("\n")
          : error.success ? error.data.error.message : "";
        recovery.delivered(event.sessionID, part.id, text);
      }
    }
  });
  await ctx.tool.hook("execute.before", event => {
    if (event.tool !== "execute") return;
    const calls = executing.get(event.sessionID) ?? new Set<string>();
    calls.add(event.id); executing.set(event.sessionID, calls);
  });
  await ctx.tool.hook("execute.after", async event => {
    const calls = executing.get(event.sessionID);
    const nested = event.tool !== "execute" && calls?.has(event.id);
    if (event.tool === "execute") {
      calls?.delete(event.id);
      if (!calls?.size) executing.delete(event.sessionID);
    }
    // A completed outer execute may contain a failed child. Its wrapper is not
    // successful progress, and child text/metadata may be discarded by Code Mode.
    if (event.tool !== "execute" || event.status !== "completed") {
      await recovery.observe({ id: event.id, sessionID: event.sessionID, messageID: event.messageID, tool: event.tool,
        input: event.input, ...(event.status === "error" ? { error: event.error.message } : {}) });
    }
    const guidance = recovery.guidance(event.sessionID, event.id);
    if (!guidance || nested) return;
    if (event.status === "error") {
      // The engine unwraps Tool.Error.error before saving its model-visible
      // message. Keep the original cause under a wrapper with the same snapshot.
      event.error = new ToolError({ message: guidance, metadata: event.error.metadata,
        error: event.error.error === undefined ? undefined : new globalThis.Error(guidance, { cause: event.error.error }) });
      return;
    }
    const content: Exclude<Result["content"], string | undefined> = typeof event.result.content === "string"
      ? [{ type: "text", text: event.result.content }] : event.result.content ?? [];
    if (content.some(part => part.type === "text" && part.text.includes(guidance))) return;
    // Freeze the snapshot on the durable outer result, ahead of output that may
    // be shortened. Preserve typed output, attachments and existing metadata.
    event.result = { ...event.result, content: [{ type: "text", text: guidance }, ...content] };
  });
  // Interrupt only after the failure is persisted, outside the tool's own
  // execution fiber. Awaiting an interrupt in execute.after deadlocks it.
  return nativeEvents(ctx, async event => {
    if (event.type === "session.tool.failed" || event.type === "session.tool.success") {
      const stop = pending.get(event.data.sessionID);
      if (!stop) return;
      pending.delete(event.data.sessionID);
      const session = await ctx.session.get({ sessionID: event.data.sessionID });
      const previous = z.record(z.string(), z.json()).safeParse(session.metadata?.legalworkToolStops);
      // Session metadata is durable without admitting another model turn. A
      // synthetic inbox item either waits until the next turn or resumes work.
      await ctx.session.update({ sessionID: event.data.sessionID, metadata: { ...session.metadata,
        legalworkToolStops: { ...(previous.success ? previous.data : {}), [stop.messageID]: { reason: "repeated-invalid-tool-calls" } },
      } });
      await ctx.session.interrupt({ sessionID: event.data.sessionID });
    }
    if (event.type === "session.idle" || event.type === "session.deleted") {
      recovery.reset(event.data.sessionID); pending.delete(event.data.sessionID); executing.delete(event.data.sessionID);
    }
  });
} });
