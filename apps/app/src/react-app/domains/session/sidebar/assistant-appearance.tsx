import { useId, type ComponentProps } from "react";
import { Check } from "lucide-react";
import { AssistantAvatarIconSchema, DEFAULT_ASSISTANT_PROFILE, type AssistantAvatarIcon, type AssistantIcon, type AssistantProfile } from "@legalwork/types/main-assistant";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { assistantAvatarAnimations } from "./assistant-avatar-animation";
import { assistantAvatarIcon, assistantAvatarImages } from "./assistant-avatar-assets";

export function AssistantFlowerIcon({ className, size = 16, ...props }: ComponentProps<"img"> & { size?: number | string }) {
  return <img src={assistantAvatarImages.flower} width={size} height={size} alt="" draggable={false} aria-hidden="true" className={cn("shrink-0 object-contain", className)} {...props} />;
}

export function AssistantAvatar({ icon = DEFAULT_ASSISTANT_PROFILE.icon, className = "", motion }: { icon?: AssistantIcon; className?: string; motion?: "idle" | "thinking" }) {
  const avatar = assistantAvatarIcon(icon);
  const animation = avatar === "flower" ? undefined : assistantAvatarAnimations[avatar];
  return <span aria-hidden="true" className={cn("inline-flex size-5 shrink-0 items-center justify-center", className)}>
    {motion && animation ? <picture className="block size-full scale-125" data-assistant-avatar-motion={motion}>
      <source media="(prefers-reduced-motion: reduce)" srcSet={animation.idle} />
      <img src={animation[motion]} alt="" draggable={false} width={256} height={256} className="size-full object-contain" />
    </picture> : <img src={assistantAvatarImages[avatar]} alt="" draggable={false} className={cn("size-full object-contain", avatar !== "flower" && "scale-125")} />}
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

export function AssistantAppearanceFields({ profile, compact, onChange, onNameBlur }: { profile: AssistantProfile; compact?: boolean; onChange: (profile: AssistantProfile) => void; onNameBlur?: () => void }) {
  const id = useId();
  return <>
    <div className="space-y-2"><Label htmlFor={id} className={compact ? "text-sm" : "text-xs"}>{t("assistant.name")}</Label><Input id={id} value={profile.name ?? ""} placeholder={t("assistant.title")} maxLength={60} className={compact ? "h-9" : "h-8"} onChange={event => onChange({ ...profile, name: event.target.value })} onBlur={onNameBlur} /></div>
    <fieldset><legend className={cn("mb-2", compact ? "text-sm font-medium" : "text-xs")}>{t("assistant.icon")}</legend><AssistantAvatarPicker compact={compact} selected={profile.icon} onSelect={icon => onChange({ ...profile, icon })} /></fieldset>
  </>;
}

export function AssistantAvatarPicker({ selected, disabled, large, compact, onSelect }: { selected: AssistantIcon; disabled?: boolean; large?: boolean; compact?: boolean; onSelect: (icon: AssistantAvatarIcon) => void }) {
  const labels: Record<AssistantAvatarIcon, string> = {
    flower: t("assistant.icon_flower"),
    professional_owl: t("assistant.icon_professional_owl"),
    professional_fox: t("assistant.icon_professional_fox"),
    professional_bear: t("assistant.icon_professional_bear"),
    cat: t("assistant.icon_cat"),
    dog: t("assistant.icon_dog"),
    rabbit: t("assistant.icon_rabbit"),
    bear: t("assistant.icon_bear"),
    fox: t("assistant.icon_fox"),
    bird: t("assistant.icon_bird"),
  };
  return <div className={cn("grid", compact ? "grid-cols-5 gap-2 @min-[640px]/settings:grid-cols-10" : ["grid-cols-3", large ? "gap-3" : "gap-2"])}>
    {AssistantAvatarIconSchema.options.map(icon => {
      const chosen = assistantAvatarIcon(selected) === icon;
      return <Button key={icon} type="button" disabled={disabled} variant={chosen ? "secondary" : "ghost"} aria-label={labels[icon]} title={labels[icon]} aria-pressed={chosen} onClick={() => onSelect(icon)} className={cn("relative rounded-xl p-2", compact ? ["h-14 min-w-0 border", chosen ? "border-foreground/35 bg-muted hover:bg-muted" : "border-border/70 bg-background hover:bg-muted/50"] : ["aria-pressed:ring-2 aria-pressed:ring-ring", icon === "flower" ? "col-span-3 h-12 gap-3" : large ? "h-20" : "h-16"])}>
        <AssistantAvatar icon={icon} className={icon === "flower" && !compact ? "size-7" : compact ? "size-9" : large ? "size-16" : "size-12"} />
        {compact && chosen && <Check aria-hidden="true" className="absolute right-1 top-1 size-3 text-foreground" />}
      </Button>;
    })}
  </div>;
}
