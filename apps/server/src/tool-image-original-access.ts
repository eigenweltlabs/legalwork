import { isDeepStrictEqual } from "node:util";
import { ApiError } from "./errors.js";
import { assertSessionImageTarget } from "./session-image-authority.js";
import type { HistoryImageSource } from "./session-history-images.js";
import type { WorkspaceInfo } from "./types.js";
import { TOOL_IMAGE_METADATA_KEY, toolImageLinkedMetadata, type ToolImageCaptureInput, type ToolImageOriginal } from "./tool-image-original-schema.js";

function unavailable(): never { throw new ApiError(404, "tool_image_original_uncommitted", "The original image is not linked to a completed native source call."); }

export async function originalImageSourceCall(source: HistoryImageSource, workspace: WorkspaceInfo, callerID: string,
  sessionID: string, messageID: string, callID: string, signal: AbortSignal) {
  const target = await assertSessionImageTarget(source, workspace, callerID, sessionID, signal);
  const message = await source.message(sessionID, messageID, signal);
  if (message.id !== messageID || message.type !== "assistant") unavailable();
  const tool = message.content.find(part => part.type === "tool" && part.id === callID);
  if (!tool || tool.type !== "tool") unavailable();
  await assertSessionImageTarget(source, workspace, callerID, sessionID, signal);
  return { ...target, tool };
}

export async function originalImageCaptureSource(source: HistoryImageSource, workspace: WorkspaceInfo, callerID: string, input: ToolImageCaptureInput, signal: AbortSignal) {
  const current = await originalImageSourceCall(source, workspace, callerID, callerID, input.messageID, input.callID, signal);
  if (current.tool.state.status !== "running" && current.tool.state.status !== "completed") unavailable();
  const linkage: ToolImageOriginal["source"]["linkage"] = current.tool.name === input.tool ? "direct-native-call" : "observed-child-of-native-call";
  if (linkage === "observed-child-of-native-call" && current.tool.name !== "execute") unavailable();
  return { ...current, linkage };
}

/** An observation is not a unique native child call. The exact UUID must also
 * exist on the actual committed outer call, never just on another same-name tool. */
export async function assertOriginalImageCommitted(source: HistoryImageSource, workspace: WorkspaceInfo, callerID: string, image: ToolImageOriginal, signal: AbortSignal) {
  const current = await originalImageSourceCall(source, workspace, callerID, image.reference.sessionID, image.source.messageID, image.source.outerCallID, signal);
  if (current.tool.state.status !== "completed") unavailable();
  const linked = toolImageLinkedMetadata.safeParse(current.tool.state.metadata?.[TOOL_IMAGE_METADATA_KEY]);
  if (!linked.success || !linked.data.originals.some(value => isDeepStrictEqual(value, image))) unavailable();
  if (image.source.linkage === "direct-native-call") {
    if (current.tool.name !== image.source.tool) unavailable();
  } else {
    if (current.tool.name !== "execute") unavailable();
    // The trusted successful after-hook observation is bound above by its exact
    // UUID and full provenance on this completed outer invocation. CodeMode's
    // child rows contain display paths (browser.screenshot), not necessarily
    // the observed registry keys (browser_screenshot), and no child call IDs.
    // Those rows cannot establish or invalidate this qualified observation.
  }
  await assertSessionImageTarget(source, workspace, callerID, image.reference.sessionID, signal);
  signal.throwIfAborted();
  return current;
}
