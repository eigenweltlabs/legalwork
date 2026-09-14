import { isReasoningUIPart, isToolUIPart, type DynamicToolUIPart, type FileUIPart, type ReasoningUIPart, type ToolUIPart, type UIMessage } from "ai"
import type { ThreadStatus } from "@/lib/messages"
import { t } from "@/i18n";

interface MessageGroup {
  messages: UIMessageWithIndex[]
}

export type UIMessageWithIndex = { index: number, message: UIMessage }
type MessageListItem = MessageGroup | UIMessageWithIndex

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

export function getMessagesText(messages: UIMessage[]): string {
  return messages
    .map(getMessageText)
    .filter(Boolean)
    .join("\n\n")
}

export function getLastTextPart(message: UIMessage): UIMessage | null {
  const lastTextPart = message.parts.findLast((part) => part.type === "text")

  return lastTextPart ? { ...message, parts: [lastTextPart] } : null
}

export function getFileTitle(part: FileUIPart) {
  if (part.filename) {
    return part.filename
  }

  if (part.url.startsWith("data:")) {
    return t("tool.attached_file")
  }

  return part.url || "File"
}

export function getMediaBadge(part: FileUIPart) {
  if (part.mediaType && part.mediaType !== "application/octet-stream") {
    return part.mediaType.replace(/^application\//, "").replace(/^text\//, "").toUpperCase()
  }

  return part.filename?.split(".").pop()?.toUpperCase() ?? null
}

export function getMessageCreated(message: UIMessage): number | null {
  const metadata: unknown = message.metadata
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return null

  const opencode: unknown = metadata.opencode
  if (!opencode || typeof opencode !== "object" || !("created" in opencode)) return null

  const created: unknown = opencode.created
  return typeof created === "number" ? created : null
}

export function formatMessageTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs)
  const now = new Date()
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

  if (date.toDateString() === now.toDateString()) {
    return time
  }

  const sameYear = date.getFullYear() === now.getFullYear()
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })

  return `${day}, ${time}`
}

export function isMessageGroup(item: MessageListItem): item is MessageGroup {
  return "messages" in item
}

export function groupMessages(messages: UIMessage[], status: ThreadStatus): MessageListItem[] {
  const items: MessageListItem[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]

    if (message.role !== "assistant") {
      items.push({ index, message })
      index++
      continue
    }

    const assistantMessages: UIMessageWithIndex[] = []

    while (index < messages.length && messages[index].role === "assistant") {
      assistantMessages.push({ message: messages[index], index });
      index++
    }

    items.push({ messages: assistantMessages });
  }

  return items
}

type AssistantRenderGroup =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; isStreaming: boolean }
  | { kind: "file"; part: FileUIPart }
  | { kind: "tools"; parts: Array<ToolUIPart | DynamicToolUIPart | ReasoningUIPart> }

/** Combine consecutive activity across engine messages, retaining prose boundaries. */
export function groupAssistantToolRuns(items: UIMessageWithIndex[], showThinking: boolean): UIMessageWithIndex[] {
  const result: UIMessageWithIndex[] = []
  let activity: UIMessageWithIndex | undefined
  for (const item of items) {
    let prose: UIMessageWithIndex | undefined
    for (const [index, part] of item.message.parts.entries()) {
      if (isReasoningUIPart(part) && !showThinking) continue
      if (part.type === "step-start") continue
      if (part.type === "text" && !part.text.trim()) {
        if (prose) prose.message.parts.push(part)
        continue
      }
      if (isToolUIPart(part) || isReasoningUIPart(part)) {
        prose = undefined
        if (!activity) {
          activity = { ...item, message: { ...item.message, id: `${item.message.id}:activity:${index}`, parts: [] } }
          result.push(activity)
        }
        activity.message.parts.push(part)
      } else {
        activity = undefined
        if (!prose) {
          prose = { ...item, message: { ...item.message, id: index ? `${item.message.id}:part:${index}` : item.message.id, parts: [] } }
          result.push(prose)
        }
        prose.message.parts.push(part)
      }
    }
  }
  return result
}

export function getAssistantRenderGroups(
  parts: UIMessage["parts"],
  showThinking: boolean
): AssistantRenderGroup[] {
  const filteredParts = parts.filter(
    (part) => showThinking || !isReasoningUIPart(part)
  )
  const groups: AssistantRenderGroup[] = []

  const appendText = (text: string) => {
    if (!text) {
      return
    }

    const previous = groups.at(-1)
    if (previous?.kind === "text") {
      previous.text += text
      return
    }

    groups.push({ kind: "text", text })
  }

  const appendReasoning = (part: UIMessage["parts"][number]) => {
    if (!isReasoningUIPart(part)) {
      return
    }

    const previous = groups.at(-1)
    if (previous?.kind === "tools") {
      previous.parts.push(part)
      return
    }
    if (previous?.kind === "reasoning") {
      previous.text += part.text
      previous.isStreaming = previous.isStreaming || part.state === "streaming"
      return
    }

    if (!part.text.trim()) {
      return
    }

    groups.push({ kind: "reasoning", text: part.text, isStreaming: part.state === "streaming" })
  }

  for (const part of filteredParts) {
    if (part.type === "text") {
      appendText(part.text)
      continue
    }

    if (isReasoningUIPart(part)) {
      if (showThinking) {
        appendReasoning(part)
      }
      continue
    }

    if (part.type === "file") {
      groups.push({ kind: "file", part })
      continue
    }

    if (isToolUIPart(part)) {
      const previous = groups.at(-1)
      if (previous?.kind === "tools") previous.parts.push(part)
      else if (previous?.kind === "reasoning") {
        groups.pop()
        groups.push({ kind: "tools", parts: [{ type: "reasoning", text: previous.text, state: previous.isStreaming ? "streaming" : "done" }, part] })
      }
      else groups.push({ kind: "tools", parts: [part] })
    }
  }

  return groups
}
