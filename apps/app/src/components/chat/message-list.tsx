"use memo";

import * as React from "react"
import {
  AlertTriangle,
  Check,
  Copy,
  FileIcon,
  LoaderCircle,
  Pencil,
  Split,
  Undo2,
} from "lucide-react"
import { PaperGrainGradient } from "@legalwork/ui/react"
import {
  DynamicToolUIPart,
  isFileUIPart,
  ToolUIPart,
  type FileUIPart,
  type UIMessage,
} from "ai"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { openDesktopUrl } from "@/app/lib/desktop"
import {
  EIGENWELT_FREE_LIMIT_BODY,
  EIGENWELT_FREE_LIMIT_TITLE,
  EIGENWELT_FREE_UPGRADE_LABEL,
  EIGENWELT_FREE_UPGRADE_URL,
  isEigenweltFreeLimitErrorText,
} from "@/app/lib/eigenwelt-free-budget"
import {
  eigenweltBudgetLimitDisplay,
  isEigenweltBudgetExceededErrorText,
  type EigenweltBudgetPlan,
} from "@/app/lib/eigenwelt-budget"
import { eigenweltBillingUrl } from "@/react-app/domains/connections/eigenwelt-entitlements"
import { eigenweltPremiumPlatformUrl } from "@/react-app/domains/recorder/model-tiers"
import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types"
import { ApplyPatchTool } from "@/components/tools/apply-patch"
import { BashTool } from "@/components/tools/bash"
import { EditTool } from "@/components/tools/edit"
import { EnvVarRequestTool } from "@/components/tools/env-var-request"
import { ReadFileTool, WriteFileTool } from "@/components/tools/file"
import { GlobTool } from "@/components/tools/glob"
import { GrepTool } from "@/components/tools/grep"
import { LegalMemoryActivityTool } from "@/components/tools/legalmemory-activity"
import { LegalMemoryGraphTool } from "@/components/tools/legalmemory-graph"
import { LegalMemorySourcesTool } from "@/components/tools/legalmemory-sources"
import { LspTool } from "@/components/tools/lsp"
import { QuestionTool } from "@/components/tools/question"
import { SkillTool } from "@/components/tools/skill"
import { TodoWriteTool } from "@/components/tools/todowrite"
import { WebfetchTool } from "@/components/tools/webfetch"
import { WebsearchTool } from "@/components/tools/websearch"
import { useMessageList, useSessionErrorMessage } from "@/components/chat/message-list-provider"
import { ArtifactList } from "@/components/chat/artifact"
import { TaskSuggestions } from "@/components/chat/task-suggestions"
import {
  DescriptiveButtonContent,
  DescriptiveButtonDescription,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Image } from "@/components/ui/image"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ui/message"
import { Tool } from "@/components/ui/tool"
import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isEnvVarRequestToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isLegalMemoryGraphToolPart,
  isLegalMemoryToolPart,
  isLegalMemorySearchToolPart,
  isLspToolPart,
  isQuestionToolPart,
  isReadToolPart,
  isSkillToolPart,
  isTodoWriteToolPart,
  isWebFetchToolPart,
  isWebSearchToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools"
import type { ThreadStatus } from "@/lib/messages"
import {
  collectToolParts,
  getActiveToolLabel,
} from "@/lib/tool-activity"
import { cn } from "@/lib/utils"
import { useOpenTargets } from "@/lib/target-provider"
import { resolveFilePartOpenTarget } from "@/react-app/domains/session/artifacts/open-target"
import { groupMessages, isMessageGroup, getLastTextPart, getAssistantRenderGroups, getFileTitle, getMediaBadge, getMessageCreated, formatMessageTimestamp, type UIMessageWithIndex, getMessagesText } from "./utils"

function MessageTimestamp({ message, className }: { message: UIMessage; className?: string }) {
  const created = getMessageCreated(message)
  if (created === null) return null

  return (
    <span
      className={cn(
        "select-none whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/70",
        className
      )}
      title={new Date(created).toLocaleString()}
    >
      {formatMessageTimestamp(created)}
    </span>
  )
}

interface ToolMessageProps {
  part: ToolUIPart | DynamicToolUIPart
}

/**
 * Error boundary around tool-part rendering. Tool inputs from streamed or
 * interrupted runs can violate their type contracts (partial/undefined
 * input); without this boundary a single bad part unmounts the entire app
 * (white screen). Seen in production on v0.15.3 via a todowrite part with
 * missing input.todos.
 */
class ToolMessage extends React.Component<ToolMessageProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error("[tool-part] render failed", error)
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="text-xs text-muted-foreground">Tool step unavailable</div>
      )
    }
    return <ToolMessageInner part={this.props.part} />
  }
}

const ToolMessageInner = ({ part }: ToolMessageProps) => {
  if (isBashToolPart(part)) {
    return <BashTool part={part} />
  }

  if (isEditToolPart(part)) {
    return <EditTool part={part} />
  }

  if (isWriteToolPart(part)) {
    return <WriteFileTool part={part} />
  }

  if (isReadToolPart(part)) {
    return <ReadFileTool part={part} />
  }

  if (isGrepToolPart(part)) {
    return <GrepTool part={part} />
  }

  if (isGlobToolPart(part)) {
    return <GlobTool part={part} />
  }

  if (isLspToolPart(part)) {
    return <LspTool part={part} />
  }

  if (isApplyPatchToolPart(part)) {
    return <ApplyPatchTool part={part} />
  }

  if (isSkillToolPart(part)) {
    return <SkillTool part={part} />
  }

  if (isTodoWriteToolPart(part)) {
    return <TodoWriteTool part={part} />
  }

  if (isWebFetchToolPart(part)) {
    return <WebfetchTool part={part} />
  }

  if (isWebSearchToolPart(part)) {
    return <WebsearchTool part={part} />
  }

  if (isQuestionToolPart(part)) {
    return <QuestionTool part={part} />
  }

  if (isEnvVarRequestToolPart(part)) {
    return <EnvVarRequestTool part={part} />
  }

  // A running LegalMemory call gets a line saying what it is doing; finished
  // calls fall through to their own card, or to the generic one.
  if (isLegalMemoryToolPart(part) && part.state !== "output-available" && part.state !== "output-error") {
    return <LegalMemoryActivityTool part={part} />
  }

  if (isLegalMemoryGraphToolPart(part)) {
    return <LegalMemoryGraphTool part={part} />
  }

  if (isLegalMemorySearchToolPart(part)) {
    return <LegalMemorySourcesTool part={part} />
  }

  return <Tool toolPart={part} />
}

const isEmptyMessage = (message: UIMessage): boolean => message.parts.length === 0

type RetryStatus = Extract<SessionStatus, { type: "retry" }>
const EigenweltBudgetPlanContext = React.createContext<EigenweltBudgetPlan>(null)

function isSessionErrorMessage(message: UIMessage) {
  return message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX)
}

function retryDelaySeconds(status: RetryStatus) {
  return Math.max(0, Math.round((status.next - Date.now()) / 1000))
}

interface FileMessageProps {
  part: FileUIPart
  tone: "user" | "assistant"
}

// TODO: Add tone to the file message
function FileMessage({ part }: FileMessageProps) {
  const { openTargets, onOpenTarget } = useOpenTargets()
  const title = getFileTitle(part)
  const badge = getMediaBadge(part)
  const isImage = part.mediaType.startsWith("image/") && part.url

  if (isImage) {
    return (
      <Image
        src={part.url}
        alt={title}
        loading="lazy"
        decoding="async"
      />
    )
  }

  // Resolve the badge to the underlying file. Clicking opens it — the handler
  // picks the in-app viewer when the type is supported and the system default
  // app otherwise.
  const openTarget = onOpenTarget ? resolveFilePartOpenTarget(part, openTargets) : null

  const inner = (
    <>
      <DescriptiveButtonIcon>
        <FileIcon className="size-6 shrink-0" />
      </DescriptiveButtonIcon>
      <DescriptiveButtonContent className="gap-0">
        <DescriptiveButtonTitle>{title}</DescriptiveButtonTitle>
        {badge ? (
          <DescriptiveButtonDescription className="text-xs">
            {badge}
          </DescriptiveButtonDescription>
        ) : null}
      </DescriptiveButtonContent>
    </>
  )

  const baseClassName =
    "flex h-auto w-fit min-w-0 max-w-full shrink items-center justify-start gap-2 rounded-xl border border-border ps-2 pe-4 py-1 text-left text-sm font-medium whitespace-normal"

  // Always render the badge as a clickable button. A file mention always gets an
  // interactive badge.
  if (onOpenTarget) {
    return (
      <button
        type="button"
        onClick={() => {
          if (openTarget) onOpenTarget(openTarget)
        }}
        title={`Open ${title}`}
        className={cn(baseClassName, "cursor-pointer transition-colors hover:bg-muted/60")}
      >
        {inner}
      </button>
    )
  }

  return <div className={baseClassName}>{inner}</div>
}

function EmptyMessage({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10 text-muted-foreground",
        className
      )}
      {...props}
    >
      Empty message
    </div>
  )
}

interface CopyMessageButtonProps {
  messages: UIMessage[]
}

function CopyMessageButton({ messages }: CopyMessageButtonProps) {
  const [copied, setCopied] = React.useState(false)
  const text = React.useMemo(() => getMessagesText(messages), [messages])

  const onCopy = React.useCallback(async () => {
    if (!text) {
      return
    }

    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore clipboard failures
    }
  }, [text])

  if (!text) {
    return null
  }

  return (
    <MessageAction tooltip={copied ? "Copied!" : "Copy"}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Copy message"
        onClick={() => void onCopy()}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </MessageAction>
  )
}

type AssistantMessageProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
}

const AssistantMessage = React.memo(
  ({ message }: AssistantMessageProps) => {
    const { showThinking } = useMessageList()
    const assistantRenderGroups = React.useMemo(
      () => getAssistantRenderGroups(message.parts, showThinking),
      [message.parts, showThinking]
    )

    return (
      <Message
        className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <div className="group flex w-full flex-col gap-0 space-y-2">
          {assistantRenderGroups.map((group, index) => {
            if (group.kind === "text") {
              return (
                <MessageContent
                  key={`text-${index}`}
                  className="text-foreground prose w-full min-w-0 flex-1 rounded-lg bg-transparent p-0"
                  markdown
                >
                  {group.text}
                </MessageContent>
              )
            }

            if (group.kind === "reasoning") {
              return (
                <MessageContent
                  key={`reasoning-${index}`}
                  // chat-reasoning is an unstyled hook so embedders can
                  // target reasoning output (the Office pane hides it).
                  className="chat-reasoning text-muted-foreground prose w-full min-w-0 flex-1 rounded-lg bg-transparent p-0"
                  markdown
                >
                  {group.text}
                </MessageContent>
              )
            }

            if (group.kind === "file") {
              return (
                <div key={`file-${index}`} className="w-full">
                  <FileMessage part={group.part} tone="assistant" />
                </div>
              )
            }

            return (
              <div key={`tool-${index}`} className="w-full">
                <ToolMessage part={group.part} />
              </div>
            )
          })}
        </div>
      </Message>
    )
  }
)

AssistantMessage.displayName = "AssistantMessage"

type UserMessageProps = {
  message: UIMessage
  isStreaming: boolean
}

const USER_SKILL_TOKEN_RE = /(Load \[skill [^\]]+\] and follow its instructions\.|\[skill [^\]]+\])/

function UserSkillChip(props: { name: string }) {
  return (
    <span className="mx-0.5 inline-flex items-center rounded-full border border-violet-6/35 bg-violet-3/20 px-2.5 py-1 text-xs font-medium text-violet-11 align-middle" title={`Skill: ${props.name}`}>
      {props.name}
    </span>
  )
}

function renderUserTextWithSkillChips(text: string) {
  if (!USER_SKILL_TOKEN_RE.test(text)) return text
  let offset = 0
  return text.split(USER_SKILL_TOKEN_RE).map((segment) => {
    const key = `${offset}:${segment}`
    offset += segment.length
    const skillMatch = segment.match(/^(?:Load )?\[skill ([^\]]+)\](?: and follow its instructions\.)?$/)
    if (skillMatch?.[1]) return <UserSkillChip key={key} name={skillMatch[1]} />
    return <React.Fragment key={key}>{segment}</React.Fragment>
  })
}

const UserMessage = React.memo(
  ({ message, isStreaming }: UserMessageProps) => {
    const { onRevertToUserMessage, onForkAtMessage, onEditUserMessage } = useMessageList()
    const messageText = React.useMemo(() => getMessagesText([message]), [message])

    return (
      <Message
        className="mx-auto flex w-full max-w-3xl flex-col items-end gap-2 px-2 md:px-10"
        data-message-id={message.id}
        data-message-role={message.role}
      >
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div className="group flex w-full flex-col items-end gap-1">
                {message.parts.filter(isFileUIPart).map((part, index) => (
                  <FileMessage key={`${part.url}-${index}`} part={part} tone="user" />
                ))}
                {message.parts.some((part) => part.type === "text" && part.text) ? (
                  <MessageContent
                    layoutId={message.id}
                    className="bg-foreground/[0.06] text-foreground max-w-[85%] rounded-3xl px-5 py-2.5 whitespace-pre-wrap sm:max-w-[75%]"
                  >
                    {renderUserTextWithSkillChips(message.parts.map((part) => (part.type === "text" ? part.text : "")).join(""))}
                  </MessageContent>
                ) : null}
                {!isStreaming && (
                  <MessageActions
                    className={cn(
                      "flex items-center gap-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                    )}
                  >
                    <MessageTimestamp message={message} className="mr-1.5" />
                    <CopyMessageButton messages={[message]} />
                    {messageText ? (
                      <MessageAction tooltip="Edit message">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Edit message"
                          onClick={() => onEditUserMessage(message.id, messageText)}
                        >
                          <Pencil />
                        </Button>
                      </MessageAction>
                    ) : null}
                    <MessageAction tooltip="Branch in new chat">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Branch in new chat"
                        onClick={() => onForkAtMessage(message.id)}
                      >
                        <Split className="rotate-90" />
                      </Button>
                    </MessageAction>
                    <MessageAction tooltip="Revert">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Revert"
                        onClick={() => onRevertToUserMessage(message.id)}
                      >
                        <Undo2 />
                      </Button>
                    </MessageAction>
                  </MessageActions>
                )}
              </div>
            }
          />
          <ContextMenuContent className="w-56">
            {messageText ? (
              <ContextMenuItem onClick={() => onEditUserMessage(message.id, messageText)}>
                <Pencil className="size-4" />
                Edit message
              </ContextMenuItem>
            ) : null}
            {messageText ? (
              <ContextMenuItem onClick={() => void navigator.clipboard.writeText(messageText)}>
                <Copy className="size-4" />
                Copy
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onClick={() => onForkAtMessage(message.id)}>
              <Split className="size-4 rotate-90" />
              Branch in new chat
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onRevertToUserMessage(message.id)}>
              <Undo2 className="size-4" />
              Revert
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Message>
    )
  }
)

UserMessage.displayName = "UserMessage"

type MessageComponentProps = {
  message: UIMessage
  isLastMessage: boolean
  isStreaming: boolean
  isLastStep: boolean
}

const MessageComponent = React.memo(
  ({ message, isLastMessage, isStreaming, isLastStep }: MessageComponentProps) => {
    if (isSessionErrorMessage(message)) {
      return <ErrorMessage error={getMessagesText([message]) || "Session failed"} />
    }

    if (isEmptyMessage(message) && !isStreaming) {
      return (
        <EmptyMessage
          data-message-id={message.id}
          data-message-role={message.role}
        />
      )
    }

    if (message.role === "assistant") {
      return (
        <AssistantMessage
          message={message}
          isLastMessage={isLastMessage}
          isStreaming={isStreaming}
          isLastStep={isLastStep}
        />
      )
    }

    return (
      <UserMessage
        message={message}
        isStreaming={isStreaming}
      />
    )
  }
)

MessageComponent.displayName = "MessageComponent"

const LoadingMessage = React.memo(({ label }: { label?: string }) => (
  <Message className="mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-2 md:px-10">
    <div className="group flex w-full flex-col gap-0">
      <div className="flex items-center gap-1.5 px-1 py-1 text-sm text-muted-foreground">
        <div style={{ width: 20, height: 20, borderRadius: "50%", overflow: "hidden" }}>
          <PaperGrainGradient
            speed={12}
            softness={0.1}
            intensity={1}
            noise={0.05}
            shape="sphere"
            colors={["#818cf8", "#fb7185", "#fbbf24", "#34d399"]}
            colorBack="#ffffff00"
            style={{ backgroundColor: "#818cf8", width: "100%", height: "100%", borderRadius: "50%" }}
          />
        </div>
        <span>{label ?? "Thinking…"}</span>
      </div>
    </div>
  </Message>
))

LoadingMessage.displayName = "LoadingMessage"

interface ErrorMessageProps {
  error: string | null
}

function ErrorMessage({ error }: ErrorMessageProps) {
  const eigenweltPlan = React.useContext(EigenweltBudgetPlanContext)
  if (isEigenweltFreeLimitErrorText(error)) {
    return <FreeLimitReachedMessage />
  }
  if (isEigenweltBudgetExceededErrorText(error)) {
    return <BudgetExceededMessage plan={eigenweltPlan} />
  }
  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="text-foreground flex min-w-0 flex-1 flex-row items-start gap-2 rounded-lg border-2 border-red-300 bg-red-300/20 px-2 py-1">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-destructive" />
          <p className="whitespace-pre-wrap text-destructive">{error}</p>
        </div>
      </div>
    </Message>
  )
}

/**
 * Terminal card for an Eigenwelt free-tier daily-limit stop (the app aborts
 * the run after the allowed retries — see app/lib/eigenwelt-free-budget).
 * Flat, lined border; friendly copy — the state resolves by upgrading or by
 * waiting for tomorrow's allowance.
 */
function FreeLimitReachedMessage() {
  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="flex w-full min-w-0 flex-col gap-2 rounded-lg border border-dls-border bg-dls-surface px-4 py-3">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">
              {EIGENWELT_FREE_LIMIT_TITLE}
            </p>
            <p className="text-sm text-muted-foreground">{EIGENWELT_FREE_LIMIT_BODY}</p>
          </div>
        </div>
        <div className="ml-6">
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => void openDesktopUrl(EIGENWELT_FREE_UPGRADE_URL)}
          >
            {EIGENWELT_FREE_UPGRADE_LABEL}
          </Button>
        </div>
      </div>
    </Message>
  )
}

/**
 * Terminal card for an Eigenwelt budget stop (the app aborts the run after
 * the allowed retries — see app/lib/eigenwelt-budget). Plus can upgrade to
 * Pro; Pro sees the reached limit without another upsell.
 */
function BudgetExceededMessage({ plan }: { plan: EigenweltBudgetPlan }) {
  const display = eigenweltBudgetLimitDisplay(plan)
  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="flex w-full min-w-0 flex-col gap-2 rounded-lg border border-dls-border bg-dls-surface px-4 py-3">
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-foreground">
              {display.title}
            </p>
            <p className="text-sm text-muted-foreground">{display.body}</p>
          </div>
        </div>
        {display.upgradeLabel ? (
          <div className="ml-6">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void openDesktopUrl(eigenweltBillingUrl(eigenweltPremiumPlatformUrl()))}
            >
              {display.upgradeLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </Message>
  )
}

interface RetryMessageProps {
  status: RetryStatus
}

function RetryActionButton(props: { link: string; label: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 border-amber-500/70 bg-amber-50 text-xs text-amber-950 hover:bg-amber-100"
      onClick={() => void openDesktopUrl(props.link)}
    >
      {props.label}
    </Button>
  )
}

const RetryMessage = React.memo(({ status }: RetryMessageProps) => {
  const [seconds, setSeconds] = React.useState(() => retryDelaySeconds(status))

  React.useEffect(() => {
    const update = () => setSeconds(retryDelaySeconds(status))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [status])

  const info = seconds > 0
    ? `Retrying in ${seconds}s · attempt ${status.attempt}`
    : `Retrying · attempt ${status.attempt}`
  const action = status.action

  return (
    <Message className="not-prose mx-auto flex w-full max-w-3xl flex-col items-start gap-2 px-0 md:px-10">
      <div className="group flex w-full flex-col items-start gap-0">
        <div className="text-foreground flex min-w-0 flex-1 flex-col gap-2 rounded-lg border-2 border-amber-300 bg-amber-300/20 px-3 py-2">
          <div className="flex items-start gap-2">
            <LoaderCircle size={16} className="mt-0.5 shrink-0 animate-spin text-amber-700" />
            <div className="min-w-0 space-y-1">
              <p className="whitespace-pre-wrap text-sm font-medium text-amber-900">{status.message}</p>
              <p className="text-xs text-amber-800">{info}</p>
            </div>
          </div>
          {action ? (
            <div className="ml-6 space-y-1 border-t border-amber-400/60 pt-2">
              <p className="text-xs font-medium text-amber-950">{action.title}</p>
              <p className="text-xs text-amber-900">{action.message}</p>
              {action.link ? (
                <RetryActionButton link={action.link} label={action.label} />
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Message>
  )
})

RetryMessage.displayName = "RetryMessage"

const isMessageEmptyGroup = (messages: UIMessageWithIndex[]) =>
  messages.every(message => isEmptyMessage(message.message));

const getRenderableMessages = (messages: UIMessageWithIndex[]) =>
  messages.flatMap((item) => {
    const renderableMessage = getRenderableMessage(item.message);

    return renderableMessage ? [{ ...item, message: renderableMessage }] : []
  })

function getRenderableMessage(message: UIMessage) {
  const parts = message.parts.filter((part) => part.type === "text" || part.type === "file");

  return parts.length > 0 ? { ...message, parts } : null;
}

function MessageArtifacts(props: { message: UIMessage }) {
  return <ArtifactList messages={[props.message]} includeTargetFallbacks={false} />;
}

interface AssistantMessageGroupProps {
  items: UIMessageWithIndex[]
  messages: UIMessage[]
  isStreaming: boolean
}

function MessageGroup({
  items,
  messages,
  isStreaming,
}: AssistantMessageGroupProps) {
  const { onRevertToUserMessage, onForkAtMessage } = useMessageList()
  const lastItem = items[items.length - 1]
  // Branch/revert must target a real server-side message id. Synthetic
  // client-side messages (e.g. session errors) don't exist on the server and
  // silently corrupt fork/revert boundaries.
  const lastRealItem = items.findLast((item) => !isSessionErrorMessage(item.message))
  const isLiveGroup = isStreaming && lastItem !== undefined && lastItem.index === messages.length - 1
  const stepsRef = React.useRef<HTMLDivElement>(null)

  // Keep the capped step run pinned to the latest step while streaming.
  React.useEffect(() => {
    const node = stepsRef.current
    if (node && isLiveGroup) {
      node.scrollTop = node.scrollHeight
    }
  })

  if (!lastItem || isMessageEmptyGroup(items)) {
    if (isStreaming) {
      return null;
    }

    return <EmptyMessage />
  }

  const renderableItems = getRenderableMessages(items)
  const lastTextMessage = getLastTextPart(lastItem.message)

  // Leading messages without prose (tool/reasoning steps) render inside a
  // height-capped scroll area so long runs stay compact; messages with text
  // or files render inline below it.
  let stepCount = 0
  while (stepCount < items.length && !getRenderableMessage(items[stepCount].message)) {
    stepCount += 1
  }
  const stepItems = items.slice(0, stepCount)
  const proseItems = items.slice(stepCount)

  const renderItem = (item: UIMessageWithIndex, groupIndex: number) => {
    const isLastMessage = item.index === messages.length - 1

    return (
      <div key={item.message.id}>
        <MessageComponent
          message={item.message}
          isLastMessage={isLastMessage}
          isStreaming={isLastMessage && isStreaming}
          isLastStep={groupIndex === items.length - 1}
        />
        <MessageArtifacts message={item.message} />
      </div>
    )
  }

  return (
      <div className="flex flex-col gap-2 group/message-group">
      {stepItems.length > 0 ? (
        // data-scrollable: the transcript's scroll controller must not treat
        // gestures inside this nested scroller as transcript browsing, or
        // autoscroll disengages whenever the user wheels over tool output.
        <div ref={stepsRef} data-scrollable className="max-h-[520px] overflow-y-auto">
          {stepItems.map((item, groupIndex) => renderItem(item, groupIndex))}
        </div>
      ) : null}
      {proseItems.map((item, groupIndex) => renderItem(item, stepItems.length + groupIndex))}
      {lastTextMessage && !isStreaming && (
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-2 px-2 opacity-0 transition-opacity duration-150 group-hover/message-group:opacity-100 md:px-8">
          <MessageActions className="flex gap-0">
            <CopyMessageButton messages={renderableItems.map((item) => item.message)} />
            {lastRealItem ? (
              <>
                <MessageAction tooltip="Branch in new chat">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Branch in new chat"
                    onClick={() => onForkAtMessage(lastRealItem.message.id)}
                  >
                    <Split className="rotate-90" />
                  </Button>
                </MessageAction>
                <MessageAction tooltip="Revert">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Revert"
                    onClick={() => onRevertToUserMessage(lastRealItem.message.id)}
                  >
                    <Undo2 />
                  </Button>
                </MessageAction>
              </>
            ) : null}
          </MessageActions>
          <MessageTimestamp message={lastItem.message} />
          {/* <MessageSources messages={items.map((item) => item.message)} /> */}
        </div>
      )}
      {renderableItems.length === 0 && !isStreaming ? <EmptyMessage /> : null}
      </div>
  )
}

interface MessageListProps {
  eigenweltPlan?: EigenweltBudgetPlan
  messages: UIMessage[]
  status: ThreadStatus
  retryStatus?: RetryStatus | null
}

export function MessageList({ eigenweltPlan = null, messages, status, retryStatus }: MessageListProps) {
  const isStreaming = status === "streaming" || status === "retrying"
  const items = React.useMemo(() => groupMessages(messages, status), [messages, status]);
  const error = useSessionErrorMessage();
  const hasSessionErrorMessage = React.useMemo(() => messages.some(isSessionErrorMessage), [messages])
  const liveActionLabel = isStreaming
    ? getActiveToolLabel(collectToolParts(messages))
    : null

  return (
    <EigenweltBudgetPlanContext.Provider value={eigenweltPlan}>
    <div className={cn("flex flex-col gap-2 @container/message-list")}>
      {messages.length === 0 && <TaskSuggestions className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-3 md:px-5 md:pb-5 grow" />}

      {items.map((item) => {
        if (isMessageGroup(item)) {
          const key = item.messages[0]?.message.id ?? "empty-assistant-group"
          return (
            <MessageGroup
              key={key}
              items={item.messages}
              messages={messages}
              isStreaming={isStreaming}
            />
          )
        }

        const isLastMessage = item.index === messages.length - 1
        const isLastStep =
          !messages[item.index + 1] || messages[item.index + 1].role !== item.message.role

        return (
          <div key={item.message.id}>
            <MessageComponent
              message={item.message}
              isLastMessage={isLastMessage}
              isStreaming={isLastMessage && isStreaming}
              isLastStep={isLastStep}
            />
            <MessageArtifacts message={item.message} />
          </div>
        )
      })}

      {status === "streaming" && <LoadingMessage label={liveActionLabel ?? undefined} />}
      {retryStatus ? <RetryMessage status={retryStatus} /> : null}
      {error && !hasSessionErrorMessage ? <ErrorMessage error={error} /> : null}
    </div>
    </EigenweltBudgetPlanContext.Provider>
  )
}
