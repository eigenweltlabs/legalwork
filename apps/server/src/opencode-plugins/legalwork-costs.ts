import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { gatewayWireTokens, recordGatewayCostRequest, type GatewayCostRequest } from "../gateway-cost-store.js";

const settingsSchema = z.object({ sharedConfiguration: z.object({ providers: z.object({
  eigenwelt: z.object({ settings: z.object({ baseURL: z.string() }) }).optional(),
}) }) });
const responseMetadata = z.object({ id: z.string().min(1).max(200).optional(), usage: z.unknown().optional() });
const MAX_FRAME = 64 * 1024;

/** Observe IDs and usage only. Every byte of model output passes unchanged. */
export default Plugin.define({ id: "legalwork.costs", async setup(ctx) {
  const { directory, settingsPath } = ctx.options;
  if (typeof directory !== "string" || typeof settingsPath !== "string") return;
  const admitted = new WeakMap<Request, Omit<GatewayCostRequest, "requestId">>();
  await ctx.session.hook("http.request", async event => {
    if (event.model.providerID !== "eigenwelt") return;
    try {
      const settings = settingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
      const base = settings.sharedConfiguration.providers.eigenwelt?.settings.baseURL;
      if (!base) return;
      const expected = new URL(base), actual = new URL(event.request.url);
      if (actual.origin !== expected.origin || !actual.pathname.startsWith(expected.pathname.replace(/\/$/, "") + "/") ||
        !/\/(?:chat\/completions|responses)\/?$/.test(actual.pathname)) return;
      admitted.set(event.request, { sessionId: event.sessionID, modelId: event.model.id,
        kind: event.kind, createdAt: Date.now() });
    } catch { /* Cost observation never prevents model work. */ }
  });
  await ctx.session.hook("http.response", async event => {
    const base = admitted.get(event.request);
    const parsedId = z.string().uuid().safeParse(event.response.headers.get("x-litellm-call-id"));
    if (!base) return;
    const record: GatewayCostRequest = { ...base, requestId: parsedId.success ? parsedId.data : randomUUID() };
    const save = () => recordGatewayCostRequest(directory, record).catch(() => {});
    await save();
    if (!event.response.body) return;
    const sse = /text\/event-stream/i.test(event.response.headers.get("content-type") ?? "");
    const decoder = new TextDecoder();
    let buffered = "", dropping = false;
    const observe = async (text: string) => {
      let value: unknown;
      try { value = JSON.parse(text); } catch { return; }
      const metadata = responseMetadata.safeParse(value);
      if (!metadata.success) return;
      if (metadata.data.id && !record.responseId) { record.responseId = metadata.data.id; await save(); }
      const gatewayCost = z.object({ cost: z.number().finite().nonnegative() }).safeParse(metadata.data.usage);
      if (gatewayCost.success) record.costEur = gatewayCost.data.cost;
      const tokens = gatewayWireTokens(metadata.data.usage);
      if (tokens) record.tokens = tokens;
    };
    // Native providers may stop reading after finish_reason, before the
    // gateway's final usage-only SSE frame. Drain a tee independently; never
    // delay or replace the model response, and stop with the request signal.
    const observer = event.response.clone().body;
    if (!observer) return;
    const reader = observer.getReader();
    const cancel = () => { void reader.cancel().catch(() => {}); };
    event.request.signal.addEventListener("abort", cancel, { once: true });
    void (async () => {
      try {
        while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          buffered += decoder.decode(chunk, { stream: true });
          if (sse) {
            let end: number;
            while ((end = buffered.indexOf("\n")) >= 0) {
              const line = buffered.slice(0, end).trimEnd(); buffered = buffered.slice(end + 1);
              if (!dropping && line.length <= MAX_FRAME && line.startsWith("data:")) await observe(line.slice(5).trim());
              dropping = false;
            }
          }
          if (buffered.length > MAX_FRAME) { buffered = ""; dropping = true; }
        }
        buffered += decoder.decode();
        if (!dropping && buffered.length <= MAX_FRAME) await observe(sse ? buffered.replace(/^data:\s*/, "") : buffered);
        record.completedAt = Date.now(); await save();
      } catch { /* Observation must never change response delivery. */ }
      finally { event.request.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
    })();
  });
} });
