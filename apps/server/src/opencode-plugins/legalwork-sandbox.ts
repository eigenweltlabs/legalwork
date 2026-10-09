import { appStateReminders, type SavedConversations } from "./app-state-reminders.js";
import { z } from "zod";
import { resolveWorkspaceId, serverToken, serverUrl, type OpenCodeContext } from "./office-plugin-shared.js";

const args = z.object({
  command: z.string().min(1).max(128000).describe("Command to execute using the shell and paths in the latest sandbox-settings reminder."),
  description: z.string().describe("Briefly describe what the command does."),
  workdir: z.string().optional().describe("Optional working directory. With sandboxing on use /workspace or /authorized/N; with it off use an absolute host folder. Omit to use the project directory."),
  skills: z.array(z.string().min(1).max(200)).max(16).optional().describe("Installed skills needed by this command. When sandboxing is on their folders are shared read-only at /skills/0, /skills/1. When off use their host paths."),
  timeout: z.number().int().min(1).max(600000).optional(),
  write: z.boolean().optional().describe("Set true when the command needs to change project files. When sandboxing is on, false makes shared folders read-only. When off, this flag cannot restrict host access. File-change permissions still apply."),
});

export const LegalWorkSandbox = async (input: SavedConversations = {}) => {
  const reminders = appStateReminders("sandbox-settings", async (sessionID) => {
    try {
      const workspace = await resolveWorkspaceId({ directory: input.directory }, { requireDirectory: true });
      const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/sandbox/session/${encodeURIComponent(sessionID)}`, {
        headers: { Authorization: `Bearer ${serverToken()}` }, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return null;
      const state = z.object({ enabled: z.boolean(), networkMode: z.string(), shell: z.string(), platform: z.string(), cwd: z.string() }).parse(await response.json());
      return `Sandboxing is ${state.enabled ? "on" : "off"}. Shell: ${state.shell}. Platform: ${state.platform}. Project working directory: ${state.cwd}. ` +
        (state.enabled ? `Network mode: ${state.networkMode}. Only shared folders are accessible. Python 3 and Node.js are installed. Authorized folders: /authorized/N. Skills: /skills/N.` : "Commands run directly on this computer with its installed tools and OS permissions. Sandbox network controls do not apply.");
    } catch { return null; }
  }, "Read the chat's current sandbox settings before running commands.", input);
  return {
  "chat.message": reminders.userMessage,
  "tool.execute.after": reminders.toolResult,
  event: reminders.event,
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push("Execute shell commands through legalwork_shell. The latest sandbox-settings reminder describes this chat's execution mode, shell and paths. Sandboxing off runs on the host; on runs in a protected Linux environment with only shared folders. Use host paths for ordinary file tools. Stricter tool and agent permissions still apply. A protected execution error must be resolved through the user's settings; never try another execution route to bypass it.");
  },
  // Covers the engine's direct shell endpoint and fails closed if a future
  // engine version accidentally selects its built-in bash tool.
  "shell.env": async () => { throw new Error("Use legalwork_shell for command execution."); },
  tool: {
    legalwork_shell: {
      description: "Execute commands using this chat's sandbox setting and the user's shell and file permissions. With sandboxing on, Linux commands have isolated files and controlled network access, with no host fallback. With sandboxing off, commands use the local shell and host paths.",
      args: args.shape,
      async execute(raw: unknown, context: OpenCodeContext & { abort?: AbortSignal }) {
        const input = args.parse(raw);
        if (!context.sessionID || !context.agent) throw new Error("Sandbox execution requires a session and agent identity.");
        const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
        const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/sandbox/execute`, {
          method: "POST", headers: { Authorization: `Bearer ${serverToken()}`, "Content-Type": "application/json" },
          body: JSON.stringify({ command: input.command, description: input.description, workdir: input.workdir, skills: input.skills, write: input.write ?? false,
            timeoutMs: input.timeout ?? 120000, agent: context.agent, sessionID: context.sessionID }),
          signal: context.abort ? AbortSignal.any([context.abort, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000),
        });
        if (!response.ok) throw new Error(`Command execution failed (${response.status}): ${await response.text()}`);
        const result = z.object({ output: z.string(), exitCode: z.number(), truncated: z.boolean(), sandbox: z.enum(["host", "virtual-machine"]) }).parse(await response.json());
        return { title: input.description, output: result.output, metadata: { exit: result.exitCode, truncated: result.truncated, sandbox: result.sandbox } };
      },
    },
  },
  };
};
