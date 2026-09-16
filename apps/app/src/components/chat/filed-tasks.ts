import { isToolUIPart, type DynamicToolUIPart, type ToolUIPart, type UIMessage } from "ai";

/**
 * The tasks an assistant message filed, read off `legalwork_task_create`
 * results. They sit in the message's artifact strip next to the files it
 * produced — a task is something the turn made, like a document — and they
 * are there whether or not the model linked the task in its prose.
 */

/** A task the agent filed in a message. */
export type FiledTask = { id: string; title: string | null };

const CREATE_TOOL = "legalwork_task_create";

function toolNameOf(part: ToolUIPart | DynamicToolUIPart): string {
  return part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
}

function parseOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/**
 * Filed tasks, oldest first, each once. A task the prose also links stays in
 * the strip — the same as a file that is both mentioned and listed.
 */
export function filedTasksOf(parts: UIMessage["parts"]): FiledTask[] {
  const seen = new Set<string>();
  const filed: FiledTask[] = [];
  for (const part of parts) {
    if (!isToolUIPart(part) || part.state !== "output-available" || toolNameOf(part) !== CREATE_TOOL) continue;
    const output = parseOutput(part.output);
    if (typeof output !== "object" || output === null) continue;
    const { ok, task } = output as { ok?: unknown; task?: unknown };
    if (ok !== true || typeof task !== "object" || task === null) continue;
    const { id, title } = task as { id?: unknown; title?: unknown };
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    filed.push({ id, title: typeof title === "string" && title.trim() ? title : null });
  }
  return filed;
}
