import { describe, expect, test } from "bun:test";
import { OfficeToolRelay } from "./office-tools.js";

describe("Office relay cancellation", () => {
  test("removes an undelivered edit without sending it on the next pane poll", async () => {
    const relay = new OfficeToolRelay();
    await relay.poll("matter", 0, "NDA.docx", "word");
    const controller = new AbortController();
    const pending = relay.execute("matter", "word_replace_text", { anchor: "old", replacement: "new" }, undefined, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("before delivery") });
    expect(await relay.poll("matter", 0, "NDA.docx", "word")).toEqual([]);
  });

  test("reports uncertain state after delivery and rejects late results without replaying", async () => {
    const relay = new OfficeToolRelay();
    await relay.poll("matter", 0, "NDA.docx", "word");
    const controller = new AbortController();
    const pending = relay.execute("matter", "word_replace_text", { anchor: "old", replacement: "new" }, undefined, controller.signal);
    const [request] = await relay.poll("matter", 0, "NDA.docx", "word");
    expect(request).toBeDefined();
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("cannot be rolled back") });
    expect(relay.complete(request!.id, { ok: true, result: "changed" })).toBe(false);
    expect(await relay.poll("matter", 0, "NDA.docx", "word")).toEqual([]);
  });

  test("cancelling one chat's queued operation preserves another operation", async () => {
    const relay = new OfficeToolRelay();
    await relay.poll("matter", 0, "NDA.docx", "word");
    const controller = new AbortController();
    const cancelled = relay.execute("matter", "word_replace_text", { anchor: "cancelled" }, undefined, controller.signal);
    const surviving = relay.execute("matter", "word_search", { query: "liability" });
    controller.abort();
    expect((await cancelled).ok).toBe(false);
    const requests = await relay.poll("matter", 0, "NDA.docx", "word");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tool).toBe("word_search");
    expect(relay.complete(requests[0]!.id, { ok: true, result: "match" })).toBe(true);
    expect(await surviving).toEqual({ ok: true, result: "match" });
  });

  test("an already stopped call never reaches a connected poller", async () => {
    const relay = new OfficeToolRelay(), controller = new AbortController();
    await relay.poll("matter", 0, "NDA.docx", "word");
    controller.abort();
    expect(await relay.execute("matter", "word_replace_text", {}, undefined, controller.signal)).toMatchObject({ ok: false });
    expect(await relay.poll("matter", 0, "NDA.docx", "word")).toEqual([]);
  });
});
