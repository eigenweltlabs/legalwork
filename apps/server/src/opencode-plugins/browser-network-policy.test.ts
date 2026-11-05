import { expect, test } from "bun:test";
import { LegalWorkSandbox } from "./legalwork-sandbox.js";
import { LegalWorkExtensionsPreview } from "./legalwork-extensions-preview.js";
import { requireBrowserNetwork } from "./browser-network-policy.js";
import { nativePluginTestRuntime, nativePluginTools, nativeToolBefore } from "./native-plugin-test-support.js";

test("browser tools use fresh effective chat policy, including native tools and generic UI actions", async () => {
  let settings: unknown = { enabled: true, networkMode: "allow" };
  let status = 200;
  const paths: string[] = [];
  const api = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    expect(request.headers.get("authorization")).toBe("Bearer fixture");
    if (path === "/workspaces") return Response.json({ items: [{ id: "project", path: "/project" }] });
    if (path === "/workspace/project/sandbox/session/calling-chat") return Response.json(settings, { status });
    return new Response("Unexpected route", { status: 404 });
  } });
  const previous = { url: process.env.LEGALWORK_SERVER_URL, token: process.env.LEGALWORK_SERVER_TOKEN };
  process.env.LEGALWORK_SERVER_URL = api.url.origin;
  process.env.LEGALWORK_SERVER_TOKEN = "fixture";
  const runtime = nativePluginTestRuntime("/project");
  let closeExtensions: (() => Promise<void>) | undefined;
  try {
    await runtime.start(LegalWorkSandbox);
    const before = (tool: string, args: Record<string, unknown> = {}, sessionID = "calling-chat") => nativeToolBefore(runtime, tool, args, sessionID);
    const tools = ["browser.tabs.open", "browser.evaluate", "browser.files.upload", "browser.network.get", "browser_navigate", "browser_eval", "browser_snapshot", "browser_click", "browser_fill", "browser_screenshot",
      "legalwork_browser_open_url", "legalwork_browser_batch", "legalwork_browser_downloads", "legalwork_browser_set_proxy", "legalwork_browser_clear_proxy", "mcp_browser_navigate"];
    const browserUi = ["browser.open_url", "browser.set_proxy"];
    for (const enabled of [true, false]) {
      for (const networkMode of ["allow", "approve", "block"]) {
        settings = { enabled, networkMode, source: "organization" };
        for (const tool of [...tools, ...browserUi]) {
          const call = before(browserUi.includes(tool) ? "legalwork_ui_execute_action" : tool, { actionId: tool, sessionId: "forged-allowed-chat", workspaceId: "other-project", directory: "/other-project" });
          if (enabled && networkMode !== "allow") await expect(call).rejects.toThrow("Browser tools are disabled");
          else await call;
        }
      }
    }
    expect(new Set(paths)).toEqual(new Set(["/workspaces", "/workspace/project/sandbox/session/calling-chat"]));
    const count = paths.length;
    await before("read");
    await before("legalwork_ui_execute_action", { actionId: "documents.open" });
    await before("legalwork_webfetch");
    expect(paths).toHaveLength(count);
    await expect(requireBrowserNetwork({directory: "/project"})).rejects.toThrow("calling session");
    status = 503;
    await expect(before("browser_eval")).rejects.toThrow("could not be verified");
    status = 200;
    settings = {};
    await expect(requireBrowserNetwork({ directory: "/project", sessionID: "calling-chat" })).rejects.toThrow();
    settings = { enabled: true, networkMode: "approve" };
    const extensions = await nativePluginTools(LegalWorkExtensionsPreview, { directory: "/project" });
    closeExtensions = extensions.close;
    const context = { directory: "/project", sessionID: "calling-chat" };
    await expect(extensions.tool.legalwork_browser_open_url.execute({ url: "https://example.org" }, context)).rejects.toThrow("disabled");
    await expect(extensions.tool.legalwork_browser_set_proxy.execute({ proxy: "http://example.org:8080" }, context)).rejects.toThrow("disabled");
    await expect(extensions.tool.legalwork_browser_clear_proxy.execute({}, context)).rejects.toThrow("disabled");
    await expect(extensions.tool.legalwork_ui_execute_action.execute({ actionId: "browser.open_url", args: { url: "https://example.org", sessionId: "other-chat" } }, context)).rejects.toThrow("disabled");
  } finally {
    await runtime.close();
    await closeExtensions?.();
    if (previous.url === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = previous.url;
    if (previous.token === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = previous.token;
    api.stop(true);
  }
});
