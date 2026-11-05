import { expect, test } from "bun:test";
import { webcrypto } from "node:crypto";
import { contentDigestInput, digestContent } from "../content-digest.js";
import LegalWorkDigestTools from "./legalwork-digest-tools.js";
import { nativePluginTools } from "./native-plugin-test-support.js";

test("native digest matches published SHA-256 vectors, including the empty document", () => {
  expect(digestContent(contentDigestInput.parse({ data: "" }))).toEqual({
    algorithm: "sha256", encoding: "utf8", bytes: 0,
    hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
  expect(digestContent(contentDigestInput.parse({ data: "abc" })).hex)
    .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(digestContent(contentDigestInput.parse({ data: "a".repeat(1_000_000) })).hex)
    .toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("UTF-8 preserves Unicode, newlines and normalization differences rather than claiming source equivalence", async () => {
  for (const data of ["Grüße 🦉\r\nΩ", "é", "e\u0301", "\ud800"]) {
    const bytes = new TextEncoder().encode(data);
    const expected = Buffer.from(await webcrypto.subtle.digest("SHA-256", bytes)).toString("hex");
    const actual = digestContent(contentDigestInput.parse({ data }));
    expect(actual.bytes).toBe(bytes.length);
    expect(actual.hex).toBe(expected);
  }
  expect(digestContent(contentDigestInput.parse({ data: "é" })).hex)
    .not.toBe(digestContent(contentDigestInput.parse({ data: "e\u0301" })).hex);
});

test("binary bytes and all advertised algorithms match WebCrypto without echoing source content", async () => {
  const bytes = Uint8Array.from({ length: 256 * 5000 }, (_, index) => index % 256);
  for (const [algorithm, webAlgorithm] of [["sha256", "SHA-256"], ["sha384", "SHA-384"], ["sha512", "SHA-512"]]) {
    const input = contentDigestInput.parse({ data: Buffer.from(bytes).toString("base64"), encoding: "base64", algorithm });
    const actual = digestContent(input);
    expect(actual.hex).toBe(Buffer.from(await webcrypto.subtle.digest(webAlgorithm, bytes)).toString("hex"));
    expect(actual.bytes).toBe(bytes.length);
    expect(Object.keys(actual).sort()).toEqual(["algorithm", "bytes", "encoding", "hex"]);
  }
});

test("ambiguous or malformed binary encoding fails instead of silently hashing different bytes", () => {
  for (const data of ["YQ", "YQ==\n", "Y Q==", "AB==", "!!!!", "data:text/plain;base64,YQ=="]) {
    expect(() => digestContent(contentDigestInput.parse({ data, encoding: "base64" }))).toThrow("canonical base64");
  }
  expect(() => contentDigestInput.parse({ data: "abc", path: "/private/file" })).toThrow();
  expect(() => contentDigestInput.parse({ data: "abc", algorithm: "not-a-hash" })).toThrow();
});

test("actual plugin returns precise structured receipts for complete multi-megabyte input under native permissions", async () => {
  const env = await nativePluginTools(LegalWorkDigestTools, { sessionID: "ses_digest", directory: "/matter" });
  try {
    const data = "original-source-🦉\r\n" + "x".repeat(6 * 1024 * 1024) + "decisive-tail-Ω";
    const expected = Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(data))).toString("hex");
    const result = await env.tool.legalwork_content_digest.executeResult({ data });
    expect(result.output).toEqual({ algorithm: "sha256", encoding: "utf8", bytes: Buffer.byteLength(data), hex: expected });
    expect(result.content).toBe(JSON.stringify(result.output));
    expect(env.runtime.permissions).toMatchObject([{ sessionID: "ses_digest", action: "legalwork_content_digest", resources: ["*"], save: ["*"] }]);
    expect(JSON.stringify(result)).not.toContain("original-source");
    expect(env.tool.legalwork_content_digest.input).toMatchObject({ required: ["data"] });
  } finally { await env.close(); }
});

test("general computation guidance stays fixed across changing chat state", async () => {
  const env = await nativePluginTools(LegalWorkDigestTools);
  try {
    const first = { sessionID: "ses_first", agent: "legalwork", system: [] };
    const second = { sessionID: "ses_second", agent: "legalwork", system: [] };
    await env.runtime.hook("session", "context", first);
    env.runtime.move("/different-matter");
    await env.runtime.hook("session", "context", second);
    expect(first.system).toEqual(second.system);
    expect(JSON.stringify(first.system)).toContain("legalwork_content_digest");
    expect(JSON.stringify(first.system)).not.toContain("different-matter");
  } finally { await env.close(); }
});
