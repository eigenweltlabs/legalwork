import { useEffect, useEffectEvent, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionTitle,
} from "../settings-layout";
import { SettingsNotice } from "../settings-section";

type Props = {
  client: LegalworkServerClient | null;
  workspaceId: string;
  projectName: string;
  active: boolean;
};

export function ProjectPersonalisationSection({ client, workspaceId, projectName, active }: Props) {
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const receiveLatest = useEffectEvent((customInstructions: string, revision: number) => {
    if (!loaded || draft.trim() === saved) {
      setSaved(customInstructions);
      setDraft(customInstructions);
      setConflict(false);
      setRevision(revision);
    } else if (customInstructions === saved) {
      // Other sections share the revision. Refresh it without losing this draft.
      setRevision(revision);
      setConflict(false);
    } else {
      setConflict(true);
    }
    setLoaded(true);
  });

  useEffect(() => {
    if (!active || !client) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void client.getProjectPersonalization(workspaceId)
      .then(({ customInstructions, revision }) => {
        if (cancelled) return;
        receiveLatest(customInstructions, revision);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : t("personalisation.update_failed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, workspaceId, active]);

  const persist = async () => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const result = await client.setProjectPersonalization(workspaceId, draft, revision);
      setSaved(result.customInstructions);
      setDraft(result.customInstructions);
      setRevision(result.revision);
      void queryClient.invalidateQueries({ queryKey: ["project", workspaceId] });
      toast.success(t("personalisation.project_prompt_saved"));
    } catch (saveError) {
      if (saveError instanceof LegalworkServerError && saveError.code === "project_changed") setConflict(true);
      toast.error(saveError instanceof Error ? saveError.message : t("personalisation.update_failed"), { error: saveError });
    } finally {
      setBusy(false);
    }
  };

  const disabled = !client || loading || busy || error !== null;
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <LayoutSectionTitle>{t("project_settings.writing")}</LayoutSectionTitle>
            <LayoutSectionDescription>{t("personalisation.project_prompt_desc")}</LayoutSectionDescription>
          </div>
        </div>
      </LayoutSectionHeader>
      {!client ? <SettingsNotice tone="warning">{t("personalisation.server_required")}</SettingsNotice> : null}
      {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}
      {conflict ? <SettingsNotice tone="warning">
        {t("personalisation.project_prompt_conflict")}
        <Button variant="outline" size="sm" className="mt-2" disabled={busy} onClick={async () => {
          if (!client) return;
          setBusy(true);
          try {
            const latest = await client.getProjectPersonalization(workspaceId);
            setSaved(latest.customInstructions);
            setDraft(latest.customInstructions);
            setRevision(latest.revision);
            setConflict(false);
          } catch (loadError) { toast.error(loadError instanceof Error ? loadError.message : t("personalisation.update_failed"), { error: loadError }); }
          finally { setBusy(false); }
        }}>{t("personalisation.project_prompt_reload")}</Button>
      </SettingsNotice> : null}
      <div className="space-y-1.5">
        <Textarea
          value={draft}
          maxLength={12_000}
          disabled={disabled}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder={t("personalisation.project_prompt_placeholder")}
          aria-label={t("personalisation.project_prompt_title", { name: projectName })}
          className="min-h-40 resize-y rounded-2xl bg-surface px-4 py-3.5"
        />
        <div className="text-right text-xs text-muted-foreground">
          {t("personalisation.characters_remaining", { count: (12_000 - draft.length).toLocaleString() })}
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={disabled || conflict || !draft} onClick={() => setDraft("")}>{t("project_settings.global_defaults")}</Button>
        <Button disabled={disabled || conflict || draft.trim() === saved || draft.length > 12_000} onClick={() => void persist()}>{t("common.save")}</Button>
      </div>
    </LayoutSection>
  );
}
