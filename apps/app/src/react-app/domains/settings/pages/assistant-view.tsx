import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import type { AssistantSettingsCatalog } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Surface } from "@/react-app/design-system/surface";
import { t } from "@/i18n";
import { AssistantAppearanceFields, AssistantAvatar } from "../../session/sidebar/assistant-appearance";
import { useAssistantNotificationPreferences } from "../../session/sidebar/assistant-notification-preferences";
import { AssistantBehaviorFields } from "./assistant-behavior-settings";
import { createAssistantSettingsAutosave, getAssistantSettingsAutosave, type AssistantSettingsDraft } from "./assistant-settings-autosave";
import { SettingsNotice } from "../settings-section";
import {
  LayoutStack, LayoutSection, LayoutSectionHeader, LayoutSectionTitle, LayoutSectionDescription,
  LayoutSectionItem, LayoutSectionItemHeader, LayoutSectionItemTitle, LayoutSectionItemDescription,
  LayoutSectionItemHeaderActions,
} from "../settings-layout";

export function AssistantSettingsView({ client, onModels }: {
  client: LegalworkServerClient | null; onModels: () => void;
}) {
  const cache = useQueryClient();
  const profile = useQuery({ queryKey: ["main-assistant-profile", client?.baseUrl], enabled: Boolean(client),
    queryFn: () => { if (!client) throw new Error(t("assistant.unavailable")); return client.mainAssistantProfile(); } });
  const settings = useQuery({ queryKey: ["assistant-settings", client?.baseUrl], enabled: Boolean(client),
    queryFn: () => { if (!client) throw new Error(t("assistant.unavailable")); return client.assistantSettings(); } });
  const catalog = useQuery({ queryKey: ["assistant-settings-catalog", client?.baseUrl], enabled: Boolean(client),
    queryFn: () => { if (!client) throw new Error(t("assistant.unavailable")); return client.assistantSettingsCatalog(); } });
  const notifications = useAssistantNotificationPreferences(state => state.desktopNotifications);
  const setNotifications = useAssistantNotificationPreferences(state => state.setDesktopNotifications);
  if (!client || profile.isPending || settings.isPending || catalog.isPending) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />{t("assistant.settings_loading")}</p>;
  if (profile.isError || settings.isError || catalog.isError) return <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{t("assistant.settings_load_failed")}</p><Button variant="outline" onClick={() => { void profile.refetch(); void settings.refetch(); void catalog.refetch(); }}>{t("assistant.attention_retry")}</Button></div>;
  return <AssistantSettingsEditor key={`${client.baseUrl}:${profile.data.workspace?.id ?? "new"}`}
    autosaveKey={client.baseUrl}
    profile={profile.data.profile} settings={settings.data.settings} catalog={catalog.data} notifications={notifications} onModels={onModels}
    onSave={async draft => {
      const currentProfile = cache.getQueryData<typeof profile.data>(["main-assistant-profile", client.baseUrl]) ?? profile.data;
      if (JSON.stringify(draft.profile) !== JSON.stringify(currentProfile.profile)) {
        const saved = await client.updateAssistantProfile(draft.profile);
        cache.setQueryData(["main-assistant-profile", client.baseUrl], { ...currentProfile, profile: saved.profile });
        await Promise.all(["main-assistant", "assistant-onboarding"].map(name => cache.invalidateQueries({ queryKey: [name, client.baseUrl] })));
      }
      const currentSettings = cache.getQueryData<typeof settings.data>(["assistant-settings", client.baseUrl]) ?? settings.data;
      if (JSON.stringify(draft.settings) !== JSON.stringify(currentSettings.settings)) {
        const saved = await client.updateAssistantSettings(draft.settings);
        cache.setQueryData(["assistant-settings", client.baseUrl], saved);
      }
      setNotifications(draft.notifications);
    }} />;
}

export function AssistantSettingsEditor({ profile, settings, catalog, notifications, onSave, onModels, autosaveKey }: AssistantSettingsDraft & {
  catalog: AssistantSettingsCatalog; onSave: (draft: AssistantSettingsDraft) => Promise<void>; onModels: () => void; autosaveKey?: string;
}) {
  const [autosave] = useState(() => {
    const options = { initialValue: { profile, settings, notifications }, onSave, onStatus: () => {} };
    return autosaveKey ? getAssistantSettingsAutosave(autosaveKey, options) : createAssistantSettingsAutosave(options);
  });
  const { draft, status } = useSyncExternalStore(autosave.subscribe, autosave.getSnapshot, autosave.getSnapshot);
  useEffect(() => { autosave.setOnSave(onSave); }, [autosave, onSave]);
  useEffect(() => () => { void autosave.flushDraft(); }, [autosave]);
  const change = (next: AssistantSettingsDraft, persist = true) => {
    if (persist) void autosave.save(next);
    else autosave.stage(next);
  };
  return <LayoutStack className="gap-y-8">
      {status === "saving" && <span role="status" className="sr-only">{t("common.saving")}</span>}
      {status === "error" && <SettingsNotice tone="error"><div role="alert" className="flex flex-wrap items-center justify-between gap-3"><span>{t("assistant.save_failed")}</span><Button type="button" variant="outline" size="sm" onClick={() => { void autosave.retry(); }}>{t("assistant.attention_retry")}</Button></div></SettingsNotice>}
      <div className="min-w-0 space-y-8">
        <LayoutSection>
          <LayoutSectionHeader><LayoutSectionTitle>{t("assistant.customize")}</LayoutSectionTitle><LayoutSectionDescription>{t("assistant.customize_hint")}</LayoutSectionDescription></LayoutSectionHeader>
          <Surface className="space-y-5 p-5">
            <div className="flex items-center gap-4 border-b border-border/70 pb-4"><AssistantAvatar icon={draft.profile.icon} motion="idle" className="size-12" /><span className="min-w-0 truncate text-base font-medium">{draft.profile.name?.trim() || t("assistant.title")}</span></div>
            <AssistantAppearanceFields compact profile={draft.profile} onChange={value => change({ ...draft, profile: value }, value.icon !== draft.profile.icon)} onNameBlur={() => change(draft)} />
          </Surface>
        </LayoutSection>
        <AssistantBehaviorFields settings={draft.settings} catalog={catalog} onChange={value => change({ ...draft, settings: value }, value.systemPromptAddition === draft.settings.systemPromptAddition)} onInstructionsBlur={() => change(draft)} />
        <AssistantPreferences notifications={draft.notifications} onNotificationsChange={value => change({ ...draft, notifications: value })} onModels={onModels} />
      </div>
  </LayoutStack>;
}

export function AssistantPreferences({ notifications, onNotificationsChange, onModels }: {
  notifications: boolean; onNotificationsChange: (enabled: boolean) => void; onModels: () => void;
}) {
  return <LayoutSection>
    <LayoutSectionHeader><LayoutSectionTitle>{t("assistant.preferences")}</LayoutSectionTitle></LayoutSectionHeader>
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("assistant.desktop_notifications")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("assistant.desktop_notifications_hint")}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions><Switch aria-label={t("assistant.desktop_notifications")} checked={notifications} onCheckedChange={onNotificationsChange} /></LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("assistant.model")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("assistant.settings_models_hint")}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions><Button type="button" variant="outline" size="sm" onClick={onModels}>{t("settings.tab_ai")}<ArrowRight className="size-3.5" /></Button></LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  </LayoutSection>;
}
