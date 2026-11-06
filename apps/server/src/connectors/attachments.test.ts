import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadMailAttachment } from "./attachments.js";
import type { MailAttachment } from "./mail.js";

let root: string;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "mail-download-"))); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function gmailResponse(json: string, chunkSize = 1) {
  const content = Buffer.from(json);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === content.length) { controller.close(); return; }
    const end = Math.min(offset + chunkSize, content.length);
    controller.enqueue(content.subarray(offset, end)); offset = end;
  } }));
}
function attachment(response: Response, expectedSize: number | null = null): MailAttachment {
  return { filename: "fixture.bin", mimeType: "application/octet-stream", expectedSize, response, encoding: "base64url-json" };
}

test("Gmail decodes padded and unpadded attachment data across every JSON and base64 boundary", async () => {
  const input = Buffer.from([255, 254, 0, 128, 250, 251, 252]);
  for (let size = 0; size <= input.length; size++) {
    const bytes = input.subarray(0, size);
    for (const encoding of ["base64", "base64url"] satisfies BufferEncoding[]) {
      const encoded = bytes.toString(encoding).replace(/\+/g, "-").replace(/\//g, "_");
      const result = await downloadMailAttachment(root, "gmail", async () => attachment(gmailResponse(`{\n  "data": "${encoded}"\n}\n`), size));
      expect(result.size).toBe(size);
      expect(Buffer.compare(await readFile(result.path), bytes)).toBe(0);
    }
  }
});

test("Gmail rejects malformed and truncated attachment data and removes partial files", async () => {
  for (const json of ["", "{}", '{"data":null}', '{"data":"YWJj', '{"data":"YWJj"', '{"data":"YWJj"} trailing', '{"data":"YWJj$"}', '{"data":"A"}', '{"data":"AB"}', '{"data":"YQ="}', '{"data":"YWJj","extra":true}', '{"data":"YWJj' + "A".repeat(5000) + '$"}']) {
    await expect(downloadMailAttachment(root, "gmail", async () => attachment(gmailResponse(json, 17)))).rejects.toMatchObject({ code: "connector_api_invalid" });
    expect(await readdir(join(root, ".legalwork", "attachments", "email"))).toEqual([]);
  }
});

test("Gmail verifies the downloaded byte count against attachment metadata", async () => {
  await expect(downloadMailAttachment(root, "gmail", async () => attachment(gmailResponse('{"data":"YWJj"}'), 10))).rejects.toMatchObject({ code: "connector_attachment_incomplete" });
  expect(await readdir(join(root, ".legalwork", "attachments", "email"))).toEqual([]);
});

test("attachment filenames remain portable and preserve extensions when shortened", async () => {
  for (const [filename, expected] of [["CON.pdf", "_CON.pdf"], ["..", "attachment"], ["report?.pdf. ", "report_.pdf"], ["😀".repeat(120) + ".pdf", "😀".repeat(59) + ".pdf"]]) {
    const result = await downloadMailAttachment(root, "outlook", async () => ({ ...attachment(new Response("content")), encoding: "binary", filename }));
    expect(result.filename).toBe(expected);
    expect(await readFile(result.path, "utf8")).toBe("content");
  }
});
