import { useId } from "react";
import { Check } from "lucide-react";
import { AssistantAvatarIconSchema, DEFAULT_ASSISTANT_PROFILE, type AssistantAvatarIcon, type AssistantIcon, type AssistantProfile } from "@legalwork/types/main-assistant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { assistantAvatarAnimations } from "./assistant-avatar-animation";
import { assistantAnimalIcon, assistantAvatarImages } from "./assistant-avatar-assets";
export function AssistantAvatar({ icon = DEFAULT_ASSISTANT_PROFILE.icon, className = "", motion }: { icon?: AssistantIcon; className?: string; motion?: "idle" | "thinking" }) {
  const animation = assistantAvatarAnimations[assistantAnimalIcon(icon)];
  return <span aria-hidden="true" className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}>
    {icon === "dot" ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-full text-blue-10"><circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="12" r="4.25" /></svg> : motion ? <picture className="block size-full scale-125" data-assistant-avatar-motion={motion}>
      <source media="(prefers-reduced-motion: reduce)" srcSet={animation.idle} />
      <img src={animation[motion]} alt="" draggable={false} width={256} height={256} className="size-full object-contain" />
    </picture> : <img src={assistantAvatarImages[assistantAnimalIcon(icon)]} alt="" draggable={false} className="size-full scale-125 object-contain" />}
  </span>;
}

export function AssistantNavigation({ profile = DEFAULT_ASSISTANT_PROFILE, active, disabled, unread, onOpen }: {
  profile?: AssistantProfile; active?: boolean; disabled?: boolean; unread?: boolean; onOpen: () => void;
}) {
  const name = profile.name ?? t("assistant.title");
  return <SidebarMenuItem>
    <SidebarMenuButton isActive={active} disabled={disabled} onClick={onOpen} aria-label={name} aria-current={active ? "page" : undefined} className="text-sm leading-5 font-medium [&_svg]:size-[18px]">
      <AssistantAvatar icon={profile.icon} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {unread && <span className="size-1.5 shrink-0 rounded-full bg-green-9" role="img" aria-label={t("assistant.unread_activity")} title={t("assistant.unread_activity")} />}
    </SidebarMenuButton>
  </SidebarMenuItem>;
}

export function AssistantAppearanceEditor({ profile, disabled, onChange }: {
  profile: AssistantProfile; disabled?: boolean; onChange: (profile: AssistantProfile) => void;
}) {
  return <fieldset disabled={disabled} className="space-y-3 border-b border-border px-2 pb-4 pt-3">
    <legend className="pt-3 text-xs text-muted-foreground">{t("assistant.title")}</legend>
    <AssistantAppearanceFields profile={profile} onChange={onChange} />
  </fieldset>;
}

export function AssistantAppearanceFields({ profile, compact, onChange }: { profile: AssistantProfile; compact?: boolean; onChange: (profile: AssistantProfile) => void }) {
  const id = useId();
  return <>
    <div className="space-y-2"><Label htmlFor={id} className={compact ? "text-sm" : "text-xs"}>{t("assistant.name")}</Label><Input id={id} value={profile.name ?? ""} placeholder={t("assistant.title")} maxLength={60} className={compact ? "h-9" : "h-8"} onChange={event => onChange({ ...profile, name: event.target.value })} /></div>
    <fieldset><legend className={cn("mb-2", compact ? "text-sm font-medium" : "text-xs")}>{t("assistant.icon")}</legend><AssistantAvatarPicker compact={compact} selected={profile.icon} onSelect={icon => onChange({ ...profile, icon })} /></fieldset>
  </>;
}

export function AssistantAvatarPicker({ selected, disabled, large, compact, onSelect }: { selected: AssistantIcon; disabled?: boolean; large?: boolean; compact?: boolean; onSelect: (icon: AssistantAvatarIcon) => void }) {
  return <div className={cn("grid", compact ? "grid-cols-5 gap-2" : ["grid-cols-3", large ? "gap-3" : "gap-2"])}>
    {AssistantAvatarIconSchema.options.map(icon => {
      const chosen = selected === "dot" ? icon === "dot" : assistantAnimalIcon(selected) === icon;
      return <Button key={icon} type="button" disabled={disabled} variant={chosen ? "secondary" : "ghost"} aria-label={t(`assistant.icon_${icon}`)} title={t(`assistant.icon_${icon}`)} aria-pressed={chosen} onClick={() => onSelect(icon)} className={cn("relative rounded-xl p-2", compact ? ["h-14 min-w-0 border", chosen ? "border-blue-7 bg-blue-3 hover:bg-blue-4" : "border-border/60 bg-background/70 hover:bg-muted/50"] : ["aria-pressed:ring-2 aria-pressed:ring-ring", icon === "dot" ? "col-span-3 h-12 gap-3" : large ? "h-20" : "h-16"])}>
        <AssistantAvatar icon={icon} className={icon === "dot" ? "size-7" : compact ? "size-9" : large ? "size-16" : "size-12"} />
        {compact && chosen && <Check aria-hidden="true" className="absolute right-1 top-1 size-3 text-blue-11" />}
        {icon === "dot" && !compact && <span className="text-sm">{t("assistant.icon_dot")}</span>}
      </Button>;
    })}
  </div>;
}
