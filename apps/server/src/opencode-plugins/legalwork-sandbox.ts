import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { webFetchArgs, webSearchArgs } from "../agent-sandbox/web.js";
import { resolveWorkspaceId, serverUrl, workspaceToolHeaders } from "./office-plugin-shared.js";
import { isBrowserTool, requireBrowserNetwork } from "./browser-network-policy.js";
import { nativeTool, nativeToolSignal } from "./native-tool.js";
import { registerAppStateReminders } from "./native-app-state-reminders.js";
import { registerPrimaryContext } from "./native-review-worker.js";
import { nativeHostExecutionActions } from "../agent-sandbox/engine-policy.js";
import { rawHttpInputSchema, rawHttpOutputSchema, rawHttpToolName } from "../agent-sandbox/raw-http-schema.js";

const args = z.object({
  command: z.string().min(1).max(128000).describe("Command to execute using the shell and paths in the latest sandbox-settings reminder."),
  description: z.string().describe("Briefly describe what the command does."),
  workdir: z.string().optional().describe("Optional working directory. With sandboxing on use /workspace or /authorized/N; with it off use an absolute host folder. Omit to use the project directory."),
  skills: z.array(z.string().min(1).max(200)).max(16).optional().describe("Installed skills needed by this command. When sandboxing is on their folders are shared at /skills/0, /skills/1. Project skills follow the project edit permission; skills outside the project are read-only. When off use their host paths."),
  timeout: z.number().int().min(1).max(600000).optional(),
  write: z.boolean().optional().describe("Set true when the command needs to change project files. When sandboxing is on, false makes shared folders read-only. When off, this flag cannot restrict host access. File-change permissions still apply."),
});


const webResult = z.object({ title: z.string(), output: z.string(), metadata: z.record(z.string(), z.unknown()),
  attachments: z.array(z.object({ type: z.literal("file"), mime: z.string(), url: z.string() })).optional(),
}).passthrough();
const shellResult = z.object({ output: z.string(), exitCode: z.number(), truncated: z.boolean(), sandbox: z.enum(["host", "virtual-machine"]) }).passthrough();
const hostTools = new Set(nativeHostExecutionActions);
const webKinds: Array<"fetch" | "search"> = ["fetch", "search"];
const wikiCommandGuidance = "Wiki chats require protected execution for shell commands. When sandboxing is off, use wiki tools, read and glob instead; ask the user to enable Sandbox only if a command is necessary.";
const guidance = "Execute shell commands through legalwork_shell. Read web pages through legalwork_webfetch and search through legalwork_websearch. These web tools follow the same chat network setting as commands. The latest sandbox-settings reminder describes this chat's execution mode, shell and paths. In project chats, sandboxing off runs commands on the host; on runs in a protected Linux environment with only shared folders. Use host paths for ordinary file tools. Stricter tool and agent permissions still apply. A protected execution error must be resolved through the user's settings; never try another execution route to bypass it. " + wikiCommandGuidance;

export const LegalWorkSandbox = Plugin.define({
  id: "legalwork.sandbox",
  async setup(ctx) {
    const reminders = await registerAppStateReminders(ctx, {
      topic: "sandbox-settings",
      cleared: "Read the chat's current sandbox settings before running commands.",
      async read(sessionID, directory) {
        try {
          const context = { directory, sessionID };
          const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
          const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/sandbox/session/${encodeURIComponent(sessionID)}`, {
            headers: await workspaceToolHeaders(context), signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) return null;
          const state = z.object({ enabled: z.boolean(), networkMode: z.string(), shell: z.string(), platform: z.string(), cwd: z.string() }).parse(await response.json());
          return `Sandboxing is ${state.enabled ? "on" : "off"}. Shell: ${state.shell}. Platform: ${state.platform}. Project working directory: ${state.cwd}. ` +
            (state.enabled ? `Network mode: ${state.networkMode}. Browser tools are ${state.networkMode === "allow" ? "available" : "disabled; use the managed web tools for policy-controlled requests"}. Only shared folders are accessible. Python 3 and Node.js are installed. Authorized folders: /authorized/N. Skills: /skills/N.` : "In project chats, commands run directly on this computer with its installed tools and OS permissions. Sandbox network controls do not apply. Wiki chats cannot run commands while sandboxing is off; use wiki tools, read and glob instead.");
        } catch { return null; }
      },
    });
    await registerPrimaryContext(ctx, event => { event.system.push({ type: "text", text: guidance }); });
    // Commands expand shell interpolation outside the tool catalog. Guard the
    // native shell domain as well, before it can create any host process.
    await ctx.shell.hook("create.before", () => { throw new Error("Use legalwork_shell for command execution."); });
    await ctx.tool.hook("execute.before", async event => {
      if (hostTools.has(event.tool)) throw new Error("Use legalwork_shell, legalwork_webfetch or legalwork_websearch so this chat's execution and network settings are enforced.");
      const input = event.input && typeof event.input === "object" && !Array.isArray(event.input) ? Object.fromEntries(Object.entries(event.input)) : {};
      if (isBrowserTool(event.tool, input)) {
        const session = await ctx.session.get({ sessionID: event.sessionID });
        await requireBrowserNetwork({ sessionID: event.sessionID, directory: session.location.directory });
      }
    });
    await ctx.tool.transform(editor => {
      for (const tool of editor.list()) if (hostTools.has(tool.name) || hostTools.has(tool.id)) editor.remove(tool.id);
      // The patched native executor reserves this ID for built-in fetch and
      // excludes it from both advertised catalogs. Full payload stays private.
      editor.add(nativeTool(ctx, {
        name: rawHttpToolName,
        description: "Internal policy-controlled Code Mode HTTP transport.",
        schema: rawHttpInputSchema, outputSchema: rawHttpOutputSchema, permission: "domain",
        async execute(input, context) {
          if (!context.sessionID || !context.agent || !context.abort) throw new Error("HTTP access requires an active native session and agent identity.");
          const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
          const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/sandbox/http`, {
            method: "POST", headers: { ...await workspaceToolHeaders(context), "Content-Type": "application/json" },
            body: JSON.stringify({ ...input, sessionID: context.sessionID, agent: context.agent }), signal: context.abort,
          });
          if (!response.ok) throw new Error(`HTTP access failed (${response.status}): ${await response.text()}`);
          const output = rawHttpOutputSchema.parse(await response.json());
          return { output, content: [], metadata: { method: input.method, url: input.url } };
        },
      }));
      for (const kind of webKinds) {
        editor.add(nativeTool(ctx, {
          name: kind === "fetch" ? "legalwork_webfetch" : "legalwork_websearch",
          description: kind === "fetch" ? "Read a web page using this chat's network setting and web permissions. Approval appears in the chat before contacting the website. Redirects require separate approval." : "Search the web using Exa, following this chat's network setting and web permissions. The query is sent only after any required approval.",
          schema: kind === "fetch" ? webFetchArgs : webSearchArgs,
          outputSchema: webResult,
          permission: "domain",
          async execute(input, context) {
            if (!context.sessionID || !context.agent) throw new Error("Web access requires a session and agent identity.");
            const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
            const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/sandbox/web`, {
              method: "POST", headers: { ...await workspaceToolHeaders(context), "Content-Type": "application/json" },
              body: JSON.stringify({ ...input, kind, sessionID: context.sessionID, agent: context.agent }), signal: nativeToolSignal(900000, context),
            });
            if (!response.ok) throw new Error(`Web access failed (${response.status}): ${await response.text()}`);
            const result = webResult.parse(await response.json());
            return { output: result, metadata: { ...result.metadata, title: result.title },
              content: [{ type: "text", text: result.output }, ...(result.attachments ?? []).map(file => ({ type: file.type, mime: file.mime, uri: file.url }))] };
          },
        }));
      }
      editor.add(nativeTool(ctx, {
        name: "legalwork_shell",
        description: "Execute commands using this chat's sandbox setting and the user's shell and file permissions. Supply both command and description. With sandboxing on, Linux commands have isolated files and controlled network access, with no host fallback. In project chats with sandboxing off, commands use the local shell and host paths. " + wikiCommandGuidance,
        schema: args,
        outputSchema: shellResult,
        permission: "domain",
        async execute(input, context) {
          if (!context.sessionID || !context.agent) throw new Error("Sandbox execution requires a session and agent identity.");
          const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
          const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/sandbox/execute`, {
            method: "POST", headers: { ...await workspaceToolHeaders(context), "Content-Type": "application/json" },
            body: JSON.stringify({ command: input.command, description: input.description, workdir: input.workdir, skills: input.skills, write: input.write ?? false,
              timeoutMs: input.timeout ?? 120000, agent: context.agent, sessionID: context.sessionID }), signal: nativeToolSignal(900000, context),
          });
          if (!response.ok) throw new Error(`Command execution failed (${response.status}): ${await response.text()}`);
          const result = shellResult.parse(await response.json());
          return { content: result.output, output: result, metadata: { title: input.description, exit: result.exitCode, truncated: result.truncated, sandbox: result.sandbox } };
        },
      }));
    });
    return reminders;
  },
});
export default LegalWorkSandbox;
