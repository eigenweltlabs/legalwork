import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("postal mail requires opt-in, a human review, stable PDF bytes, and a host-only final action", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-epost-test-"));
  const script = join(root, "check.mjs");
  try {
    await writeFile(script, `
      import { writeFile } from "node:fs/promises";
      import { join } from "node:path";
      import assert from "node:assert/strict";
      import { PDFDocument, PageSizes } from ${JSON.stringify(import.meta.resolve("pdf-lib"))};
      const { startServer } = await import(${JSON.stringify(new URL("../server.ts", import.meta.url).href)});
      const { writeEigenweltConnection } = await import(${JSON.stringify(new URL("../eigenwelt-connection-store.ts", import.meta.url).href)});
      const { connectorRuntimeCapability } = await import(${JSON.stringify(new URL("../connectors/capability.ts", import.meta.url).href)});
      const root = process.env.XDG_CONFIG_HOME;
      const config = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", configPath: join(root, "server.json"),
        approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
        workspaces: [{ id: "project", path: root, name: "Fixture", preset: "starter", workspaceType: "local" }],
        authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
      const nativeFetch = globalThis.fetch;
      let reviewedPdf;
      let submitted = 0;
      globalThis.fetch = Object.assign(async (input, init) => {
        if (new URL(String(input)).hostname !== "post.test") return nativeFetch(input, init);
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fixture-platform-token");
        if (!init.body) return Response.json({ available: true, mode: "sandbox" });
        const data = JSON.parse(init.body);
        if (data.action === "review") {
          reviewedPdf = data.letter.pdf;
          assert.equal((await PDFDocument.load(Buffer.from(reviewedPdf, "base64"))).getPageCount(), 2);
          return Response.json({ mode: "sandbox", amountCents: 88, sheets: 3, pages: 2, expires: Date.now() + 60000, proof: "a".repeat(64) });
        }
        assert.equal(data.action, "submit");
        assert.equal(data.letter.pdf, reviewedPdf);
        assert.equal(data.proof, "a".repeat(64));
        submitted++;
        return Response.json({ state: "accepted", letterId: 42, mode: "sandbox", amountCents: 88 });
      }, nativeFetch);
      const server = await startServer(config);
      try {
        await writeEigenweltConnection(config, { platformURL: "https://post.test", platformToken: "fixture-platform-token",
          account: { userId: "user", userName: "Fixture", userEmail: null, orgId: "firm", orgName: "Fixture" } });
        const call = (path, input, headers = {}, method = input ? "POST" : "GET") => nativeFetch("http://127.0.0.1:" + server.port + path, {
          method, headers: { Authorization: "Bearer client", "Content-Type": "application/json", ...headers },
          body: input ? JSON.stringify(input) : undefined,
        });
        const host = { "X-LegalWork-Host-Token": "host" }, agent = { "X-LegalWork-Connector-Token": connectorRuntimeCapability(config) };
        const path = "/workspace/project/epost";
        const addr = { name: "Fixture", street: "Street 1", postalCode: "10117", city: "Berlin" };
        const draft = { id: crypto.randomUUID(), workspaceId: "project", files: ["a.pdf", "b.pdf"], sender: addr, recipient: addr, registered: "none", color: false, duplex: false };
        const document = await PDFDocument.create();
        document.addPage(PageSizes.A4);
        await writeFile(join(root, "a.pdf"), await document.save());
        await writeFile(join(root, "b.pdf"), await document.save());
        assert.equal((await call(path, { action: "review", draft }, host)).status, 403);
        assert.equal((await call("/epost/settings", { enabled: true }, agent, "PUT")).status, 401);
        assert.equal((await (await call("/epost/settings", { enabled: true }, host, "PUT")).json()).enabled, true);
        assert.equal((await (await call("/epost/agent", null, agent)).json()).enabled, true);
        assert.equal((await call(path, { action: "submit", reviewId: crypto.randomUUID() }, host)).status, 409);
        assert.equal((await call(path, { action: "review", draft: { ...draft, files: ["../other.pdf"] } }, host)).status, 400);
        const first = await call(path, { action: "review", draft }, host);
        assert.equal(first.status, 200);
        const { reviewId, proof } = await first.json();
        assert.equal(proof, undefined);
        assert.equal((await call(path, { action: "submit", reviewId }, agent)).status, 401);
        assert.equal(submitted, 0);
        document.getPage(0).drawText("changed");
        await writeFile(join(root, "b.pdf"), await document.save());
        assert.equal((await call(path, { action: "submit", reviewId }, host)).status, 409);
        const reviewed = await (await call(path, { action: "review", draft }, host)).json();
        const sends = await Promise.all([0, 1].map(() => call(path, { action: "submit", reviewId: reviewed.reviewId }, host)));
        assert.deepEqual(sends.map(res => res.status).sort(), [200, 409]);
        assert.equal(submitted, 1);
        assert.equal((await (await sends.find(res => res.ok).json())).letterId, 42);
      } finally { await server.stop(); }
    `);
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, EIGENWELT_PLATFORM_URL: "https://post.test", XDG_CONFIG_HOME: root,
        LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite"), LEGALWORK_TOKEN_STORE: join(root, "tokens.json") },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, failure: exit === 0 ? "" : stderr + stdout }).toEqual({ exit: 0, failure: "" });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 20_000);
