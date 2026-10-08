import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Folder, Paperclip, Plus } from "lucide-react";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import { AssistantAvatar } from "../sidebar/assistant-appearance";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import type { ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ModelSelect } from "@/components/model-select";
import { ModelBehaviorSelect } from "@/components/model-behavior-select";
import { TaskSuggestionCards } from "@/components/chat/task-suggestions";
import { WelcomeSurface } from "@/components/chat/session-welcome";
import { MessageContent } from "@/components/ui/message";
import { PendingStatus } from "@/components/chat/pending-status";
import { LexicalPromptEditor } from "../surface/composer/editor";
import { activeHomeAttachments, hasHomeFileDrop, homeAttachmentToken, readHomeFileReference, replaceHomeAttachmentTokens, stageHomeAttachment, type HomeDraftAttachment, type HomeFileReference } from "./home-attachments";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import "./app-home.css";

export type AppHomeProps = {
  workspaces: WorkspaceInfo[];
  projectId: string | null;
  assistantProfile?: AssistantProfile;
  onProjectChange: (id: string | null) => void;
  onCreateProject: () => void;
  onSend: (text: string, attachments: HomeDraftAttachment[]) => Promise<void>;
  disabled: boolean;
  providerConnectedCount: number;
  onConnect: () => void;
  selectedModel: ModelRef | null;
  modelLocked: boolean;
  onModelChange: (model: ModelRef) => void;
  modelVariant: string | null;
  modelVariantLabel: string;
  modelBehaviorOptions: { value: string | null; label: string }[];
  onModelVariantChange: (variant: string | null) => void;
};

export function AppHome(props: AppHomeProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<HomeDraftAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const project = props.workspaces.find((workspace) => workspace.id === props.projectId);
  const assistantName = props.assistantProfile?.name ?? t("assistant.title");
  const busy = props.disabled || sending;
  const canSend = !busy && Boolean(text.trim());
  const mentions = Object.fromEntries(attachments.map(({ value, kind }) => [value, kind]));
  const focusPrompt = () => root.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
  useEffect(() => {
    if (!props.disabled && !sending) focusPrompt();
  }, [props.disabled, sending]);

  const addAttachments = (incoming: (File | HomeFileReference)[]) => {
    if (busy || sendingRef.current) return;
    const staged = incoming.map(stageHomeAttachment);
    setAttachments((current) => [...current, ...staged.filter((item) => !current.some((existing) => existing.value === item.value))]);
    setText((current) => `${current}${current && !/\s$/.test(current) ? " " : ""}${staged.map(homeAttachmentToken).join(" ")} `);
    requestAnimationFrame(focusPrompt);
  };
  const send = async () => {
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setDragging(false);
    setError(null);
    try {
      // Keep the submitted view until navigation has a populated conversation.
      await props.onSend(text, activeHomeAttachments(text, attachments));
    } catch (error) {
      setError(error instanceof Error ? error.message : t("home.send_failed"));
      sendingRef.current = false;
      setSending(false);
    }
  };

  const editor = <LexicalPromptEditor
    value={sending ? "" : text} mentions={mentions} disabled={busy}
    placeholder={t("home.placeholder")} ariaLabel={t("home.prompt_label")} onChange={setText} onSubmit={send}
    onPaste={(event) => {
      if (!event.clipboardData.files.length) return;
      event.preventDefault();
      addAttachments(Array.from(event.clipboardData.files));
    }}
  />;
  const controls = <div className="lw-home-composer-controls">
    <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={t("home.add_files")} onClick={() => fileInput.current?.click()}><Plus size={23} /></Button>
    <div className="lw-home-model-controls">
      {props.selectedModel ? <>
        <ModelSelect open={modelOpen} value={props.selectedModel} onOpenChange={setModelOpen} onChange={props.onModelChange} locked={props.modelLocked} disabled={busy} />
        <ModelBehaviorSelect value={props.modelVariant} label={props.modelVariantLabel} options={props.modelBehaviorOptions} onChange={props.onModelVariantChange} disabled={busy} />
      </> : <Button type="button" variant="ghost" disabled={busy} onClick={props.onConnect}>{t("task_suggestions.connect_provider")}</Button>}
      <Button type="button" size="icon" className="lw-home-send" disabled={!canSend} onClick={() => void send()} aria-label={t("home.send")}><ArrowUp size={20} /></Button>
    </div>
  </div>;

  if (sending) {
    const displayText = replaceHomeAttachmentTokens(text, attachments, ({ source }) => source instanceof File ? source.name : source.file.name);
    return (
      <div ref={root} className="lw-home-sending lw-session-typography" data-testid="home-sending" aria-busy="true">
        <div className="lw-home-pending-transcript px-4 py-4 md:px-8">
          <div className="lw-session-column">
            <div className="flex w-full flex-col items-end gap-2" data-message-role="user">
              <MessageContent className={cn("text-foreground max-w-[85%] rounded-3xl px-5 py-2.5 whitespace-pre-wrap sm:max-w-[75%]", props.projectId ? "bg-foreground/[0.06]" : "bg-blue-3")}>{displayText.trim()}</MessageContent>
            </div>
            <div className="mt-6"><PendingStatus label={t("home.sending_message")} /></div>
          </div>
        </div>
        <div className="lw-home-pending-composer px-4 md:px-8"><div className="lw-session-column lw-home-composer">{editor}{controls}</div></div>
      </div>
    );
  }

  return (
    <div ref={root} className="lw-app-home" data-testid="app-home">
      <div className="lw-app-home-content">
        <WelcomeSurface replayKey="app-home">
          <form aria-label={t("home.start_chat")} onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <div className="lw-home-composer" data-dragging={dragging || undefined} onDragOver={(event) => {
              if (!hasHomeFileDrop(event.dataTransfer)) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = busy ? "none" : "copy";
              setDragging(!busy);
            }} onDragLeave={(event) => {
              if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
            }} onDrop={(event) => {
              if (!hasHomeFileDrop(event.dataTransfer)) return;
              event.preventDefault();
              event.stopPropagation();
              setDragging(false);
              const reference = readHomeFileReference(event.dataTransfer);
              addAttachments(reference ? [reference] : Array.from(event.dataTransfer.files));
            }}>
              {editor}
              {controls}
            </div>
            <div className="lw-home-project-bar">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button type="button" variant="ghost" disabled={busy} className="lw-home-project-picker" />}>
                  {project ? <Folder size={18} /> : <AssistantAvatar icon={props.assistantProfile?.icon} />}<span>{project ? project.displayName || project.name : assistantName}</span><ChevronDown size={14} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 min-w-64 overflow-y-auto">
                  <DropdownMenuItem onClick={() => props.onProjectChange(null)}><AssistantAvatar icon={props.assistantProfile?.icon} />{assistantName}</DropdownMenuItem>
                  <DropdownMenuItem onClick={props.onCreateProject}><Plus size={16} />{t("home.new_project")}</DropdownMenuItem>
                  {props.workspaces.length ? <DropdownMenuSeparator /> : null}
                  {props.workspaces.map((workspace) => <DropdownMenuItem key={workspace.id} onClick={() => props.onProjectChange(workspace.id)}><Folder size={16} /><span className="truncate">{workspace.displayName || workspace.name}</span></DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip size={17} />{t("home.files")}</Button>
              <span className="lw-home-project-hint">{project ? t("home.existing_project_hint") : t("home.assistant_hint", { name: assistantName })}</span>
            </div>
            <input ref={fileInput} className="sr-only" type="file" multiple tabIndex={-1} aria-label={t("home.add_files")} disabled={busy} onChange={(event) => { addAttachments(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            {error ? <p role="alert" className="lw-home-error">{error}</p> : null}
          </form>
          <TaskSuggestionCards className="lw-home-suggestions" providerConnectedCount={props.providerConnectedCount} onConnect={props.onConnect} onSelect={(prompt) => { if (!busy) { setText(prompt); requestAnimationFrame(focusPrompt); } }} />
        </WelcomeSurface>
      </div>
    </div>
  );
}
