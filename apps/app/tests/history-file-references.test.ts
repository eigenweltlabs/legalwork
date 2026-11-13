import { expect, spyOn, test } from "bun:test";
import { resolveFilePartOpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

// Generic callers (document operations, model context) keep complete history.
// Only display callers explicitly select the smaller representation.
test("history file references are opt-in for both shared history client methods", async () => {
  const urls: URL[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
    urls.push(new URL(input instanceof Request ? input.url : input));
    return Response.json({ code: "fixture", message: "End after capturing the URL" }, { status: 400 });
  }, { preconnect: fetch.preconnect }));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const client = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:4321", token: "fixture" });
    for (const method of [client.getSessionMessages, client.getSessionSnapshot]) {
      await expect(method("ws_1", "ses_1")).rejects.toThrow();
      await expect(method("ws_1", "ses_1", { limit: 140, fileReferences: true })).rejects.toThrow();
    }
    expect(urls.map(url => url.search)).toEqual(["", "?files=references&limit=140", "", "?files=references&limit=140"]);
  } finally { spy.mockRestore(); warn.mockRestore(); }
});


test("source PDF cards open the same original file with inline bytes or a reference", () => {
  const filename = "//server/share/large.pdf";
  const before = resolveFilePartOpenTarget({ filename, url: "data:application/pdf;base64,JVBERg==", mediaType: "application/pdf" }, []);
  const after = resolveFilePartOpenTarget({ filename, url: "file://server/share/large.pdf", mediaType: "application/pdf" }, []);
  expect(after).toEqual(before);
  expect(after).toMatchObject({ kind: "file", value: filename, preview: "pdf" });
});
