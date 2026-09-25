/** @jsxImportSource react */
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ProviderActionsMenu } from "../provider-actions-menu";
import { Loader2 } from "lucide-react";
import { TextInput } from "../../../design-system/text-input";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { errorBannerClass } from "../../workspace/modal-styles";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type {
  SystemOneProvider,
  SystemOneProviderInput,
  SystemOneSettings,
} from "@legalwork/types/systemone";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionHeader,
  LayoutSectionTitle,
  LayoutSectionDescription,
  LayoutSectionItem,
} from "../settings-layout";

const newProvider = (): SystemOneProviderInput => ({
  id: `systemone-${crypto.randomUUID()}`,
  name: "TypeSafe JEV",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  models: [],
  apiKey: "",
  enabled: true,
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : t("systemone.failed");

export function SystemOneSettingsSection({
  client,
  onManageSubscription,
}: {
  client: Pick<
    LegalworkServerClient,
    | "systemOneSettings"
    | "systemOneSaveProvider"
    | "systemOneDeleteProvider"
    | "systemOneSelect"
    | "systemOneTest"
  > | null;
  onManageSubscription: () => void;
}) {
  const [settings, setSettings] = useState<SystemOneSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<SystemOneProviderInput | null>(null);
  const [modelIds, setModelIds] = useState("");
  const [preset, setPreset] = useState("typesafe");
  const formId = useId();
  const editing = settings?.providers.some((p) => p.id === draft?.id) === true;
  const selectedProvider = settings?.providers.find(
    (provider) => provider.id === settings.selection.providerId && provider.models.some((model) => model.id === settings.selection.model),
  );
  const refresh = useCallback(async () => {
    if (!client) return;
    setSettings(await client.systemOneSettings());
  }, [client]);
  useEffect(() => {
    let live = true;
    setSettings(null);
    const poll = () => {
      if (client)
        void client
          .systemOneSettings()
          .then((value) => {
            if (live) setSettings(value);
          })
          .catch((e) => {
            if (live) setError(message(e));
          });
    };
    poll();
    const interval = setInterval(poll, 30_000);
    window.addEventListener("focus", poll);
    return () => {
      live = false;
      clearInterval(interval);
      window.removeEventListener("focus", poll);
    };
  }, [client]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const edit = (provider: SystemOneProvider) => {
    setError(null);
    setPreset(provider.endpoint === "https://api.typesafe.ai/v1/systemone" ? "typesafe" : "custom");
    setDraft({
      id: provider.id,
      name: provider.name,
      endpoint: provider.endpoint,
      models: provider.models.filter((model) => model.source === "configured"),
      enabled: provider.enabled,
      apiKey: "",
    });
    setModelIds(provider.models.filter((model) => model.source === "configured").map((model) => model.id).join(", "));
  };
  const save = async () => {
    if (!draft || !client) return;
    await client.systemOneSaveProvider({
      ...draft,
      models: [...new Set(modelIds.split(/[,\n]/).map((id) => id.trim()).filter(Boolean))].map((id) =>
        draft.models.find((model) => model.id === id) ?? { id, name: id, questionTypes: ["noul", "choice", "score"] }),
      apiKey: draft.apiKey?.trim() || undefined,
    });
    const updated = await client.systemOneSettings();
    setSettings(updated);
    const saved = updated.providers.find((provider) => provider.id === draft.id);
    if (draft.enabled && saved?.modelsError && !saved.models.length)
      throw new Error(t("systemone.saved_failed") + saved.modelsError);
    setDraft(null);
    setNotice(t("systemone.saved"));
  };
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <div className="flex items-center justify-between gap-3">
          <LayoutSectionTitle>{t("systemone.title")}</LayoutSectionTitle>
          {client ? (
            <Button
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => {
                setError(null);
                setPreset("typesafe");
                setDraft(newProvider());
                setModelIds("");
              }}
            >
              {t("systemone.add_short")}
            </Button>
          ) : null}
        </div>
        <LayoutSectionDescription>
          {t("systemone.intro")}
        </LayoutSectionDescription>
      </LayoutSectionHeader>
      {!client ? (
        <SettingsNotice>{t("systemone.offline")}</SettingsNotice>
      ) : (
        <>
          {!settings ? (
            <p className="text-sm text-dls-secondary">
              {t("systemone.loading")}
            </p>
          ) : (
            settings.providers.map((provider) => (
              <LayoutSectionItem key={provider.id} className="gap-0">
                <div className="flex w-full items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <ProviderIcon providerId={provider.managed ? "eigenwelt" : undefined} size={20} className="text-dls-text" />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{provider.name}</p>
                      <p className="text-xs text-dls-secondary">{t(`systemone.${provider.status}`)}</p>
                    </div>
                  </div>
                  <ProviderActionsMenu name={provider.name} disabled={busy}>
                    {provider.managed ? (
                      <DropdownMenuItem onClick={onManageSubscription}>
                        {t(provider.status === "disconnected" ? "account.sign_in" : "systemone.manage")}
                      </DropdownMenuItem>
                    ) : (
                      <>
                        <DropdownMenuItem onClick={() => void run(refresh)}>{t("systemone.refresh_models")}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => edit(provider)}>{t("systemone.edit")}</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => void run(() => client.systemOneDeleteProvider(provider.id))}>
                          {t("systemone.remove")}
                        </DropdownMenuItem>
                      </>
                    )}
                  </ProviderActionsMenu>
                </div>
                {provider.models.length ? (
                  <div className="mt-3 w-full divide-y divide-dls-border border-t border-dls-border">
                    {provider.models.map((model) => {
                      const selected = settings.selection.providerId === provider.id && settings.selection.model === model.id;
                      return (
                        <div key={model.id} className="flex items-center justify-between gap-3 py-3 pl-8 last:pb-0">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="truncate text-sm">{model.name}</p>
                              {selected ? <SettingsStatusBadge label={t("systemone.default")} tone={provider.status === "ready" ? "ready" : "neutral"} className="min-h-6 px-2" /> : null}
                            </div>
                            {model.description ? <p className="text-xs text-dls-secondary">{model.description}</p> : null}
                          </div>
                          <ProviderActionsMenu name={model.name} disabled={busy || provider.status !== "ready"}>
                            {!selected ? (
                              <DropdownMenuItem onClick={() => void run(() => client.systemOneSelect({ providerId: provider.id, model: model.id }))}>
                                {t("systemone.select")}
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem onClick={() => void run(async () => {
                              await client.systemOneTest({ providerId: provider.id, model: model.id });
                              setNotice(t("systemone.passed"));
                            })}>{t("systemone.test")}</DropdownMenuItem>
                          </ProviderActionsMenu>
                        </div>
                      );
                    })}
                  </div>
                ) : <p className="mt-3 text-xs text-dls-secondary">{t("systemone.no_models")}</p>}
                {provider.modelsError ? <p role="status" className="mt-3 text-xs text-dls-secondary">{provider.modelsError}</p> : null}
              </LayoutSectionItem>
            ))
          )}
          {settings && !selectedProvider ? (
            <SettingsNotice>{t("systemone.missing")}</SettingsNotice>
          ) : null}
        </>
      )}
      {error && !draft ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      {notice ? <SettingsNotice>{notice}</SettingsNotice> : null}
      <Dialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDraft(null);
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] min-h-0 max-w-lg flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t(editing ? "systemone.edit_provider" : "systemone.add")}</DialogTitle>
            <DialogDescription>{t("systemone.connect_description")}</DialogDescription>
          </DialogHeader>
          {draft ? (
            <>
              <form
                id={formId}
                className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(save);
                }}
              >
                <fieldset disabled={busy} className="space-y-4">
                  <div className="space-y-1.5">
                    <label htmlFor={`${formId}-preset`} className="text-xs font-medium text-dls-text">
                      {t("systemone.preset")}
                    </label>
                    <Select
                      value={preset}
                      items={[
                        { value: "typesafe", label: t("systemone.typesafe") },
                        { value: "custom", label: t("systemone.custom") },
                      ]}
                      onValueChange={(kind) => {
                        if (!kind) return;
                        setPreset(kind);
                        setModelIds("");
                        setDraft({
                          ...draft,
                          name: kind === "typesafe" ? "TypeSafe JEV" : "",
                          endpoint: kind === "typesafe" ? "https://api.typesafe.ai/v1/systemone" : "",
                          models: [],
                          apiKey: "",
                        });
                      }}
                    >
                      <SelectTrigger id={`${formId}-preset`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="typesafe">{t("systemone.typesafe")}</SelectItem>
                        <SelectItem value="custom">{t("systemone.custom")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <TextInput
                    label={t("systemone.name")}
                    placeholder={t("systemone.name_placeholder")}
                    required
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
                  />
                  <TextInput
                    label={t("systemone.endpoint")}
                    placeholder="https://api.example.com/v1/systemone"
                    type="url"
                    required
                    autoCapitalize="off"
                    spellCheck={false}
                    value={draft.endpoint}
                    onChange={(event) => setDraft({ ...draft, endpoint: event.currentTarget.value })}
                  />
                  <TextInput
                    label={t("systemone.key")}
                    type="password"
                    autoComplete="new-password"
                    hint={editing ? t("systemone.key_hint") : undefined}
                    value={draft.apiKey}
                    onChange={(event) => setDraft({ ...draft, apiKey: event.currentTarget.value })}
                  />
                  <TextInput
                    label={t("systemone.model_ids")}
                    hint={t("systemone.model_ids_hint")}
                    placeholder="jev-1.13.0, custom-model"
                    autoCapitalize="off"
                    spellCheck={false}
                    value={modelIds}
                    onChange={(event) => setModelIds(event.currentTarget.value)}
                  />
                  {editing ? (
                  <div className="divide-y divide-dls-border rounded-xl border border-dls-border">
                      <label className="flex items-center justify-between gap-3 px-3.5 py-3 text-xs font-medium">
                        {t("systemone.enabled")}
                        <Switch
                          checked={draft.enabled}
                          onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                        />
                      </label>
                  </div>
                  ) : null}
                  {error ? <div role="alert" className={errorBannerClass}>{error}</div> : null}
                </fieldset>
              </form>
              <DialogFooter className="shrink-0">
                <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
                  {t("systemone.cancel")}
                </Button>
                <Button type="submit" form={formId} disabled={busy}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t("systemone.save_only")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </LayoutSection>
  );
}
