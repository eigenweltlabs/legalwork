import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { AssistantAppearanceFields, AssistantAvatar } from "../../session/sidebar/assistant-appearance";
import { AssistantDesktopNotifications } from "../../session/sidebar/assistant-identity";
import { useAssistantNotificationPreferences } from "../../session/sidebar/assistant-notification-preferences";
import { CloudAssistantSettings } from "../../session/sidebar/cloud-assistant-settings";
import { SettingsStack } from "../settings-section";

export function AssistantSettingsView({ client, onSignIn, onModels }: {
  client: LegalworkServerClient | null; onSignIn: () => void; onModels: () => void;
}) {
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ["main-assistant-profile", client?.baseUrl], enabled: Boolean(client),
    queryFn: () => { if (!client) throw new Error(t("assistant.unavailable")); return client.mainAssistantProfile(); } });
  const notifications = useAssistantNotificationPreferences(state => state.desktopNotifications);
  const setNotifications = useAssistantNotificationPreferences(state => state.setDesktopNotifications);
  if (!client || query.isPending) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" />{t("assistant.settings_loading")}</p>;
  if (query.isError) return <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{t("assistant.unavailable")}</p><Button variant="outline" onClick={() => { void query.refetch(); }}>{t("assistant.cloud_retry")}</Button></div>;
  return <SettingsStack>
    <AssistantProfileForm key={`${client.baseUrl}:${query.data.workspace?.id ?? "new"}`} profile={query.data.profile} onSave={async profile => {
      const saved = await client.updateAssistantProfile(profile);
      cache.setQueryData(["main-assistant-profile", client.baseUrl], { ...query.data, profile: saved.profile });
      await Promise.all(["main-assistant", "assistant-onboarding"].map(name => cache.invalidateQueries({ queryKey: [name, client.baseUrl] })));
    }} />
    <CloudAssistantSettings client={client} profile={query.data.profile} onSignIn={onSignIn} />
    <div className="border-t border-border pt-5"><AssistantDesktopNotifications enabled={notifications} onChange={setNotifications} /></div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5"><div className="space-y-1"><h3 className="text-sm font-medium">{t("assistant.model")}</h3><p className="text-xs text-muted-foreground">{t("assistant.settings_models_hint")}</p></div><Button variant="outline" onClick={onModels}>{t("settings.tab_ai")}<ArrowRight className="size-4" /></Button></div>
  </SettingsStack>;
}

function AssistantProfileForm({ profile, onSave }: { profile: AssistantProfile; onSave: (profile: AssistantProfile) => Promise<void> }) {
  const [draft, setDraft] = useState(profile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft.name !== profile.name || draft.icon !== profile.icon;
  return <form className="space-y-5" onSubmit={event => {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true); setError(null);
    const normalized = { ...draft, name: draft.name?.trim() || null };
    void onSave(normalized).then(() => setDraft(normalized)).catch(() => setError(t("assistant.save_failed"))).finally(() => setSaving(false));
  }}>
    <div className="flex items-center gap-4"><AssistantAvatar icon={draft.icon} motion="idle" className="size-16" /><div className="space-y-1"><h3 className="text-sm font-medium">{t("assistant.customize")}</h3><p className="text-xs text-muted-foreground">{t("assistant.customize_hint")}</p></div></div>
    <fieldset disabled={saving} className="max-w-md space-y-5"><AssistantAppearanceFields compact profile={draft} onChange={setDraft} /></fieldset>
    <div className="flex items-center gap-3"><Button type="submit" disabled={saving || !dirty}>{t(saving ? "common.saving" : "common.save")}</Button>{error && <p role="alert" className="text-xs text-destructive">{error}</p>}</div>
  </form>;
}
