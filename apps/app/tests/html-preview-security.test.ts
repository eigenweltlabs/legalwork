import { describe, expect, it } from "bun:test";
import { createPreviewPdfBridge, sourcePdfPath } from "../src/react-app/domains/session/artifacts/html-preview-security";

describe("HTML preview PDF access", () => {
  it("only accepts relative PDF paths", () => {
    expect(sourcePdfPath("documents/Contract.PDF")).toBe("documents/Contract.PDF");
    expect(sourcePdfPath("documents\\Contract.pdf")).toBe("documents/Contract.pdf");
    for (const path of ["../secret.pdf", "dir/../secret.pdf", "/secret.pdf", "C:\\secret.pdf", "file:///secret.pdf", "https://example.com/a.pdf", "a.pdf\0", "secret.json", "x.pdf?x=1", "//server/share/a.pdf", 1, null]) expect(sourcePdfPath(path)).toBeNull();
  });

  it("ignores sibling frames and does not download before the user grants access", async () => {
    const replies: unknown[] = [];
    const frame = { postMessage: (message: unknown) => { replies.push(message); } };
    const reads: string[] = [];
    let grant: (allowed: boolean) => void = () => {};
    let prompts = 0;
    const bridge = createPreviewPdfBridge({ getFrame: () => frame, requestAccess: () => { prompts++; return new Promise((resolve) => { grant = resolve; }); }, readPdf: async (path) => { reads.push(path); return { data: new ArrayBuffer(4) }; } });
    const data = { type: "legalwork:pdf-request", path: "source.pdf", id: "one" };
    await bridge.onMessage({ source: {}, data });
    expect(prompts).toBe(0);
    const waiting = bridge.onMessage({ source: frame, data });
    expect(prompts).toBe(1);
    expect(reads).toEqual([]);
    grant(true);
    await waiting;
    expect(reads).toEqual(["source.pdf"]);
    expect(replies).toEqual([{ type: "legalwork:pdf-response", id: "one", path: "source.pdf", ok: true, contentType: "application/pdf", data: new ArrayBuffer(4) }]);
    await bridge.onMessage({ source: frame, data });
    expect(prompts).toBe(1);
  });

  it("declined or invalid requests never reach the workspace client", async () => {
    const replies: unknown[] = [];
    const frame = { postMessage: (message: unknown) => { replies.push(message); } };
    const bridge = createPreviewPdfBridge({ getFrame: () => frame, requestAccess: async () => false, readPdf: async () => { throw new Error("Unexpected file read"); } });
    for (const path of ["source.pdf", "secret.json", "../outside.pdf"]) await bridge.onMessage({ source: frame, data: { type: "legalwork:pdf-request", path } });
    expect(replies).toHaveLength(3);
    for (const reply of replies) expect(reply).toMatchObject({ ok: false });
  });

  it("revokes pending access when a preview is closed or replaced", async () => {
    let grant: (allowed: boolean) => void = () => {};
    let reads = 0;
    let replies = 0;
    const frame = { postMessage: () => { replies++; } };
    const bridge = createPreviewPdfBridge({ getFrame: () => frame, requestAccess: () => new Promise((resolve) => { grant = resolve; }), readPdf: async () => { reads++; return { data: new ArrayBuffer(0) }; } });
    const waiting = bridge.onMessage({ source: frame, data: { type: "legalwork:pdf-request", path: "source.pdf" } });
    bridge.dispose();
    grant(true);
    await waiting;
    expect(reads).toBe(0);
    expect(replies).toBe(0);
  });

  it("never sends an in-flight file to a replacement frame", async () => {
    let replyCount = 0;
    const frame = { postMessage: () => { replyCount++; } };
    let currentFrame = frame;
    const bridge = createPreviewPdfBridge({ getFrame: () => currentFrame, requestAccess: async () => true, readPdf: async () => { currentFrame = { postMessage: () => { replyCount++; } }; return { data: new ArrayBuffer(4) }; } });
    await bridge.onMessage({ source: frame, data: { type: "legalwork:pdf-request", path: "source.pdf" } });
    expect(replyCount).toBe(0);
  });
});
