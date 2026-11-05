import type { SessionStatus } from "@opencode/client";
import type { Client } from "../types";
import { projectMessages, projectSession, type Todo } from "./opencode-view";
export async function readSession(client: Client, sessionID: string) {
  return projectSession(await client.session.get({ sessionID }));
}
export async function readMessages(
  client: Client,
  session: string | { sessionID: string; directory?: string },
) {
  const sessionID = typeof session === "string" ? session : session.sessionID;
  const messages = [];
  let cursor: string | undefined;
  const seen=new Set<string>();
  do {
    const page = await client.message.list(cursor ? {sessionID,cursor}:{sessionID,order:"asc"});
    messages.push(...page.data);
    cursor = page.cursor.next ?? undefined;
    if(cursor && seen.has(cursor))throw new Error("The native engine repeated a message page cursor");
    if(cursor)seen.add(cursor);
  } while (cursor);
  return projectMessages(sessionID, messages);
}
export async function readSessionStatuses(
  client: Client,
  _scope?: { directory?: string },
): Promise<Record<string, SessionStatus>> {
  return Object.fromEntries(
    Object.keys(await client.session.active()).map((id) => [
      id,
      { type: "busy" },
    ]),
  );
}
export async function readTodos(
  client: Client,
  sessionID: string,
): Promise<Todo[]> {
  const messages = await readMessages(client, sessionID);
  for (const message of messages.toReversed())
    for (const part of message.parts.toReversed()) {
      if (
        part.type !== "tool" ||
        part.tool !== "todowrite" ||
        part.state.status !== "completed"
      )
        continue;
      const value = projectNativeTodos(part.state.metadata.todos, part.id);
      if (value) return value;
    }
  return [];
}

/** Native todowrite metadata is the same full plan in history and live events. */
export function projectNativeTodos(value: unknown, toolID: string): Todo[] | undefined {
  if (!Array.isArray(value)) return;
  return value.flatMap((todo, index) =>
        todo &&
        typeof todo === "object" &&
        typeof todo.content === "string" &&
        typeof todo.status === "string"
          ? [
              {
                id:
                  typeof todo.id === "string" ? todo.id : `${toolID}:${index}`,
                content: todo.content,
                status: todo.status,
                priority:
                  typeof todo.priority === "string" ? todo.priority : "medium",
              },
            ]
          : [],
      );
}

export async function createSessionView(
  client: Client,
  input?: { directory?: string; title?: string; parentID?: string },
) {
  return projectSession(
    await client.session.create({
      title: input?.title,
      parentID: input?.parentID,
      location: input?.directory ? { directory: input.directory } : undefined,
    }),
  );
}
