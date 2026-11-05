import { expect, test } from "bun:test";
import { LegalWorkSandbox } from "./legalwork-sandbox.js";
import { nativePluginTestRuntime, nativeTestInvocation } from "./native-plugin-test-support.js";

test("native sandbox removes host tools, guards shell creation and preserves managed execution output and cancellation", async () => {
  const directory = "/matter/native-sandbox";
  const runtime = nativePluginTestRuntime(directory);
  const requests: Array<{ path: string; body: unknown }> = [];
  let enabled = true;
  let blockExecution = false;
  let observedAbort = false;
  const output = "sandbox-output:" + "x".repeat(300000);
  const api = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    expect(request.headers.get("authorization")).toBe("Bearer sandbox-test");
    if (path === "/workspaces") return Response.json({ items: [{ id: "matter", path: directory }] });
    if (path.includes("/sandbox/session/")) return Response.json({ enabled, networkMode: "approve", shell: "Bash", platform: "linux", cwd: "/workspace" });
    const body: unknown = await request.json();
    requests.push({ path, body });
    if (path.endsWith("/sandbox/execute")) {
      if (blockExecution) await new Promise<void>(resolve => {
        const abort = () => { observedAbort = true; resolve(); };
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) abort();
      });
      return Response.json({ output, exitCode: 0, truncated: false, sandbox: "virtual-machine", future: "preserved" });
    }
    if (path.endsWith("/sandbox/web")) return Response.json({ title: "Page", output: "page body", metadata: { url: "https://example.org" }, attachments: [{ type: "file", url: "file:///page.png", mime: "image/png" }] });
    if (path.endsWith("/sandbox/http")) return Response.json({ url: "https://example.org/final", status: 418, statusText: "Complete raw response", headers: { "x-result": "complete" }, bodyBase64: Buffer.from(output).toString("base64"), redirected: true });
    return new Response("Unexpected route", { status: 404 });
  } });
  const previous = { url: process.env.LEGALWORK_SERVER_URL, token: process.env.LEGALWORK_SERVER_TOKEN };
  process.env.LEGALWORK_SERVER_URL = api.url.origin;
  process.env.LEGALWORK_SERVER_TOKEN = "sandbox-test";
  try {
    for (const name of ["shell", "bash", "webfetch", "websearch", "codesearch", "read"]) {
      runtime.tools.set(name, { name, description: name, input: { type: "object" }, execute: async () => ({ content: "host" }) });
    }
    await runtime.start(LegalWorkSandbox);
    expect([...runtime.tools.keys()]).toEqual(["read", "legalwork_raw_http", "legalwork_webfetch", "legalwork_websearch", "legalwork_shell"]);
    await expect(runtime.hook("shell", "create.before", { command: "touch escaped", cwd: directory, timeout: 1000, shell: "sh", env: {} })).rejects.toThrow("Use legalwork_shell");
    await expect(runtime.hook("tool", "execute.before", { tool: "shell", input: {}, ...nativeTestInvocation() })).rejects.toThrow("Use legalwork_shell");
    const tool = runtime.tools.get("legalwork_shell");
    if (!tool) throw new Error("No native shell tool");
    expect(tool.description).toContain("Wiki chats require protected execution");
    await expect(tool.execute({ command: "echo proof" }, nativeTestInvocation("ses_sandbox"))).rejects.toThrow("description");
    expect(requests).toHaveLength(0);
    const result = await tool.execute({ command: "echo proof", description: "Run proof", timeout: 5000, skills: ["research"] }, nativeTestInvocation("ses_sandbox"));
    expect(result.content).toBe(output);
    expect(result.output).toMatchObject({ output, exitCode: 0, truncated: false, future: "preserved" });
    expect(result.metadata).toMatchObject({ title: "Run proof", exit: 0, truncated: false, sandbox: "virtual-machine" });
    expect(requests[0]).toMatchObject({ path: "/workspace/matter/sandbox/execute", body: { command: "echo proof", timeoutMs: 5000, skills: ["research"], write: false, sessionID: "ses_sandbox", agent: "legalwork" } });
    // Exact resource permissions remain owned by the sandbox service, avoiding a second wildcard prompt.
    expect(runtime.permissions).toEqual([]);
    const web = runtime.tools.get("legalwork_webfetch");
    if (!web) throw new Error("No native fetch tool");
    const page = await web.execute({ url: "https://example.org" }, nativeTestInvocation("ses_sandbox"));
    expect(page.content).toEqual([{ type: "text", text: "page body" }, { type: "file", mime: "image/png", uri: "file:///page.png" }]);
    expect(page.output).toMatchObject({ output: "page body", attachments: [{ url: "file:///page.png" }] });
    const raw = runtime.tools.get("legalwork_raw_http");
    if (!raw) throw new Error("No native raw HTTP adapter");
    const http = await raw.execute({ url: "https://example.org", method: "POST", headers: { authorization: "request-secret" }, bodyBase64: "AAH/" }, nativeTestInvocation("ses_sandbox"));
    expect(http.content).toEqual([]);
    expect(http.output).toMatchObject({ url: "https://example.org/final", status: 418, bodyBase64: Buffer.from(output).toString("base64"), redirected: true });
    expect(http.metadata).toEqual({ method: "POST", url: "https://example.org" });
    expect(requests.at(-1)).toMatchObject({ path: "/workspace/matter/sandbox/http", body: { sessionID: "ses_sandbox", agent: "legalwork", headers: { authorization: "request-secret" }, bodyBase64: "AAH/" } });
    const first = { system: [] };
    await runtime.hook("session", "context", first);
    await runtime.hook("session", "prompt", { sessionID: "ses_sandbox", prompt: { text: "Run a command" } });
    enabled = false;
    const second = { system: [] };
    await runtime.hook("session", "context", second);
    await runtime.hook("session", "prompt", { sessionID: "ses_sandbox", prompt: { text: "Run another command" } });
    expect(first.system).toEqual(second.system);
    expect(runtime.prompts[0]?.text).toContain("Sandboxing is on");
    expect(runtime.prompts[1]?.text).toContain("Sandboxing is off");
    expect(runtime.prompts[1]?.text).toContain("Wiki chats cannot run commands while sandboxing is off");
    expect(JSON.stringify(first.system)).toContain("Wiki chats require protected execution");
    expect(JSON.stringify(first.system)).not.toContain("Sandboxing is on");
    blockExecution = true;
    const controller = new AbortController();
    const cancelled = tool.execute({ command: "long running", description: "Wait" }, nativeTestInvocation("ses_sandbox", controller.signal));
    while (requests.length < 4) await Bun.sleep(1);
    controller.abort(new Error("Tool stopped"));
    await expect(cancelled).rejects.toThrow();
    for (let attempt = 0; attempt < 100 && !observedAbort; attempt++) await Bun.sleep(5);
    expect(observedAbort).toBe(true);
  } finally {
    await runtime.close();
    api.stop(true);
    if (previous.url === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previous.url;
    if (previous.token === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = previous.token;
  }
});
