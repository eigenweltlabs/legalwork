import type {
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistantTool,
  SessionStatus,
  TokenUsageInfo,
} from "@opencode/client";
import type { HistoricalAttachment, HistoricalMessage, SessionHistoryProvenance } from "./session-history.js";

/** Presentation-only models. Native engine records are retained alongside each view. */
export type SessionView = SessionInfo & { title: string; directory: string };
export type PartBase = { id: string; sessionID: string; messageID: string };
export type TextPart = PartBase & {
  type: "text";
  text: string;
  synthetic?: boolean;
  ignored?: boolean;
  time?: { start: number; end?: number };
  metadata?: Record<string, unknown>;
};
export type FilePart = PartBase & {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  history?: HistoricalAttachment;
  source?:
    | {
        type: "file";
        path: string;
        text?: { value: string; start: number; end: number };
      }
    | { type: "resource"; uri: string; clientName?: string }
    | { type: "symbol"; path: string; name: string };
};
export type ToolPart = PartBase & {
  type: "tool";
  callID: string;
  tool: string;
  metadata?: Record<string, unknown>;
  state:
    | { status: "pending"; input: Record<string, unknown>; raw: string }
    | {
        status: "running";
        input: Record<string, unknown>;
        title?: string;
        metadata?: Record<string, unknown>;
        time: { start: number };
      }
    | {
        status: "completed";
        input: Record<string, unknown>;
        output: string;
        title: string;
        metadata: Record<string, unknown>;
        time: { start: number; end: number; compacted?: number };
        attachments?: FilePart[];
      }
    | {
        status: "error";
        input: Record<string, unknown>;
        error: string;
        metadata?: Record<string, unknown>;
        time: { start: number; end: number };
      };
};
export type Part =
  | TextPart
  | FilePart
  | ToolPart
  | (PartBase & {
      type: "reasoning";
      text: string;
      time: { start: number; end?: number };
      metadata?: Record<string, unknown>;
    })
  | (PartBase & { type: "agent"; name: string })
  | (PartBase & { type: "step-start"; snapshot?: string })
  | (PartBase & {
      type: "step-finish";
      reason: string;
      cost: number;
      tokens: TokenUsageInfo;
      snapshot?: string;
    })
  | (PartBase & { type: "patch"; hash: string; files: string[] })
  | (PartBase & { type: "snapshot"; snapshot: string })
  | (PartBase & { type: "compaction"; auto: boolean; overflow?: boolean })
  | (PartBase & {
      type: "subtask";
      prompt: string;
      description: string;
      agent: string;
    })
  | (PartBase & {
      type: "retry";
      attempt: number;
      error: unknown;
      time: { created: number };
    });
export type MessageViewInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  time: { created: number; completed?: number };
  model: { providerID: string; modelID: string };
  modelID: string;
  providerID: string;
  agent: string;
  cost: number;
  tokens: TokenUsageInfo;
  error?: unknown;
  summary?: boolean;
  finish?: string;
  metadata?: Record<string, unknown>;
};
export type MessageView = {
  native?: SessionMessageInfo;
  info: MessageViewInfo;
  parts: Part[];
};
export type Todo = {
  id: string;
  content: string;
  status: string;
  priority: string;
};
export type SessionSnapshotView = {
  session: SessionView;
  messages: MessageView[];
  todos: Todo[];
  status: SessionStatus;
  historyProvenance?: SessionHistoryProvenance;
};
export type PromptPart =
  | {
      id?: string;
      type: "text";
      text: string;
      synthetic?: boolean;
      ignored?: boolean;
      metadata?: Record<string, unknown>;
    }
  | { type: "file"; url: string; mime: string; filename?: string }
  | { type: "agent"; name: string }
  | { type: "skill"; id: string };
export type FilePartInput = Extract<PromptPart, { type: "file" }>;
export type TextPartInput = Extract<PromptPart, { type: "text" }>;
export type AgentPartInput = Extract<PromptPart, { type: "agent" }>;
export type SubtaskPartInput = {
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
};
export function projectSession(session: SessionInfo): SessionView {
  return {
    ...session,
    title: session.title ?? "",
    directory: session.location.directory,
  };
}
const zeroTokens = (): TokenUsageInfo => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});
/** Hide only metadata-attested model reminders in presentation, preserving native content. */
export function toolDisplayText(
  content: ReadonlyArray<{ type: string; text?: string }>,
  metadata?: Record<string, unknown>,
): string {
  const states = metadata?.legalworkSystemReminders;
  const reminders = new Set(
    states && typeof states === "object" && !Array.isArray(states)
      ? Object.entries(states).flatMap(([topic, state]) =>
          typeof state === "string"
            ? [
                `<system-reminder topic="${topic}">\n${state}\n</system-reminder>`,
              ]
            : [],
        )
      : [],
  );
  return content
    .flatMap((item) =>
      item.type === "text" &&
      item.text !== undefined &&
      !reminders.has(item.text)
        ? [item.text]
        : [],
    )
    .join("\n");
}
export function projectTool(
  sessionID: string,
  messageID: string,
  tool: SessionMessageAssistantTool,
): ToolPart {
  const base = {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: tool.id,
    tool: tool.name,
  };
  const time = {
    start: tool.time.ran ?? tool.time.created,
    end: tool.time.completed ?? tool.time.created,
  };
  const state = tool.state;
  if (state.status === "streaming")
    return {
      ...base,
      state: { status: "pending", input: {}, raw: state.input ?? "" },
    };
  if (state.status === "running")
    return {
      ...base,
      state: {
        status: "running",
        input: state.input,
        metadata: state.metadata,
        time,
      },
    };
  const attachments =
    state.content?.flatMap((content, index): FilePart[] =>
      content.type === "file"
        ? [
            {
              id: `${tool.id}:file:${index}`,
              sessionID,
              messageID,
              type: "file",
              url: content.uri,
              mime: content.mime,
              filename: content.name ?? undefined,
            },
          ]
        : [],
    ) ?? [];
  if (state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: state.input,
        error: [
          state.error.message,
          ...(state.content ?? []).flatMap((content) =>
            content.type === "text" ? [content.text] : [],
          ),
        ].join("\n"),
        metadata: state.metadata,
        time,
      },
    };
  return {
    ...base,
    state: {
      status: "completed",
      input: state.input,
      output: toolDisplayText(state.content, state.metadata),
      title: tool.name,
      metadata: state.metadata ?? {},
      time,
      attachments,
    },
  };
}
export function projectMessage(
  sessionID: string,
  message: SessionMessageInfo,
  historical?: HistoricalMessage,
): MessageView[] {
  // Native synthetic input is model-visible context, including migrated v1
  // reminders whose original metadata flags are not retained upstream.
  if (message.type === "synthetic") return [];
  if (
    ![
      "user",
      "assistant",
      "synthetic",
      "system",
      "shell",
      "compaction",
      "skill",
    ].includes(message.type)
  )
    return [];
  const assistant = message.type === "assistant" ? message : undefined;
  const model = assistant?.model;
  const info: MessageViewInfo = {
    id: message.id,
    sessionID,
    role: message.type === "user" ? "user" : "assistant",
    time: message.time,
    model: { providerID: model?.providerID ?? "", modelID: model?.id ?? "" },
    providerID: model?.providerID ?? "",
    modelID: model?.id ?? "",
    agent: assistant?.agent ?? "",
    cost:
      assistant?.cost ??
      (message.type === "compaction" && "cost" in message ? message.cost : 0) ??
      0,
    tokens:
      assistant?.tokens ??
      (message.type === "compaction" && "tokens" in message
        ? message.tokens
        : undefined) ??
      zeroTokens(),
    error: assistant?.error,
    metadata: message.metadata,
  };
  const base = { sessionID, messageID: message.id };
  let parts: Part[] = [];
  if (message.type === "assistant") {
    parts = message.content.map(
      (content, index): Part =>
        content.type === "tool"
          ? projectTool(sessionID, message.id, content)
          : content.type === "text"
            ? {
                ...base,
                id: `${message.id}:content:${index}`,
                type: "text",
                text: content.text,
              }
            : {
                ...base,
                id: `${message.id}:content:${index}`,
                type: "reasoning",
                text: content.text,
                time: {
                  start: content.time?.created ?? message.time.created,
                  end: content.time?.completed,
                },
              },
    );
  } else if (message.type === "user") {
    const visible = message.metadata?.legalworkPrompt;
    const text =
      visible &&
      typeof visible === "object" &&
      !Array.isArray(visible) &&
      typeof visible.visibleText === "string"
        ? visible.visibleText
        : message.text;
    parts = [
      {
        ...base,
        id: `${message.id}:text`,
        type: "text",
        text,
        metadata: historical?.scheduledTask && !message.metadata?.legalworkScheduledTask ? {...message.metadata,legalworkScheduledTask:historical.scheduledTask} : message.metadata,
      },
      ...(message.files ?? []).map(
        (file, index): FilePart => {
          const history=historical?.attachments.find(attachment=>attachment.nativeFileIndex===index);
          return ({
          ...base,
          id: `${message.id}:file:${index}`,
          type: "file",
          url:
            file.source.type === "uri"
              ? file.source.uri
              : `data:${file.mime};base64,${file.data}`,
          mime: file.mime,
          filename: file.name,
          history,
          source: history?.sourcePath ? {type:"file",path:history.sourcePath} :
            file.source.type === "uri"
              ? { type: "resource", uri: file.source.uri }
              : undefined,
        });},
      ),
      ...(historical?.attachments ?? []).flatMap((history):FilePart[]=>history.bytes==="reference-only" && (history.sourcePath || history.reference) ? [{...base,id:`${message.id}:history:${history.partID}`,type:"file",filename:history.name,mime:history.mime,url:history.reference ?? "",history,source:history.sourcePath ? {type:"file",path:history.sourcePath}:history.reference ? {type:"resource",uri:history.reference}:undefined}]:[]),
    ];
  } else if (message.type === "system") {
    parts = [
      { ...base, id: `${message.id}:text`, type: "text", text: message.text },
    ];
  } else if (message.type === "skill") {
    parts = [
      {
        ...base,
        id: `${message.id}:skill`,
        type: "tool",
        callID: message.id,
        tool: "skill",
        state: {
          status: "completed",
          input: { id: message.skill, name: message.name },
          title: message.name,
          output: message.text,
          metadata: {},
          time: { start: message.time.created, end: message.time.created },
        },
      },
    ];
  } else if (message.type === "shell") {
    parts = [
      {
        ...base,
        id: message.shellID,
        type: "tool",
        callID: message.shellID,
        tool: "bash",
        state:
          message.status === "running"
            ? {
                status: "running",
                input: { command: message.command },
                time: { start: message.time.created },
              }
            : {
                status: "completed",
                input: { command: message.command },
                title: message.command,
                output: message.output?.output ?? "",
                metadata: {
                  shellID: message.shellID,
                  status: message.status,
                  exit: message.exit,
                  outputTruncated: message.output?.truncated ?? false,
                  outputSize: message.output?.size ?? 0,
                },
                time: {
                  start: message.time.created,
                  end: message.time.completed ?? message.time.created,
                },
              },
      },
    ];
  } else if (message.type === "compaction") {
    info.summary=true;
    parts = [
      {
        ...base,
        id: `${message.id}:compaction`,
        type: "compaction",
        auto: message.reason === "auto",
      },
    ];
    if (message.status === "completed") {
      info.summary = true;
      parts.push({
        ...base,
        id: `${message.id}:summary`,
        type: "text",
        text: message.summary,
      });
    }
  }
  return [{ native: message, info, parts }];
}
export function projectMessages(
  sessionID: string,
  messages: SessionMessageInfo[],
  historical?: Record<string,HistoricalMessage>,
) {
  return messages.flatMap((message) => projectMessage(sessionID, message,historical?.[message.id]));
}
