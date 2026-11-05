import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessageInfo } from "@opencode/client";
import type { HistoryImageSource } from "./session-history-images.js";
import type { WorkspaceInfo } from "./types.js";
import { originalImageCaptureSource, assertOriginalImageCommitted } from "./tool-image-original-access.js";
import { TOOL_IMAGE_METADATA_KEY, type ToolImageOriginal } from "./tool-image-original-schema.js";
import { originalImageExportPath } from "./tool-image-original-path.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-original-access-"))); roots.push(root);
  const other = join(root, "moved"); await mkdir(other);
  const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: root, preset: "starter", workspaceType: "local" };
  const sessions = new Map<string, Awaited<ReturnType<HistoryImageSource["session"]>>>([
    ["child", { id: "child", projectID: "p", location: { directory: root }, parentID: "parent" }],
    ["parent", { id: "parent", projectID: "p", location: { directory: root } }],
    ["sibling", { id: "sibling", projectID: "p", location: { directory: root } }],
  ]);
  const image: ToolImageOriginal = { reference: { id: "55b84174-fb93-46e4-bb00-1597d4e5aa73", sessionID: "child", sha256: "a".repeat(64) }, bytes: 12, mime: "image/png", header: { status: "unavailable" },
    source: { messageID: "msg", outerCallID: "outer", tool: "office.preview", contentIndex: 0, captureOrdinal: 1, linkage: "observed-child-of-native-call", storageNamespace: "unverified",
      capturedDirectory: root, capturedProjectID: "p", capturedWorkspaceID: "matter", capturedAt: 0 }, provenance: "pre-normalization-tool-original" };
  const message: Extract<SessionMessageInfo, {type: "assistant"}> = { id: "msg", type: "assistant", agent: "legalwork", model: { providerID: "fixture", id: "fixture" }, time: { created: 1 }, content: [{ type: "tool", name: "execute", id: "outer", time: { created: 1 }, state: { status: "completed", input: {}, content: [{type:"text",text:"Completed"}], metadata: { [TOOL_IMAGE_METADATA_KEY]: { status: "retained-pending-native-commit", originals: [image] }, toolCalls: [{ tool: "office.preview", status: "completed" }] } } }] };
  let duringRead = () => {};
  const source: HistoryImageSource = { session: async id => { const value = sessions.get(id); if (!value) throw new Error("Unknown session"); return value; }, message: async () => { duringRead(); return message; }, messages: async () => ({ data: [message], cursor: { next: null, previous: null } }) };
  return { root, other, workspace, sessions, image, message, source, signal: new AbortController().signal, duringRead: (callback: () => void) => { duringRead = callback; } };
}

test("originals require the exact persisted UUID/provenance AND a completed actual outer/native call", async () => {
  const f = await fixture(); expect((await assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).tool.name).toBe("execute");
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", { ...f.image, source: { ...f.image.source, captureOrdinal: 2 } }, f.signal)).rejects.toMatchObject({ status: 404 });
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", { ...f.image, reference: { ...f.image.reference, id: "110f5506-d2ec-43fe-9087-374e68f9f609" } }, f.signal)).rejects.toMatchObject({ status: 404 });
  const part = f.message.content[0]; if (part?.type !== "tool") throw new Error("Missing actual call");
  part.state = { status: "running", input: {}, metadata: {} };
  expect((await originalImageCaptureSource(f.source, f.workspace, "child", { messageID: "msg", callID: "outer", tool: "office.preview", contentIndex: 0, mime: "image/png" }, f.signal)).linkage).toBe("observed-child-of-native-call");
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
  part.state = { status: "error", input: {}, error: { type: "Stopped", message: "Stopped" } };
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
});

test("duplicate same-name children need distinct UUID observations and names alone never establish linkage", async () => {
  const f = await fixture(), second = { ...f.image, reference: { ...f.image.reference, id: "110f5506-d2ec-43fe-9087-374e68f9f609" }, source: { ...f.image.source, captureOrdinal: 2 } };
  const part = f.message.content[0]; if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Missing call");
  part.state.metadata = { [TOOL_IMAGE_METADATA_KEY]: { status: "retained-pending-native-commit", originals: [f.image, second] }, toolCalls: [{ tool: "office.preview", status: "completed" }, { tool: "office.preview", status: "completed" }] };
  await assertOriginalImageCommitted(f.source, f.workspace, "child", second, f.signal);
  part.state.metadata = { toolCalls: [{ tool: "office.preview", status: "completed" }] };
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
  part.name = "foreign-tool";
  await expect(originalImageCaptureSource(f.source, f.workspace, "child", { messageID: "msg", callID: "outer", tool: "office.preview", contentIndex: 0, mime: "image/png" }, f.signal)).rejects.toMatchObject({ status: 404 });
});

test("native inventory names and CodeMode display paths do not invalidate an exact committed observation", async () => {
  const f = await fixture();
  f.image.source.tool = "browser_screenshot";
  const part = f.message.content[0]; if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Missing call");
  // Actual native browser hooks use the inventory key; CodeMode's public
  // progress metadata uses the namespace-qualified path. A later caught child
  // error must not invalidate the successful image observation either.
  part.state.metadata = { [TOOL_IMAGE_METADATA_KEY]: { status: "retained-pending-native-commit", originals: [f.image] },
    toolCalls: [{ tool: "browser.screenshot", status: "completed" }, { tool: "unrelated.failure", status: "error" }] };
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).resolves.toMatchObject({ tool: { id: "outer", name: "execute" } });
  // No underscore/dot rewriting: the immutable hook provenance stays exact.
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", { ...f.image, source: { ...f.image.source, tool: "browser.screenshot" } }, f.signal)).rejects.toMatchObject({ status: 404 });
});

test("display-name collisions and unrelated children cannot replace the exact UUID and source invocation", async () => {
  const f = await fixture();
  f.image.source.tool = "browser_screenshot";
  const part = f.message.content[0]; if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Missing call");
  part.state.metadata = { [TOOL_IMAGE_METADATA_KEY]: { status: "retained-pending-native-commit", originals: [f.image] },
    toolCalls: [{ tool: "browser.screenshot", status: "completed" }, { tool: "browser_screenshot", status: "completed" }] };
  for (const image of [
    { ...f.image, reference: { ...f.image.reference, id: "110f5506-d2ec-43fe-9087-374e68f9f609" } },
    { ...f.image, reference: { ...f.image.reference, sessionID: "sibling" } },
    { ...f.image, source: { ...f.image.source, messageID: "another-message" } },
    { ...f.image, source: { ...f.image.source, outerCallID: "another-call" } },
  ]) await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", image, f.signal)).rejects.toMatchObject({ status: 404 });
  // Even an exact UUID copied into another native message/call is not its source.
  const originalID = part.id; part.id = "another-call";
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
  part.id = originalID; f.message.id = "another-message";
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
  f.message.id = "msg";
  part.state.metadata = { toolCalls: [{ tool: "browser.screenshot", status: "completed" }] };
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
  part.state.metadata = { [TOOL_IMAGE_METADATA_KEY]: { status: "retained-pending-native-commit", originals: [{ ...f.image, source: { ...f.image.source, tool: "unrelated.child" } }] },
    toolCalls: [{ tool: "browser.screenshot", status: "completed" }] };
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
});

test("authorized own-chat moves retain provenance while old-project ancestry and late moves deny", async () => {
  const f = await fixture();
  f.sessions.set("child", { id: "child", projectID: "new-project", location: { directory: f.other }, parentID: "parent" });
  const moved = { ...f.workspace, path: f.other };
  await assertOriginalImageCommitted(f.source, moved, "child", f.image, f.signal);
  expect(f.image.source.capturedDirectory).toBe(f.root); expect(f.image.source.capturedProjectID).toBe("p");
  await expect(assertOriginalImageCommitted(f.source, moved, "child", { ...f.image, reference: { ...f.image.reference, sessionID: "parent" } }, f.signal)).rejects.toMatchObject({ status: 404 });
  f.sessions.set("child", { id: "child", projectID: "p", location: { directory: f.root }, parentID: "parent" });
  f.duringRead(() => f.sessions.set("child", { id: "child", projectID: "new-project", location: { directory: f.other } }));
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
});

test("review-worker metadata, sibling targets and forged source IDs deny even with matching file hashes", async () => {
  const f = await fixture();
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", { ...f.image, reference: { ...f.image.reference, sessionID: "sibling" } }, f.signal)).rejects.toMatchObject({ status: 404 });
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", { ...f.image, source: { ...f.image.source, messageID: "forged" } }, f.signal)).rejects.toMatchObject({ status: 404 });
  f.sessions.set("child", { id: "child", projectID: "p", location: { directory: f.root }, metadata: { legalworkReviewWorker: true } });
  await expect(assertOriginalImageCommitted(f.source, f.workspace, "child", f.image, f.signal)).rejects.toMatchObject({ status: 404 });
});

test("exact exports admit ordinary top-level names and reject cross-platform path escapes", () => {
  expect(originalImageExportPath("/matter", "original.png")).toBe("/matter/original.png");
  expect(originalImageExportPath("/matter", "evidence/original.png")).toBe("/matter/evidence/original.png");
  for (const path of ["../escape.png", "/tmp/escape", "C:\\escape.png", "a/../b", "\\\\host\\share\\file", "x:stream", "CON.png", "a.", "a/", "a\0b"]) expect(() => originalImageExportPath("/matter", path)).toThrow();
});
