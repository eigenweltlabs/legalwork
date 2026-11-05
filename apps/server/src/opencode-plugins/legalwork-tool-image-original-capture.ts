import { Plugin } from "@opencode/plugin/effect";
import type { ToolHooks } from "@opencode/plugin/effect/tool";
import { Cause, Effect, Stream } from "effect";
import { z } from "zod";
import { isInternalSession, isReviewWorkerSession } from "../native-shared-values.js";
import { REVIEW_AGENT } from "../reviews/worker-identity.js";
import { TOOL_IMAGE_METADATA_KEY, toolImageOriginal, toolImageLinkedMetadata, type ToolImageOriginal } from "../tool-image-original-schema.js";
import { resolveWorkspaceId, serverUrl, workspaceToolHeaders, type OpenCodeContext } from "./office-plugin-shared.js";

type Completed = Extract<ToolHooks["execute.after"], { status: "completed" }>;
type Content = Exclude<NonNullable<Completed["result"]["content"]>, string>[number];
export type OriginalCaptureLedger = Map<string, { sessionID: string; originals: ToolImageOriginal[]; unavailable: number }>;
const callKey = (event: Completed) => JSON.stringify([event.sessionID, event.messageID, event.id]);
export function skipOriginalImageCapture(tool: string) {
  return tool === "execute" || tool.startsWith("legalwork_history_image_") || tool.startsWith("legalwork_tool_image_original_") || tool === "legalwork_tool_output_read";
}
function annotate(event: Completed, originals: ToolImageOriginal[], unavailable = 0) {
  const content: Content[] = typeof event.result.content === "string" ? [{ type: "text", text: event.result.content }] : [...(event.result.content ?? [])];
  const metadata = originals.length ? { ...toolImageLinkedMetadata.parse({ status: "retained-pending-native-commit", originals }), ...(unavailable ? { unavailableCount: unavailable } : {}) }
    : { status: "unavailable", unavailableCount: unavailable };
  content.push({ type: "text", text: `${originals.length ? `${originals.length} original image observation(s) retained privately, pending this native call's commit. After the call completes, use legalwork_tool_image_original_list for verified references.` : ""}${unavailable ? " Original image retention is unavailable for part or all of this result. The successful tool output is unchanged; do not assume an untouched original can be recovered." : ""}`.trim() });
  // Existing output/content entries are preserved; no post-success exception
  // may turn an already completed Office edit into a task that looks retryable.
  event.result = { ...event.result, content, metadata: { ...event.result.metadata, [TOOL_IMAGE_METADATA_KEY]: metadata } };
}
async function endpoint(context: OpenCodeContext) {
  const headers = await workspaceToolHeaders(context);
  if (!headers["x-legalwork-wiki-agent-token"]) throw new Error("Original image retention requires the actual chat's scoped runtime credential.");
  delete headers.Authorization;
  const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
  return { headers, url: `${serverUrl()}/workspace/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(context.sessionID ?? "")}/tool-image-originals` };
}

export function captureToolImageOriginals(ctx: { session: { get: (input: { sessionID: Completed["sessionID"] }) => Effect.Effect<{ id: string; agent?: string; location: { directory: string }; metadata?: Record<string, unknown> }, unknown> } }, event: ToolHooks["execute.after"], ledger: OriginalCaptureLedger) {
  if (event.status !== "completed") return Effect.sync(() => { if (event.tool === "execute") ledger.delete(JSON.stringify([event.sessionID, event.messageID, event.id])); });
  const key = callKey(event);
  if (event.tool === "execute") return Effect.sync(() => {
    const observed = ledger.get(key); ledger.delete(key);
    if (observed) annotate(event, observed.originals.sort((a, b) => a.source.captureOrdinal - b.source.captureOrdinal), observed.unavailable);
  });
  const parts = typeof event.result.content === "string" ? [] : event.result.content ?? [];
  const images = parts.flatMap((part, contentIndex) => part.type === "file" && /^image\//i.test(part.mime)
    && part.uri.startsWith(`data:${part.mime};base64,`) ? [{ ...part, contentIndex }] : []);
  if (skipOriginalImageCapture(event.tool) || images.length === 0) return Effect.void;
  const originals: ToolImageOriginal[] = [];
  return Effect.gen(function* () {
    const session = yield* ctx.session.get({ sessionID: event.sessionID });
    if (isInternalSession(session) || isReviewWorkerSession(session) || session.agent === REVIEW_AGENT) return;
    yield* Effect.promise(async signal => {
      const context: OpenCodeContext = { sessionID: event.sessionID, agent: event.agent, messageID: event.messageID, directory: session.location.directory, abort: signal };
      const api = await endpoint(context); signal.throwIfAborted();
      for (const image of images) {
        const encoded = image.uri.slice(image.uri.indexOf(",") + 1), bytes = Buffer.from(encoded, "base64");
        if (bytes.toString("base64") !== encoded) throw new Error("The source image is not canonical inline base64.");
        const form = new FormData();
        form.set("metadata", JSON.stringify({ messageID: event.messageID, callID: event.id, tool: event.tool, contentIndex: image.contentIndex, mime: image.mime,
          ...(image.name === undefined ? {} : { name: image.name }) }));
        form.set("image", new Blob([bytes]), "original.bin");
        const response = await fetch(`${api.url}/capture`, { method: "POST", headers: api.headers, body: form, signal });
        if (!response.ok) throw new Error(`Original image retention failed (${response.status}): ${await response.text()}`);
        const original = z.object({ image: toolImageOriginal }).parse(await response.json()).image;
        originals.push(original);
        if (original.source.linkage === "observed-child-of-native-call") {
          const pending = ledger.get(key) ?? { sessionID: event.sessionID, originals: [], unavailable: 0 };
          pending.originals.push(original); ledger.set(key, pending);
        }
      }
      signal.throwIfAborted(); annotate(event, originals);
    });
  }).pipe(Effect.catchCause(cause => {
    if (Cause.hasInterrupts(cause)) return Effect.interrupt;
    return Effect.sync(() => {
      const unavailable = images.length - originals.length;
      const pending = ledger.get(key) ?? { sessionID: event.sessionID, originals: [], unavailable: 0 };
      pending.unavailable += unavailable; ledger.set(key, pending);
      console.error("Original image retention unavailable", cause); annotate(event, originals, unavailable);
    });
  }));
}

export default Plugin.define({ id: "legalwork.tool-image-original-capture", effect: ctx => Effect.gen(function* () {
  const ledger: OriginalCaptureLedger = new Map();
  yield* Effect.addFinalizer(() => Effect.sync(() => ledger.clear()));
  yield* ctx.event.subscribe().pipe(Stream.runForEach(event => Effect.sync(() => {
    if (event.type !== "session.idle" && event.type !== "session.execution.interrupted" && event.type !== "session.execution.failed" && event.type !== "session.deleted") return;
    for (const [key, value] of ledger) if (value.sessionID === event.data.sessionID) ledger.delete(key);
  })), Effect.forkScoped({ startImmediately: true }));
  yield* ctx.tool.hook("execute.after", event => captureToolImageOriginals(ctx, event, ledger));
}) });
