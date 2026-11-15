import { expect, test } from "bun:test";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

test("file uploads send original binary bytes and write conditions without Base64", async () => {
  const data = new Uint8Array([0, 255, 128, 10]);
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    calls++;
    const url = new URL(request.url);
    expect(url.pathname).toBe("/workspace/project/files/raw");
    expect(url.searchParams.get("path")).toBe(".legalwork/attachments/copy/large.pdf");
    expect(url.searchParams.get("createOnly")).toBe("true");
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    expect(request.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await request.arrayBuffer())).toEqual(data);
    return Response.json({ ok: true, path: url.searchParams.get("path"), bytes: data.length, updatedAt: 1 });
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "test-token" });
    const file = new File([data], "large.pdf");
    file.arrayBuffer = async () => { throw new Error("Must not materialize the file"); };
    expect(await client.writeWorkspaceBinaryFile("project", { path: ".legalwork/attachments/copy/large.pdf", data: file, createOnly: true }))
      .toMatchObject({ ok: true, bytes: 4 });
    expect(calls).toBe(1);
  } finally { server.stop(true); }
});
