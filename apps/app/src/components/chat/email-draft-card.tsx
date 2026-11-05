import { artifactDocumentKey, registerUnsavedDocument } from "@/react-app/domains/session/artifacts/docx-document-state";
import { useEffect, useId, useRef, useState } from "react";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, ChevronDown, Download, FileText, Loader2, Mail, Paperclip, SlidersHorizontal, X } from "lucide-react";
import { EmailDraftSchema, emailAddressSpecs, type EmailDraft } from "@legalwork/types/email-draft";
import { composeAppleMailDraft, composeOutlookDraft, openDesktopUrl } from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Surface } from "@/react-app/design-system/surface";
import { InlineCard, InlineCardFooter, InlineCardHeader } from "./inline-card";
import { useMessageList } from "./message-list-provider";
import { emailComposeLink, type EmailApp } from "./email-draft-links";
import { ConnectorDraftActions, connectorDraftTool, draftToolPayload } from "./connector-draft-actions";

export function isEmailDraftTool(part: ToolUIPart | DynamicToolUIPart) {
  return ["legalwork_email_draft", "legalwork_email_draft_update"].includes(getToolName(part)) || connectorDraftTool(part, "email");
}
export function parseEmailDraftCard(output: unknown) {
  try {
    const payload = draftToolPayload(output);
    const parsed = EmailDraftSchema.safeParse(payload && typeof payload === "object" && "draft" in payload ? payload.draft : null);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function EmailDraftToolCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  if (part.state !== "output-available" && part.state !== "output-error") return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Preparing email draft…</p>;
  const initial = part.state === "output-available" ? parseEmailDraftCard(part.output) : null;
  return initial ? <EmailDraftCard key={initial.id} initial={initial} /> : <p role="alert" className="text-sm text-destructive">Could not create the email draft.</p>;
}

function EmailDraftCard({ initial }: { initial: EmailDraft }) {
  const { legalworkClient: client, workspaceId, sessionId } = useMessageList();
  const cache = useQueryClient();
  const key = ["email-draft", client?.baseUrl, workspaceId, initial.id];
  const available = Boolean(client && workspaceId === initial.workspaceId);
  const query = useQuery({ queryKey: key, enabled: available, queryFn: async () => {
    if (!client) throw new Error("Connect to this project to edit the draft.");
    return client.emailDraft(workspaceId, initial.id);
  } });
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [baseline, setBaseline] = useState<EmailDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const platform = isElectronRuntime() ? window.__LEGALWORK_ELECTRON__?.meta?.platform : undefined;
  const nativeMail = platform === "darwin";
  const nativeOutlook = nativeMail || platform === "windows";
  const dirty = draft !== baseline;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => registerUnsavedDocument(artifactDocumentKey(workspaceId, sessionId, `${initial.id}:${fieldId}`), initial.subject || "Email draft", () => dirtyRef.current), [workspaceId, sessionId, initial.id, initial.subject, fieldId]);
  useEffect(() => {
    if (query.data && !dirty) { setDraft(query.data.draft); setBaseline(query.data.draft); }
  }, [query.data, dirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (!draft) return <Surface className="my-3 w-full max-w-2xl p-5"><p role={query.isError || !available ? "alert" : "status"}>{query.isError || !available ? "Connect to this project to load the email draft." : "Loading email draft…"}</p></Surface>;
  const actionable = available && !query.isError && !busy;
  const editable = actionable && !draft.delivery;
  const current = draft;
  const change = (patch: Partial<EmailDraft>) => { setDraft({ ...current, ...patch }); setError(null); };

  const save = async () => {
    if (!client || !actionable) throw new Error("The draft is unavailable.");
    if (!dirty) return current;
    const result = await client.saveEmailDraft(workspaceId, current);
    setDraft(result.draft); setBaseline(result.draft);
    cache.setQueryData(key, result);
    return result.draft;
  };
  const reload = async () => {
    if (!client || !available || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      await cache.cancelQueries({ queryKey: key });
      const result = current.connectorTarget && current.delivery?.state === "saved"
        ? await client.reloadEmailDraft(workspaceId, current)
        : await client.emailDraft(workspaceId, current.id);
      setDraft(result.draft); setBaseline(result.draft); cache.setQueryData(key, result); setError(null);
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not reload the draft."); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const run = async (action: "save" | "download" | "outlook-app" | "provider-save" | "provider-send" | "provider-open" | EmailApp) => {
    if (busyRef.current) return;
    // Reserve a browser window during the click so saving cannot trigger a popup block.
    const popup = (action === "gmail" || action === "outlook" || action === "provider-open") && !isElectronRuntime() ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const saved = await save();
      if (action === "provider-save" || action === "provider-send") {
        if (!client) throw new Error("The draft is unavailable.");
        const result = await client.deliverEmailDraft(workspaceId, saved, action === "provider-send" ? "send" : "save");
        setDraft(result.draft); setBaseline(result.draft); cache.setQueryData(key, result);
      } else if (action === "provider-open") {
        const link = saved.delivery?.webUrl ?? (saved.connectorTarget?.connectorId === "gmail" ? "https://mail.google.com/mail/u/0/#drafts" : "https://outlook.office.com/mail/drafts");
        if (popup) popup.location.href = link; else await openDesktopUrl(link);
      } else if (action === "download") {
        if (!client) throw new Error("The draft is unavailable.");
        const result = await client.downloadWorkspaceFile(workspaceId, saved.path);
        const url = URL.createObjectURL(new Blob([result.data], { type: "message/rfc822" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = "email-draft.eml"; anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else if (action !== "save") {
        if ((action === "system" && nativeMail) || (action === "outlook-app" && nativeOutlook)) {
          if (!client) throw new Error("The draft is unavailable.");
          const attachments = [];
          let total = 0;
          for (const item of saved.attachments) {
            const file = await client.downloadWorkspaceFile(workspaceId, item.path);
            total += file.data.byteLength;
            if (total > 20 * 1024 * 1024) throw new Error("Attachments must total 20 MB or less.");
            attachments.push({ name: item.name || item.path.split("/").pop() || "attachment", data: new Uint8Array(file.data) });
          }
          const compose = action === "outlook-app" ? composeOutlookDraft : composeAppleMailDraft;
          await compose({
            subject: saved.subject, body: saved.body, from: saved.from,
            to: emailAddressSpecs(saved.to), cc: emailAddressSpecs(saved.cc), bcc: emailAddressSpecs(saved.bcc), attachments,
          });
          return;
        }
        if (action === "outlook-app") throw new Error("Open Outlook from the macOS or Windows desktop app.");
        const link = emailComposeLink(saved, action);
        if (link.length > 8000) throw new Error("This draft is too long for a compose link. Shorten the message or download .eml to export it.");
        if (popup) popup.location.href = link;
        else if (action === "system" && !isElectronRuntime()) window.location.href = link;
        else await openDesktopUrl(link);
      }
    } catch (problem) { popup?.close(); setError(problem instanceof Error ? problem.message : "Could not save, send or open the draft."); if (current.connectorTarget) void query.refetch(); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const upload = async (files: File[]) => {
    if (!client || !editable || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      if (files.length + current.attachments.length > 20 || files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) throw new Error("Choose at most 20 attachments, totaling 20 MB or less.");
      // Keep each successful upload if a later file fails.
      for (const file of files) {
        const name = file.name.replace(/[\\/\r\n\u0000]/g, "_");
        const path = `.legalwork/email-drafts/attachments/${crypto.randomUUID()}/${name}`;
        await client.writeWorkspaceBinaryFile(workspaceId, { path, data: await file.arrayBuffer() });
        setDraft(previous => previous ? { ...previous, attachments: [...previous.attachments, { path, name, contentType: file.type || "application/octet-stream" }] } : previous);
      }
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not attach the file."); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const optionalFields: Array<{ key: "from" | "replyTo" | "cc" | "bcc"; label: string }> = [
    { key: "cc", label: "Cc" }, { key: "bcc", label: "Bcc" },
    { key: "from", label: "From" }, { key: "replyTo", label: "Reply-To" },
  ];
  return <InlineCard>
    <InlineCardHeader icon={<Mail className="size-3.5 text-muted-foreground" />}
      title={current.connectorTarget?.connectorId === "gmail" ? "Gmail draft" : current.connectorTarget ? "Outlook Email draft" : "Email draft"}
      status={<>
        {busy ? <><Loader2 className="size-3 animate-spin" />Working…</> : dirty ? <><span className="size-1.5 rounded-full bg-amber-500" />Edited</> : <><Check className="size-3" />{current.delivery?.state === "sent" ? "Sent" : current.delivery?.state === "saved" ? "Saved in mailbox" : current.delivery ? "Check mailbox" : "Saved locally"}</>}
      </>}
      actions={<Button variant="ghost" size="icon-xs" className="-mr-1 ml-1" aria-label="Email options" title="Cc, Bcc, sender and formatting" aria-expanded={optionsOpen} aria-controls={`${fieldId}-options`} onClick={() => setOptionsOpen(!optionsOpen)}><SlidersHorizontal /></Button>} />
    <fieldset disabled={!editable} className={`min-w-0 ${current.delivery ? "[&_input:disabled]:opacity-100 [&_textarea:disabled]:opacity-100" : ""}`}>
      <div className="flex items-center gap-3 border-b border-border/50 px-5 py-2.5">
        <label htmlFor={`${fieldId}-to`} className="text-xs text-muted-foreground">To</label>
        <Input id={`${fieldId}-to`} title={current.to} value={current.to} onChange={event => change({ to: event.target.value })} placeholder="Recipient email" className="h-7 rounded-sm border-transparent bg-transparent px-0 text-sm shadow-none hover:enabled:border-transparent focus-visible:ring-0" />
        {(current.cc || current.bcc) && <Button size="xs" variant="ghost" className="shrink-0 text-[11px]" onClick={() => setOptionsOpen(!optionsOpen)}>{[current.cc && "Cc", current.bcc && "Bcc"].filter(Boolean).join(" / ")}</Button>}
      </div>
      {optionsOpen && <div id={`${fieldId}-options`} className="space-y-2 border-b border-border/50 bg-muted/20 px-5 py-4">
        {optionalFields.map(({ key, label }) => <div key={key} className="grid grid-cols-[3.5rem_1fr] items-center gap-3"><label htmlFor={`${fieldId}-${key}`} className="text-xs text-muted-foreground">{label}</label><Input id={`${fieldId}-${key}`} value={current[key]} onChange={event => change({ [key]: event.target.value })} className="h-8 text-xs" placeholder="Optional" /></div>)}
        <details className="pt-1"><summary className="cursor-pointer text-xs text-muted-foreground">HTML formatting</summary><label htmlFor={`${fieldId}-html`} className="sr-only">HTML alternative</label><Textarea id={`${fieldId}-html`} className="mt-2 font-mono text-xs" value={current.html} onChange={event => change({ html: event.target.value })} /><p className="mt-2 text-[11px] text-muted-foreground">Editing the message clears this alternative so your latest text is used.</p></details>
      </div>}
      <div className="px-5 pb-4 pt-5 sm:px-6">
        <label htmlFor={`${fieldId}-subject`} className="sr-only">Subject</label>
        <Textarea id={`${fieldId}-subject`} value={current.subject} onChange={event => change({ subject: event.target.value })} placeholder="Subject" rows={1} className="mb-4 min-h-0 rounded-sm border-transparent bg-transparent p-0 text-lg font-medium leading-snug tracking-tight shadow-none hover:enabled:border-transparent focus-visible:ring-0 md:text-lg" />
        <label htmlFor={`${fieldId}-body`} className="sr-only">Message</label>
        <Textarea id={`${fieldId}-body`} value={current.body} onChange={event => change({ body: event.target.value, html: "" })} className="min-h-40 rounded-sm border-transparent bg-transparent p-0 text-sm leading-7 shadow-none hover:enabled:border-transparent focus-visible:ring-0" placeholder="Write your message…" />
        {current.attachments.length > 0 && <ul className="mt-5 flex flex-wrap gap-2">{current.attachments.map((item, index) => <li key={`${item.path}-${index}`} className="group flex max-w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/35 py-1.5 pl-2.5 pr-1 text-xs"><FileText className="size-3.5 shrink-0 text-muted-foreground" /><span className="max-w-52 truncate" title={item.name || item.path}>{item.name || item.path.split("/").pop()}</span><Button variant="ghost" size="icon-xs" aria-label={`Remove ${item.name || item.path}`} onClick={() => change({ attachments: current.attachments.filter((_, i) => i !== index) })}><X className="size-3" /></Button></li>)}</ul>}
      </div>
      <input ref={fileInput} type="file" multiple className="hidden" aria-label="Attach files" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void upload(files); }} />
    </fieldset>
    {!current.connectorTarget && nativeMail && (current.html || current.replyTo) && <p className="px-5 pb-3 text-xs text-muted-foreground">Apple Mail and Outlook use the message text. HTML and custom Reply-To are included in the .eml download.</p>}
    {!current.connectorTarget && !nativeMail && current.attachments.length > 0 && <p className="px-5 pb-3 text-xs text-muted-foreground">Attach files in your mail app, or download .eml to keep attachments.</p>}
    {error && <div role="alert" className="mx-5 mb-4 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}<Button size="xs" variant="ghost" className="mt-1 text-destructive" disabled={busy} onClick={() => void reload()}>Discard edits and reload</Button></div>}
    <InlineCardFooter>
      <Button size="icon-sm" variant="ghost" disabled={!editable} aria-label="Attach files" title="Attach files" onClick={() => fileInput.current?.click()}><Paperclip className="size-4" /></Button>
      {current.connectorTarget && <Button variant="ghost" size="icon-sm" disabled={!actionable} aria-label="Download .eml" title="Download .eml" onClick={() => void run("download")}><Download className="size-4" /></Button>}
      {dirty && <Button size="sm" variant="ghost" disabled={!editable} onClick={() => void run("save")}>Save draft</Button>}
      <div className="flex-1" />
      {current.connectorTarget ? <ConnectorDraftActions draft={current} disabled={!actionable} onSave={() => void run("provider-save")} onSend={() => void run("provider-send")} onOpen={() => void run("provider-open")} /> : <div role="group" aria-label="Open email draft" className="inline-flex items-stretch rounded-lg">
        <Button size="sm" disabled={!editable} className="gap-2 rounded-l-lg rounded-r-none border-r-0 bg-clip-border px-3.5 motion-safe:active:not-aria-[haspopup]:translate-y-0" onClick={() => void run("system")}>{nativeMail ? "Open in Apple Mail" : "Open in Mail"}<ArrowUpRight className="size-3.5" /></Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" className="rounded-l-none rounded-r-lg border-l-background/20 bg-clip-border" disabled={!editable} aria-label="Open draft in…"><ChevronDown className="size-3.5" /></Button>} /><DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onClick={() => void run("gmail")}><Mail />Open in Gmail</DropdownMenuItem>
          {nativeOutlook && <DropdownMenuItem onClick={() => void run("outlook-app")}><Mail />{platform === "windows" ? "Open in classic Outlook" : "Open in Outlook app"}</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => void run("outlook")}><Mail />Open in Outlook web</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void run("download")}><Download />Download .eml</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>}
    </InlineCardFooter>
  </InlineCard>;
}
