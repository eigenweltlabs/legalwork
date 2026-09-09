/**
 * "Start workflow" — run an intake task locally.
 *
 * The task lives on the platform; the run does not. Attachments are pulled
 * through the relay and written into the chosen folder, a session is created
 * there and seeded with the task's context, and the workflow skill is invoked.
 * The only thing that travels back to the platform is `lastLocalRunAt`: a
 * content-free marker that says "someone ran this on their machine", never
 * which machine, which folder or which session.
 */
import { createClient, unwrap } from "@/app/lib/opencode";
import type {
  EigenweltIntakeTask,
  LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { toSessionTransportDirectory } from "@/app/lib/session-scope";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ModelRef } from "@/app/types";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { t } from "@/i18n";

/** Where a task's downloaded attachments live inside the chosen folder. */
function taskAttachmentDir(taskId: string): string {
  return `.legalwork/tasks/${taskId}`;
}

/**
 * Attachment filenames come from email, so they can carry separators or `..`.
 * The server rejects escaping paths anyway; flattening here keeps the name the
 * agent sees identical to the one written.
 */
function safeAttachmentName(filename: string, fallback: string): string {
  const flattened = filename.replace(/[\\/]+/g, "_").replace(/^\.+/, "").trim();
  return flattened || fallback;
}

export type StartWorkflowInput = {
  /** Relay handle: the server that holds the firm's platform token. */
  relay: { client: LegalworkServerClient; workspaceId: string };
  task: EigenweltIntakeTask;
  /** Folder the run happens in. */
  workspace: RouteWorkspace;
  /** Local LegalWork server handle, used to resolve the folder's endpoint. */
  baseUrl: string;
  token: string;
  /** Workflow skill name (`kind: "workflow"`) from the user's own library. */
  workflowName: string;
  model: ModelRef | null;
};

export type StartWorkflowResult = {
  workspaceId: string;
  sessionId: string;
  /** Files actually written, relative to the folder root. */
  attachmentPaths: string[];
};

function buildSeedPrompt(task: EigenweltIntakeTask, workflowName: string, attachmentPaths: string[]): string {
  const lines: string[] = [t("tasks.run_prompt_heading", { workflow: workflowName }), ""];
  lines.push(`${t("tasks.column_title")}: ${task.title}`);
  lines.push(`${t("tasks.column_endpoint")}: ${task.endpointName}`);
  if (task.assignmentNote?.trim()) {
    lines.push(`${t("tasks.assignment_note")}: ${task.assignmentNote.trim()}`);
  }
  if (task.description.trim()) {
    lines.push("", `${t("tasks.field_description")}:`, task.description.trim());
  }
  if (attachmentPaths.length) {
    lines.push("", `${t("tasks.run_prompt_attachments")}:`);
    for (const path of attachmentPaths) lines.push(`- ${path}`);
  }
  return lines.join("\n");
}

export async function startTaskWorkflow(input: StartWorkflowInput): Promise<StartWorkflowResult> {
  const endpoint = resolveWorkspaceEndpoint(input.workspace, {
    baseUrl: input.baseUrl,
    token: input.token,
  });
  if (!endpoint) throw new Error(t("tasks.run_workspace_unreachable"));

  // Attachments first: the seeded prompt names their paths, so they have to be
  // on disk before the agent reads it.
  const attachmentPaths: string[] = [];
  const directory = taskAttachmentDir(input.task.id);
  for (const [index, attachment] of input.task.attachments.entries()) {
    const download = await input.relay.client.intakeDownloadAttachment(
      input.relay.workspaceId,
      input.task.id,
      attachment.id,
    );
    const name = safeAttachmentName(attachment.filename, `attachment-${index + 1}`);
    const path = `${directory}/${name}`;
    await endpoint.client.writeWorkspaceBinaryFile(endpoint.workspaceId, {
      path,
      data: download.data,
      force: true,
    });
    attachmentPaths.push(path);
  }

  const workspaceRoot = input.workspace.path?.trim() || "";
  const opencode = createClient(endpoint.opencodeBaseUrl, workspaceRoot || undefined, {
    token: endpoint.token,
    mode: "legalwork",
  });
  const transportDirectory = toSessionTransportDirectory(workspaceRoot) || undefined;
  const session = unwrap(
    await opencode.session.create({
      directory: transportDirectory,
      title: input.task.title,
    }),
  );

  const result = await opencode.session.promptAsync({
    sessionID: session.id,
    directory: transportDirectory,
    model: input.model ?? undefined,
    parts: [{ type: "text", text: buildSeedPrompt(input.task, input.workflowName, attachmentPaths) }],
  });
  if (result.error !== undefined) {
    throw new Error(t("tasks.run_prompt_failed"));
  }

  // Content-free marker so the rest of the firm can see the task was picked up
  // locally. A failure here must not lose the run the user already started.
  await input.relay.client
    .intakePatchTask(input.relay.workspaceId, input.task.id, {
      lastLocalRunAt: new Date().toISOString(),
    })
    .catch(() => undefined);

  return { workspaceId: input.workspace.id, sessionId: session.id, attachmentPaths };
}
