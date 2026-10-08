import { useEffect, useState } from "react";
import { DEFAULT_ASSISTANT_PROFILE, type AssistantProfile } from "@legalwork/types/main-assistant";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "@/components/ui/switch";
import { ChevronDown } from "lucide-react";
import { t } from "@/i18n";
import { AssistantAppearanceFields, AssistantAvatar } from "./assistant-appearance";
import { ModelSelect } from "@/components/model-select";
import { ModelBehaviorSelect } from "@/components/model-behavior-select";
import type { SessionSurfaceProps } from "../surface/session-surface";
import { useSessionActivityStore } from "../status/session-activity-store";
import { useAssistantNotificationPreferences } from "./assistant-notification-preferences";

type ModelSettings = Pick<SessionSurfaceProps, "selectedModel" | "modelSelectorLocked" | "modelPickerOpen" | "onModelPickerOpenChange" | "onModelChange" | "modelVariant" | "modelVariantLabel" | "modelBehaviorOptions" | "onModelVariantChange">;

export function AssistantIdentity({ profile = DEFAULT_ASSISTANT_PROFILE, onSave, workspaceId, sessionId, modelSettings }: {
  profile?: AssistantProfile;
  onSave?: (profile: AssistantProfile) => Promise<void>;
  workspaceId: string;
  sessionId: string;
  modelSettings?: ModelSettings;
}) {
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (modelSettings?.modelPickerOpen) setEditing(true); }, [modelSettings?.modelPickerOpen]);
  const busy = useSessionActivityStore(state => state.recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive ?? false);
  const close = () => { setEditing(false); modelSettings?.onModelPickerOpenChange(false); };
  const name = profile.name ?? t("assistant.title");
  return <>
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-4 pt-3">
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-32 bg-background/70 backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_15%,transparent_100%)]" />
      <button type="button" className="pointer-events-auto group relative flex max-w-full flex-col items-center rounded-2xl px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
        aria-label={`${t("assistant.customize")}: ${name}`} title={t("assistant.customize")} aria-haspopup="dialog" disabled={!onSave} onClick={() => setEditing(true)}>
        <AssistantAvatar icon={profile.icon} motion="thinking" className="size-16 transition-transform group-hover:scale-105" />
        <span className="relative max-w-64 truncate rounded-full border border-border/60 bg-background/70 px-2.5 py-0.5 text-xs font-medium leading-4 shadow-sm backdrop-blur-md transition-colors group-hover:bg-background/90">{name}</span>
      </button>
    </div>
    {(editing || modelSettings?.modelPickerOpen) && onSave && <AssistantIdentityEditor profile={profile} onSave={onSave} onClose={close} modelSettings={modelSettings} busy={busy} />}
  </>;
}

function AssistantIdentityEditor({ profile, onSave, onClose, modelSettings, busy }: {
  profile: AssistantProfile;
  onSave: (profile: AssistantProfile) => Promise<void>;
  onClose: () => void;
  modelSettings?: ModelSettings;
  busy: boolean;
}) {
  const [draft, setDraft] = useState({ ...profile, name: profile.name ?? t("assistant.title") });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desktopNotifications = useAssistantNotificationPreferences(state => state.desktopNotifications);
  const setDesktopNotifications = useAssistantNotificationPreferences(state => state.setDesktopNotifications);
  const save = async () => {
    if (saving || !draft.name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, name: draft.name.trim() });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("assistant.save_failed"));
      setSaving(false);
    }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving) onClose(); }}>
    <DialogContent showCloseButton={!saving} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-sm">
      <div className="space-y-3 text-center">
        <AssistantAvatar icon={draft.icon} className="mx-auto size-20" />
        <DialogTitle>{t("assistant.customize")}</DialogTitle>
        <DialogDescription>{t("assistant.customize_hint")}</DialogDescription>
      </div>
      <Collapsible defaultOpen={modelSettings?.modelPickerOpen} className="group/advanced border-b border-border pb-3">
        <CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-sm font-medium">
          {t("settings.tab_advanced")}<ChevronDown className="size-4 -rotate-90 group-data-[open]/advanced:rotate-0" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <label className="flex items-start justify-between gap-4">
            <span className="space-y-1"><span className="block text-sm font-medium">{t("assistant.desktop_notifications")}</span>
              <span className="block text-xs text-muted-foreground">{t("assistant.desktop_notifications_hint")}</span></span>
            <Switch aria-label={t("assistant.desktop_notifications")} checked={desktopNotifications} onCheckedChange={setDesktopNotifications} />
          </label>
      {modelSettings && <div className="space-y-1">
        <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t("assistant.model")}</span>
          <ModelSelect value={modelSettings.selectedModel} locked={modelSettings.modelSelectorLocked} disabled={busy} open={modelSettings.modelPickerOpen} onOpenChange={modelSettings.onModelPickerOpenChange} onChange={modelSettings.onModelChange} />
        </div>
        {!!modelSettings.modelBehaviorOptions?.length && <div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">{t("assistant.effort")}</span>
          <ModelBehaviorSelect value={modelSettings.modelVariant} label={modelSettings.modelVariantLabel} options={modelSettings.modelBehaviorOptions} onChange={modelSettings.onModelVariantChange} disabled={busy} />
        </div>}
        <p className="text-xs text-muted-foreground">{t("assistant.model_autosave")}</p>
      </div>}
        </CollapsibleContent>
      </Collapsible>
      <form className="space-y-5" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={saving} className="space-y-4">
          <AssistantAppearanceFields profile={draft} onChange={value => setDraft({ ...value, name: value.name ?? "" })} />
        </fieldset>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
          <Button type="submit" disabled={saving || !draft.name.trim()}>{t(saving ? "common.saving" : "common.save")}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
