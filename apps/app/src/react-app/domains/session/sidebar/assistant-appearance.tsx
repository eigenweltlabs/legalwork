import { useState } from "react";
import { Pencil } from "lucide-react";
import { AssistantIconSchema, DEFAULT_ASSISTANT_PROFILE, type AssistantIcon, type AssistantProfile } from "@legalwork/types/main-assistant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { t } from "@/i18n";

const icons: Record<AssistantIcon, string> = { cat: "🐱", fox: "🦊", owl: "🦉", panda: "🐼", rabbit: "🐰", bear: "🐻", dog: "🐶", penguin: "🐧", otter: "🦦", frog: "🐸", robot: "🤖", sprout: "🌱" };
export function AssistantAvatar({ icon = "cat", className = "" }: { icon?: AssistantIcon; className?: string }) {
  return <span aria-hidden="true" className={`inline-flex size-5 shrink-0 items-center justify-center text-[18px] leading-none ${className}`}>{icons[icon]}</span>;
}

export function AssistantNavigation({ profile = DEFAULT_ASSISTANT_PROFILE, active, disabled, onOpen, onSave }: {
  profile?: AssistantProfile; active?: boolean; disabled?: boolean; onOpen: () => void; onSave?: (profile: AssistantProfile) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<AssistantIcon>("cat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = profile.name ?? t("assistant.title");
  const edit = () => { setName(label); setIcon(profile.icon); setError(null); setOpen(true); };
  const save = async () => {
    if (!onSave) return;
    setBusy(true); setError(null);
    try { await onSave({ name: name.trim(), icon }); setOpen(false); }
    catch (error) { setError(error instanceof Error ? error.message : t("assistant.save_failed")); }
    finally { setBusy(false); }
  };
  return <>
    <SidebarMenuItem className="group/assistant relative">
      <ContextMenu><ContextMenuTrigger render={<SidebarMenuButton isActive={active} disabled={disabled} onClick={onOpen} className="gap-3 pr-9 font-medium" />}>
        <AssistantAvatar icon={profile.icon} /><span className="truncate">{label}</span>
      </ContextMenuTrigger><ContextMenuContent><ContextMenuItem disabled={!onSave || disabled} onClick={edit}><Pencil className="size-4" />{t("assistant.customize")}</ContextMenuItem></ContextMenuContent></ContextMenu>
      {onSave && <Button variant="ghost" size="icon" disabled={disabled} aria-label={t("assistant.customize")} onClick={edit} className="absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/assistant:opacity-100 group-focus-within/assistant:opacity-100"><Pencil className="size-3" /></Button>}
    </SidebarMenuItem>
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent className="sm:max-w-sm">
      <DialogHeader><DialogTitle>{t("assistant.customize")}</DialogTitle><DialogDescription>{t("assistant.customize_hint")}</DialogDescription></DialogHeader>
      <form className="space-y-5" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-3"><AssistantAvatar icon={icon} className="size-9 text-[30px]" /><span className="min-w-0 truncate font-medium">{name.trim() || t("assistant.title")}</span></div>
        <div className="space-y-2"><Label htmlFor="assistant-name">{t("assistant.name")}</Label><Input id="assistant-name" autoFocus value={name} maxLength={60} disabled={busy} onChange={event => setName(event.target.value)} /></div>
        <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-sm font-medium">{t("assistant.icon")}</legend><div className="grid grid-cols-6 gap-2">
          {AssistantIconSchema.options.map(value => <Button key={value} type="button" variant={icon === value ? "secondary" : "ghost"} aria-label={t(`assistant.icon_${value}`)} aria-pressed={icon === value} onClick={() => setIcon(value)} className="h-11 p-0 ring-offset-background aria-pressed:ring-2 aria-pressed:ring-ring"><AssistantAvatar icon={value} className="text-[26px]" /></Button>)}
        </div></fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button><Button type="submit" disabled={busy || !name.trim()}>{t(busy ? "common.saving" : "common.save")}</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
  </>;
}
