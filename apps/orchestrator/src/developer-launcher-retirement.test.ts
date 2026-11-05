import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function command(dataDirectory: string, arguments_: string[]) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "cli.ts"), ...arguments_, "--data-dir", dataDirectory, "--json"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, LEGALWORK_OPENCODE_BIN: join(dataDirectory, "must-never-be-started") },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("retired developer commands preserve original configuration and do not start an engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-retired-launcher-"));
  const registry = join(root, "legalwork-orchestrator-state.json"), privateConfig = join(root, "opencode-config", "opencode.jsonc");
  await mkdir(join(root, "opencode-config"));
  const originalRegistry = '{"version":1,"workspaces":[{"id":"original-matter"}],"activeId":"original-matter"}\n';
  const originalConfig = '// original user configuration\n{"plugins":["original-plugin"]}\n';
  await writeFile(registry, originalRegistry); await writeFile(privateConfig, originalConfig);
  try {
    for (const arguments_ of [["daemon"], ["daemon", "start"], ["daemon", "run"], ["daemon", "foreground"],
      ["workspace", "add", root], ["workspace", "add-remote", "https://synthetic.invalid"], ["workspace", "list"],
      ["workspaces", "switch", "original-matter"], ["workspace", "info", "original-matter"], ["workspace", "path", "original-matter"], ["instance", "dispose", "original-matter"]]) {
      const result = await command(root, arguments_);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toContain("extra developer engine launcher is retired");
      expect(result.stdout).toContain("legalwork serve --workspace");
      expect(result.stdout).not.toContain("must-never-be-started");
    }
    expect(await readFile(registry, "utf8")).toBe(originalRegistry);
    expect(await readFile(privateConfig, "utf8")).toBe(originalConfig);
    const help = await command(root, ["--help"]);
    for (const supported of ["legalwork start", "legalwork serve", "legalwork files", "legalwork approvals", "legalwork status", "daemon [stop|status]"]) expect(help.stdout).toContain(supported);
    for (const retired of ["legalwork workspace", "legalwork instance", "--daemon-host", "--daemon-port"]) expect(help.stdout).not.toContain(retired);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy status and stop require the exact live loopback identity and preserve its registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-legacy-stop-"));
  const registry = join(root, "legalwork-orchestrator-state.json");
  let shutdowns = 0, healthRequests = 0, matching = true, redirect = false;
  const startedAt = Date.now();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
    if (new URL(request.url).pathname === "/health") {
      healthRequests++;
      if (redirect) return Response.redirect(`http://127.0.0.1:${server.port}/unexpected`, 302);
      return Response.json({ ok: true, daemon: { pid: process.pid, port: server.port, baseUrl: `http://127.0.0.1:${server.port}`, startedAt: matching ? startedAt : startedAt + 1 }, privateToken: "must-never-return-this-token" });
    }
    if (new URL(request.url).pathname === "/shutdown" && request.method === "POST") { shutdowns++; return Response.json({ ok: true }); }
    return new Response("unexpected", { status: 500 });
  } });
  const saved = { version: 1, daemon: { pid: process.pid, port: server.port, baseUrl: `http://127.0.0.1:${server.port}`, startedAt }, workspaces: [{ id: "preserved" }], privateToken: "must-never-return-this-token" };
  const original = JSON.stringify(saved);
  await writeFile(registry, original);
  try {
    const status = await command(root, ["daemon", "status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, retired: true, running: true, stopped: false, daemon: saved.daemon });
    expect(status.stdout).not.toContain("must-never-return-this-token"); expect(shutdowns).toBe(0);
    matching = false;
    const mismatch = await command(root, ["daemon", "stop"]);
    expect(mismatch.code).toBe(1); expect(mismatch.stdout).toContain("does not match"); expect(shutdowns).toBe(0);
    matching = true; redirect = true;
    expect((await command(root, ["daemon", "stop"])).code).toBe(1); expect(shutdowns).toBe(0);
    redirect = false;
    await writeFile(registry, JSON.stringify({ ...saved, daemon: { ...saved.daemon, baseUrl: "https://synthetic.invalid" } }));
    const requestsBefore = healthRequests;
    expect((await command(root, ["daemon", "stop"])).code).toBe(1); expect(healthRequests).toBe(requestsBefore); expect(shutdowns).toBe(0);
    await writeFile(registry, original);
    const stopped = await command(root, ["daemon", "stop"]);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ ok: true, retired: true, running: false, stopped: true });
    expect(shutdowns).toBe(1); expect(() => process.kill(process.pid, 0)).not.toThrow();
    expect(await readFile(registry, "utf8")).toBe(original);
  } finally { await server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("missing legacy registry reports stopped and malformed registry is preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-legacy-missing-"));
  const registry = join(root, "legalwork-orchestrator-state.json");
  try {
    const missing = await command(root, ["daemon", "status"]);
    expect(missing.code).toBe(0); expect(JSON.parse(missing.stdout)).toMatchObject({ retired: true, running: false });
    await writeFile(registry, "{broken-original");
    const corrupt = await command(root, ["daemon", "stop"]);
    expect(corrupt.code).toBe(1); expect(corrupt.stdout).toContain("registry could not be read");
    expect(await readFile(registry, "utf8")).toBe("{broken-original");
  } finally { await rm(root, { recursive: true, force: true }); }
});
