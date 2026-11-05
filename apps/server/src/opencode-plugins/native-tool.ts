import type { Plugin } from "@opencode/plugin";
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenCodeContext } from "./office-plugin-shared.js";

type NativeInvocation = Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id"> & {
  readonly signal?: AbortSignal;
};
const execution = new AsyncLocalStorage<OpenCodeContext>();

export function nativeToolAbortSignal(): AbortSignal | undefined {
  return execution.getStore()?.abort;
}

/** Service envelopes keep additional fields, including future provider metadata. */
export function nativeResponseOutput(referenceData: z.ZodType) {
  return z.object({ ok: z.boolean(), referenceData: referenceData.optional(),
    instruction: z.string().optional(), error: z.json().optional() }).passthrough();
}

export function nativeObjectOutput(success: z.ZodType) {
  return z.union([success, z.object({ ok: z.literal(false), error: z.json(), code: z.string().optional() }).passthrough()]);
}

/** Preserve each domain's existing timeout while cancelling work when its native tool stops. */
export function nativeToolSignal(timeoutMs: number, context = execution.getStore()): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return context?.abort ? AbortSignal.any([context.abort, timeout]) : timeout;
}

/** A plugin's setup location can differ from the session invoking its tools. */
export async function nativeToolContext(ctx: Plugin.Context, call: NativeInvocation): Promise<OpenCodeContext> {
  call.signal?.throwIfAborted();
  const session = await ctx.session.get({ sessionID: call.sessionID }, { signal: call.signal });
  call.signal?.throwIfAborted();
  return {
    sessionID: call.sessionID,
    agent: call.agent,
    messageID: call.messageID,
    directory: session.location.directory,
    abort: call.signal,
    ask: async ({ permission, patterns, always, metadata }) => {
      await ctx.permission.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        source: { type: "tool", messageID: call.messageID, id: call.id },
        action: permission,
        resources: patterns,
        save: always,
        metadata,
      });
      call.signal?.throwIfAborted();
    },
  };
}

/** Native V2 tool registration with the same permission identity as its public name. */
export function nativeTool<Input extends z.ZodType>(ctx: Plugin.Context, definition: {
  name: string;
  description: string;
  schema: Input;
  /** Advertise authoritative result fields without replacing the original content. */
  outputSchema?: z.ZodType;
  /** Empty for actions whose approval must never be saved. */
  save?: string[];
  /** The executor asserts exact resource permissions itself instead of a second wildcard approval. */
  permission?: "domain";
  /** Preserve a domain's actionable diagnostics before the authoritative schema parser runs. */
  prevalidate?: (raw: unknown) => void;
  execute: (input: z.output<Input>, context: OpenCodeContext) => Promise<string | Result>;
}): Info {
  return {
    name: definition.name,
    description: definition.description,
    input: z.toJSONSchema(definition.schema, { io: "input" }),
    output: z.toJSONSchema(definition.outputSchema ?? z.json(), { io: "input" }),
    options: { permission: definition.name },
    async execute(raw, call) {
      definition.prevalidate?.(raw);
      const input = definition.schema.parse(raw);
      const context = await nativeToolContext(ctx, call);
      if (definition.permission !== "domain") {
        await ctx.permission.assert({
          sessionID: call.sessionID,
          agent: call.agent,
          source: { type: "tool", messageID: call.messageID, id: call.id },
          action: definition.name,
          resources: ["*"],
          save: definition.save ?? ["*"],
        });
      }
      call.signal.throwIfAborted();
      let permissionFailed = false;
      let permissionError: unknown;
      const ask = context.ask;
      if (ask) context.ask = async (input) => {
        try { await ask(input); }
        catch (error) { permissionFailed = true; permissionError = error; throw error; }
      };
      const result = await execution.run(context, () => definition.execute(input, context));
      call.signal.throwIfAborted();
      // A domain's error formatting must not turn a native denial into successful content.
      if (permissionFailed) throw permissionError;
      const native = typeof result === "string" ? { content: result } : result;
      if (native.output !== undefined) return native;
      const text = typeof native.content === "string" ? native.content
        : (native.content ?? []).flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      let output: unknown = text || null;
      if (text) { try { output = JSON.parse(text); } catch { /* Plain text is a truthful structured string. */ } }
      return { ...native, output };
    },
  };
}
