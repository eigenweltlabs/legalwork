/**
 * "Start workflow" / "Start session" — work on a task in a folder.
 *
 * The task lives in the server's store; the run lives in the folder. Its
 * attachments are read from the server (fetched from the platform first if
 * they are not on this machine yet) and written into the chosen folder, and a
 * session is created there. The task is named by id (task-reference.ts), never by content:
 * the agent reads it itself with legalwork_task_get, so the sender's text
 * arrives inside the tool's untrusted block, never as the user's words.
 *
 * With a workflow, the first message invokes the workflow skill and the agent
 * starts right away. Without one, nothing is sent: the task goes into the new
 * session's message box as a pill with a short ask, for the user to edit or
 * send.
 * The only thing that travels back to the platform is `lastLocalRunAt`: a
 * content-free marker that says "someone ran this on their machine", never
 * which machine, which folder or which session. Which session it was is kept
 * by the local server, tied to the task, so the task can open it again.
 */
import { createClient, unwrap } from "@/app/lib/opencode";
import type {
  LegalworkTask,
  LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { toSessionTransportDirectory } from "@/app/lib/session-scope";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { ModelRef } from "@/app/types";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { t } from "@/i18n";
import { useComposerStateStore } from "@/react-app/domains/session/surface/composer-state-store";
import {
  createTaskComposerMention,
  encodeComposerMentionValue,
} from "@/react-app/domains/session/surface/composer/mention-encoding";
import { taskReference } from "./task-reference";

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
  task: LegalworkTask;
  /** Folder the run happens in. */
  workspace: RouteWorkspace;
  /** Local LegalWork server handle, used to resolve the folder's endpoint. */
  baseUrl: string;
  token: string;
  /** Workflow skill name (`kind: "workflow"`) from the user's own library;
   *  null opens a plain session that only carries the task's context. */
  workflowName: string | null;
  model: ModelRef | null;
};

export type StartWorkflowResult = {
  workspaceId: string;
  sessionId: string;
  /** Files actually written, relative to the folder root. */
  attachmentPaths: string[];
};

/**
 * A workflow run's first message: the task reference, and where its files are.
 * Only the folder is named, never a filename — filenames are sender-chosen, and
 * the agent gets them from legalwork_task_get inside the untrusted block.
 */
function buildSeedPrompt(task: LegalworkTask, workflowName: string, attachmentPaths: string[]): string {
  const lines = [t("tasks.run_prompt_heading", { workflow: workflowName, task: taskReference(task.id) })];
  if (attachmentPaths.length) {
    lines.push(t("tasks.run_prompt_attachments", { folder: `${taskAttachmentDir(task.id)}/` }));
  }
  return lines.join("\n\n");
}

/**
 * Put the task into a session's message box: a task pill and a short ask. The
 * pill becomes the task badge when the user sends, along with a one-turn
 * instruction to read the task (mention-encoding.ts). The mention is registered
 * first so the editor knows the token is a pill when the draft arrives.
 */
function prefillTaskSession(sessionId: string, taskId: string): void {
  const reference = createTaskComposerMention(taskId);
  const composer = useComposerStateStore.getState();
  composer.setMentions(sessionId, { [reference]: "task" });
  composer.setDraft(sessionId, `@${encodeComposerMentionValue(reference)} ${t("tasks.session_draft_message")}`);
}

export async function startTaskWorkflow(input: StartWorkflowInput): Promise<StartWorkflowResult> {
  const endpoint = resolveWorkspaceEndpoint(input.workspace, {
    baseUrl: input.baseUrl,
    token: input.token,
  });
  if (!endpoint) throw new Error(t("tasks.run_workspace_unreachable"));

  // Attachments first: the agent is pointed at their folder, so they have to
  // be on disk before it reads the task.
  const attachmentPaths: string[] = [];
  const directory = taskAttachmentDir(input.task.id);
  for (const [index, attachment] of input.task.attachments.entries()) {
    const download = await input.relay.client.downloadTaskAttachment(
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

  if (input.workflowName) {
    const result = await opencode.session.promptAsync({
      sessionID: session.id,
      directory: transportDirectory,
      model: input.model ?? undefined,
      parts: [{ type: "text", text: buildSeedPrompt(input.task, input.workflowName, attachmentPaths) }],
    });
    if (result.error !== undefined) throw new Error(t("tasks.run_prompt_failed"));
  } else {
    prefillTaskSession(session.id, input.task.id);
  }

  // Tie the session to the task on this machine, and leave the firm a
  // content-free marker that the task was picked up locally. A failure in
  // either must not lose the run the user already started.
  await input.relay.client
    .recordTaskSession(input.relay.workspaceId, input.task.id, {
      sessionId: session.id,
      workspaceId: input.workspace.id,
      kind: input.workflowName ? "workflow" : "session",
      workflowName: input.workflowName,
    })
    .catch(() => undefined);
  await input.relay.client
    .patchTask(input.relay.workspaceId, input.task.id, {
      lastLocalRunAt: new Date().toISOString(),
    })
    .catch(() => undefined);

  return { workspaceId: input.workspace.id, sessionId: session.id, attachmentPaths };
}
