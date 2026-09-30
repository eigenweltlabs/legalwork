import { useEffect, useState } from "react";
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
};

export function ProjectPersonalisationSection({ client, workspaceId, projectName }: Props) {
  const [saved, setSaved] = useState("");
  const [draft, setDraft] = useState("");
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (!client) return;
    void client.getProjectPersonalization(workspaceId)
      .then(({ customInstructions, revision }) => {
        if (cancelled) return;
        setSaved(customInstructions);
        setDraft(customInstructions);
        setRevision(revision);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : t("personalisation.update_failed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, workspaceId]);

  const persist = async () => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const result = await client.setProjectPersonalization(workspaceId, draft, revision);
      setSaved(result.customInstructions);
      setDraft(result.customInstructions);
      setRevision(result.revision);
      toast.success(t("personalisation.project_prompt_saved"));
    } catch (saveError) {
      if (saveError instanceof LegalworkServerError && saveError.code === "project_changed") setConflict(true);
      toast.error(saveError instanceof Error ? saveError.message : t("personalisation.update_failed"));
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
            <LayoutSectionTitle>{t("personalisation.project_prompt_title", { name: projectName })}</LayoutSectionTitle>
            <LayoutSectionDescription>{t("personalisation.project_prompt_desc")}</LayoutSectionDescription>
          </div>
          <Button size="sm" disabled={disabled || conflict || draft.trim() === saved || draft.length > 12_000} onClick={() => void persist()}>
            {t("common.save")}
          </Button>
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
          } catch (loadError) { toast.error(loadError instanceof Error ? loadError.message : t("personalisation.update_failed")); }
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
    </LayoutSection>
  );
}
