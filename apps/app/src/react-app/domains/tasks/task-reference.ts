/**
 * How chat text names a task.
 *
 * Two forms. A user turn that starts work on a task carries its id plus the
 * tool that reads it — `[task <id> via legalwork_task_get]` — so the agent
 * fetches the task itself and the sender's text arrives inside the tool's
 * untrusted block, never as the user's words. An assistant turn links a task
 * the way it links a document: `[title](legalworktask://<id>)`, which the
 * markdown renderer turns into a chip that opens the task in the Tasks pane.
 * Both are rendered by components/chat/message-list.tsx and
 * components/markdown/markdown.tsx; the task tools' system prompt tells the
 * agent what each means.
 */

export const TASK_REFERENCE_SOURCE = String.raw`\[task [\w-]+ via legalwork_task_get\]`;

export function taskReference(taskId: string): string {
  return `[task ${taskId} via legalwork_task_get]`;
}

export function parseTaskReference(text: string): { taskId: string } | null {
  const match = /^\[task ([\w-]+) via legalwork_task_get\]$/.exec(text);
  return match?.[1] ? { taskId: match[1] } : null;
}

/** The link scheme an assistant turn (or a tool result) names a task by. */
export const TASK_LINK_SCHEME = "legalworktask://";

export function taskLinkUri(taskId: string): string {
  return `${TASK_LINK_SCHEME}${encodeURIComponent(taskId)}`;
}

/** The task id of a `legalworktask://<id>` href; null for anything else. */
export function parseTaskLink(href: string): { taskId: string } | null {
  const match = /^legalworktask:\/{0,2}([\w-]+)\/?$/i.exec(href.trim());
  return match?.[1] ? { taskId: match[1] } : null;
}

/** Fired on `window` when a chip asks for a task to be shown; the session
 *  route opens the Tasks pane on it. */
export const TASK_OPEN_EVENT = "legalwork:task-open";

export type TaskOpenEventDetail = { taskId: string };

export function requestOpenTask(taskId: string): void {
  window.dispatchEvent(new CustomEvent<TaskOpenEventDetail>(TASK_OPEN_EVENT, { detail: { taskId } }));
}
