import { useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, FileText, Folder, Loader2, Paperclip, Plus, X } from "lucide-react";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import type { ModelRef } from "@/app/types";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ModelSelect } from "@/components/model-select";
import { ModelBehaviorSelect } from "@/components/model-behavior-select";
import { TaskSuggestionCards } from "@/components/chat/task-suggestions";
import { WelcomeSurface } from "@/components/chat/session-welcome";
import { t } from "@/i18n";
import "./app-home.css";

export type AppHomeProps = {
  workspaces: WorkspaceInfo[];
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
  onCreateProject: () => void;
  onSend: (text: string, files: File[]) => Promise<void>;
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
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const sendingRef = useRef(false);
  const project = props.workspaces.find((workspace) => workspace.id === props.projectId);
  const busy = props.disabled || sending;
  const canSend = !busy && Boolean(text.trim() || files.length);
  useEffect(() => {
    if (!props.disabled) promptInput.current?.focus();
  }, [props.disabled]);
  const addFiles = (incoming: File[]) => {
    if (busy) return;
    setFiles((current) => [...current, ...incoming.filter((file) => !current.includes(file))]);
  };
  const send = async () => {
    if (!canSend || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await props.onSend(text, files);
      setText("");
      setFiles([]);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("home.send_failed"));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  return (
    <div className="lw-app-home" data-testid="app-home">
      <div className="lw-app-home-content">
        <WelcomeSurface replayKey="app-home">
          <form aria-label={t("home.start_chat")} aria-busy={sending} onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <div className="lw-home-composer" onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }} onDrop={(event) => {
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              addFiles(Array.from(event.dataTransfer.files));
            }}>
              <textarea ref={promptInput} autoFocus aria-label={t("home.prompt_label")} placeholder={t("home.placeholder")} value={text} disabled={busy} rows={3} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }} onPaste={(event) => {
                if (!event.clipboardData.files.length) return;
                event.preventDefault();
                addFiles(Array.from(event.clipboardData.files));
              }} />
              {files.length ? <ul className="lw-home-attachments" aria-label={t("home.attached_files")}>
                {files.map((file, index) => <li key={`${index}-${file.name}`}>
                  <FileText size={15} aria-hidden="true" /><span title={file.name}>{file.name}</span>
                  <Button type="button" variant="ghost" size="icon-xs" disabled={busy} aria-label={t("home.remove_file", { name: file.name })} onClick={() => setFiles((current) => current.filter((_, item) => item !== index))}><X size={13} /></Button>
                </li>)}
              </ul> : null}
              <div className="lw-home-composer-controls">
                <Button type="button" variant="ghost" size="icon" disabled={busy} aria-label={t("home.add_files")} onClick={() => fileInput.current?.click()}><Plus size={23} /></Button>
                <div className="lw-home-model-controls">
                  {props.selectedModel ? <>
                    <ModelSelect open={modelOpen} value={props.selectedModel} onOpenChange={setModelOpen} onChange={props.onModelChange} locked={props.modelLocked} disabled={busy} />
                    <ModelBehaviorSelect value={props.modelVariant} label={props.modelVariantLabel} options={props.modelBehaviorOptions} onChange={props.onModelVariantChange} disabled={busy} />
                  </> : <Button type="button" variant="ghost" disabled={busy} onClick={props.onConnect}>{t("task_suggestions.connect_provider")}</Button>}
                  <Button type="submit" size="icon" className="lw-home-send" disabled={!canSend} aria-label={t("home.send")}>
                    {sending ? <Loader2 className="animate-spin" size={19} /> : <ArrowUp size={20} />}
                  </Button>
                </div>
              </div>
            </div>
            <div className="lw-home-project-bar">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button type="button" variant="ghost" disabled={busy} className="lw-home-project-picker" />}>
                  <Folder size={18} /><span>{project ? project.displayName || project.name : t("home.choose_project")}</span><ChevronDown size={14} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-80 min-w-64 overflow-y-auto">
                  <DropdownMenuItem onClick={props.onCreateProject}><Plus size={16} />{t("home.new_project")}</DropdownMenuItem>
                  {props.workspaces.length ? <DropdownMenuSeparator /> : null}
                  {props.workspaces.map((workspace) => <DropdownMenuItem key={workspace.id} onClick={() => props.onProjectChange(workspace.id)}><Folder size={16} /><span className="truncate">{workspace.displayName || workspace.name}</span></DropdownMenuItem>)}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip size={17} />{t("home.files")}</Button>
              <span className="lw-home-project-hint">{project ? t("home.existing_project_hint") : t("home.new_project_hint")}</span>
            </div>
            <input ref={fileInput} className="sr-only" type="file" multiple tabIndex={-1} aria-label={t("home.add_files")} disabled={busy} onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
            {error ? <p role="alert" className="lw-home-error">{error}</p> : null}
          </form>
          <TaskSuggestionCards className="lw-home-suggestions" providerConnectedCount={props.providerConnectedCount} onConnect={props.onConnect} onSelect={(prompt) => { if (!busy) { setText(prompt); promptInput.current?.focus(); } }} />
        </WelcomeSurface>
      </div>
    </div>
  );
}
