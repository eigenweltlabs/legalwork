import { z } from "zod";
import { resolveWorkspaceId, serverToken, serverUrl, type OpenCodeContext } from "./office-plugin-shared.js";

const args = z.object({
  command: z.string().min(1).max(128000).describe("Bash command to execute inside the protected Linux environment. Python 3 and Node.js are installed."),
  description: z.string().describe("Briefly describe what the command does."),
  workdir: z.string().optional().describe("Sandbox directory, normally /workspace. Authorized folders appear at /authorized/0, /authorized/1, etc. Host absolute paths are not available."),
  skills: z.array(z.string().min(1).max(200)).max(16).optional().describe("Installed skill names needed by this command. Their folders are available read-only at /skills/0, /skills/1 in this order. Run helper scripts using these paths instead of their host paths."),
  timeout: z.number().int().min(1).max(600000).optional(),
  write: z.boolean().optional().describe("Set true only when the command needs to change project files. Otherwise all authorized folders are mounted read-only. File-change permissions still apply."),
});

export const LegalWorkSandbox = async () => ({
  "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
    output.system.push("Shell commands run in LegalWork's protected Linux environment. The project is /workspace; explicitly authorized folders are /authorized/0, /authorized/1 and so on. Python 3 and Node.js are available. Use sandbox paths in shell commands and host project paths in the normal file tools. Request write:true when a command must change project files. Sandbox network settings either allow outbound traffic, block it, or require approval of each HTTP(S) request. Stricter tool and agent permissions still apply. Host credentials and host control sockets are unavailable. A protection error must be reported or resolved through the user's settings; never try another execution route to bypass it.");
  },
  // Covers the engine's direct shell endpoint and fails closed if a future
  // engine version accidentally selects its built-in bash tool.
  "shell.env": async () => { throw new Error("Use LegalWork's sandboxed bash tool for command execution."); },
  tool: {
    legalwork_shell: {
      description: "Execute Bash, Python or Node in the protected environment with the user's shell, file-change and internet permissions. Read-only by default. The environment ends with the command, including background descendants. Approved file changes are copied back when the command finishes. No host fallback is available.",
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
        if (!response.ok) throw new Error(`Protected execution failed (${response.status}): ${await response.text()}`);
        const result = z.object({ output: z.string(), exitCode: z.number(), truncated: z.boolean() }).parse(await response.json());
        return { title: input.description, output: result.output, metadata: { exit: result.exitCode, truncated: result.truncated, sandbox: "virtual-machine" } };
      },
    },
  },
});
