import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessageInfo } from "@opencode/client";
import { listHistoryImages, readHistoryImage, type HistoryImageSource } from "./session-history-images.js";
import type { WorkspaceInfo } from "./types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const uri = `data:image/png;base64,${data}`;
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-history-images-"))); roots.push(root);
  const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: root, preset: "starter", workspaceType: "local" };
  const sessions = new Map<string, Awaited<ReturnType<HistoryImageSource["session"]>>>();
  sessions.set("child", { id: "child", projectID: "same-project", location: { directory: root }, parentID: "parent" });
  sessions.set("parent", { id: "parent", projectID: "same-project", location: { directory: root } });
  sessions.set("sibling", { id: "sibling", projectID: "same-project", location: { directory: root }, parentID: "parent" });
  const messages: SessionMessageInfo[] = [
    { id: "msg_user", type: "user", text: "Inline source", files: [{ data, mime: "image/png", source: { type: "inline" }, name: "original.png" }], time: { created: 1 } },
    { id: "msg_tool", type: "assistant", agent: "legalwork", model: { providerID: "fixture", id: "fixture" }, time: { created: 2, completed: 3 }, content: [
      { type: "text", text: "Untrusted source" },
      { type: "tool", id: "duplicate-call-id", name: "browser.screenshot", time: { created: 2, completed: 3 }, state: { status: "completed", input: {}, content: [
        { type: "text", text: "Capture" }, { type: "file", uri, mime: "image/png", name: "capture.png" },
        { type: "file", uri: "https://not-contacted.invalid/original.png", mime: "image/png" },
        { type: "file", uri: "data:text/plain;base64,SGk=", mime: "text/plain" },
        { type: "file", uri: "data:image/png;base64,malformed!", mime: "image/png" },
      ] } },
    ] },
  ];
  let duringRead: (() => void) | undefined;
  const cursors: Array<string | undefined> = [];
  const source: HistoryImageSource = {
    session: async id => { const session = sessions.get(id); if (!session) throw new Error("Unexpected session"); return session; },
    message: async (_sessionID, messageID) => { duringRead?.(); const message = messages.find(item => item.id === messageID); if (!message) throw new Error("Unexpected message"); return message; },
    messages: async (_sessionID, cursor) => { cursors.push(cursor); return { data: cursor === "empty-page" ? [] : messages, cursor: { next: cursor === "last-page" ? null : "opaque-next", previous: "opaque-previous" } }; },
  };
  return { root, workspace, sessions, messages, source, cursors, duringRead: (callback: () => void) => { duringRead = callback; } };
}

test("metadata pages and exact user/tool selectors preserve stored bytes without exposing base64", async () => {
  const f = await fixture();
  const page = await listHistoryImages(f.source, f.workspace, "child", "child", undefined, signal());
  expect(page.images).toHaveLength(2);
  expect(page.parent).toEqual({ status: "available", sessionID: "parent" });
  expect(page.cursor).toEqual({ next: "opaque-next", previous: "opaque-previous" });
  expect(JSON.stringify(page)).not.toContain(data);
  expect(page.images.map(image => image.reference.selector)).toEqual([
    { kind: "user-file", fileIndex: 0 }, { kind: "tool-content", toolIndex: 1, contentIndex: 1 },
  ]);
  for (const image of page.images) {
    const stored = await readHistoryImage(f.source, f.workspace, "child", image.reference, signal());
    expect(stored.uri).toBe(uri);
    expect(stored.image.bytes).toBe(68);
    expect(stored.image.reference.sha256).toBe(createHash("sha256").update(Buffer.from(data, "base64")).digest("hex"));
    expect(stored.image.provenance).toBe("stored-session-image");
  }
  const empty = await listHistoryImages(f.source, f.workspace, "child", "child", "empty-page", signal());
  expect(empty.images).toEqual([]); expect(empty.cursor.next).toBe("opaque-next");
  await listHistoryImages(f.source, f.workspace, "child", "child", "last-page", signal());
  expect(f.cursors).toEqual([undefined, "empty-page", "last-page"]);
  const ancestor = await listHistoryImages(f.source, f.workspace, "child", "parent", undefined, signal());
  expect(ancestor.sessionID).toBe("parent"); expect(ancestor.parent.status).toBe("none");
});

test("same-directory siblings, native project changes, worker metadata and cyclic lineage deny", async () => {
  const f = await fixture();
  await expect(listHistoryImages(f.source, f.workspace, "child", "sibling", undefined, signal())).rejects.toMatchObject({ code: "history_image_unavailable" });
  const parent = f.sessions.get("parent"); if (!parent) throw new Error("Missing parent");
  f.sessions.set("parent", { ...parent, projectID: "unrelated-native-project" });
  await expect(listHistoryImages(f.source, f.workspace, "child", "parent", undefined, signal())).rejects.toMatchObject({ code: "history_image_unavailable" });
  f.sessions.set("parent", { ...parent, metadata: { legalworkReviewWorker: true } });
  await expect(listHistoryImages(f.source, f.workspace, "child", "parent", undefined, signal())).rejects.toMatchObject({ code: "history_image_unavailable" });
  f.sessions.set("parent", { ...parent, parentID: "child" });
  await expect(listHistoryImages(f.source, f.workspace, "child", "missing", undefined, signal())).rejects.toMatchObject({ code: "history_image_unavailable" });
  expect((await listHistoryImages(f.source, f.workspace, "child", "parent", undefined, signal())).parent).toEqual({ status: "unavailable" });
  const child = f.sessions.get("child"); if (!child) throw new Error("Missing child");
  f.sessions.set("child", { ...child, parentID: "child" });
  const self = await listHistoryImages(f.source, f.workspace, "child", "child", undefined, signal());
  expect(self.images).toHaveLength(2); expect(self.parent).toEqual({ status: "unavailable" });
});

test("reparenting during read, stale hashes and forged content selectors cannot return an image", async () => {
  const f = await fixture();
  const image = (await listHistoryImages(f.source, f.workspace, "child", "parent", undefined, signal())).images[0];
  if (!image) throw new Error("No stored image");
  await expect(readHistoryImage(f.source, f.workspace, "child", { ...image.reference, sha256: "0".repeat(64) }, signal())).rejects.toMatchObject({ code: "history_image_changed" });
  await expect(readHistoryImage(f.source, f.workspace, "child", { ...image.reference, selector: { kind: "tool-content", toolIndex: 0, contentIndex: 0 } }, signal())).rejects.toMatchObject({ code: "history_image_unavailable" });
  f.duringRead(() => { const child = f.sessions.get("child"); if (child) f.sessions.set("child", { ...child, parentID: undefined }); });
  await expect(readHistoryImage(f.source, f.workspace, "child", image.reference, signal())).rejects.toMatchObject({ code: "history_image_unavailable" });
  const stopped = new AbortController(); stopped.abort();
  await expect(listHistoryImages(f.source, f.workspace, "child", "child", undefined, stopped.signal)).rejects.toBeDefined();
});

test("large stored image metadata and reads preserve the entire payload without a regexp size ceiling", async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 3, 0x41);
  const encoded = bytes.toString("base64");
  expect(encoded.length).toBeGreaterThan(5 * 1024 * 1024);
  f.messages.splice(0, f.messages.length, { id: "msg_large", type: "user", text: "Stored source", files: [{ data: encoded, mime: "image/png", source: { type: "inline" } }], time: { created: 1 } });
  const page = await listHistoryImages(f.source, f.workspace, "child", "child", undefined, signal());
  expect(page.images).toHaveLength(1);
  const image = page.images[0]; if (!image) throw new Error("Large stored image missing");
  expect(image.bytes).toBe(bytes.length);
  const recovered = await readHistoryImage(f.source, f.workspace, "child", image.reference, signal());
  expect(recovered.uri).toBe(`data:image/png;base64,${encoded}`);
  expect(image.reference.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(JSON.stringify(page)).not.toContain(encoded.slice(0, 1024));
});
