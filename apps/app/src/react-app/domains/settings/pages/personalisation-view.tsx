/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { Info } from "lucide-react";

import {
  LEGALWORK_PERSONALITY_VALUES,
  type LegalworkPersonality,
  type LegalworkPersonalizationSettings,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/sonner";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";

import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { SettingsNotice } from "../settings-section";
import { t } from "@/i18n";
import { changeOrgPolicySetting, useOrgPolicy } from "../../connections/org-policy";
import { FirmInstructions, OrgPolicyNote } from "../../connections/org-policy-ui";

const DEFAULT_SETTINGS: LegalworkPersonalizationSettings = {
  customInstructions: "",
  personality: "pragmatic",
};

// Built per render, not once at import: `t()` reads the current language.
const personalityLabels = (): Record<LegalworkPersonality, string> => ({
  default: t("personalisation.personality_default"),
  pragmatic: t("personalisation.personality_pragmatic"),
  professional: t("personalisation.personality_professional"),
  friendly: t("personalisation.personality_friendly"),
  candid: t("personalisation.personality_candid"),
});

function isPersonality(value: unknown): value is LegalworkPersonality {
  return typeof value === "string" && LEGALWORK_PERSONALITY_VALUES.some((personality) => personality === value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : t("personalisation.update_failed");
}

export type PersonalisationViewProps = {
  client: LegalworkServerClient | null;
  onSettingsApplied: () => void;
};

export function PersonalisationView(props: PersonalisationViewProps) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [instructionsDraft, setInstructionsDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    if (!props.client) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void props.client.getPersonalization()
      .then(({ settings: loaded }) => {
        if (cancelled) return;
        setSettings(loaded);
        setInstructionsDraft(loaded.customInstructions);
      })
      .catch((loadError) => {
        if (!cancelled) setError(describeError(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.client]);

  const instructionsChanged = instructionsDraft !== settings.customInstructions;
  const remainingCharacters = 12_000 - instructionsDraft.length;
  const disabled = loading || busy || !props.client;

  const persist = async (next: LegalworkPersonalizationSettings, successMessage?: string) => {
    if (!props.client) return;
    setBusy(true);
    setError(null);
    try {
      const result = await props.client.setPersonalization(next);
      setSettings(result.settings);
      setInstructionsDraft(result.settings.customInstructions);
      props.onSettingsApplied();
      if (successMessage) toast.success(successMessage);
    } catch (saveError) {
      const message = describeError(saveError);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  // Not memoised on []: the labels come from `t()`, so they must rebuild when
  // the language changes.
  const firmPersonality = useOrgPolicy("personalization.personality");
  const labels = personalityLabels();
  const personalityItems = LEGALWORK_PERSONALITY_VALUES.map((value) => ({
    value,
    label: labels[value],
  }));

  const deleteMemories = async () => {
    if (!props.client) return;
    setDeleteOpen(false);
    setBusy(true);
    setError(null);
    try {
      await props.client.deleteLocalMemories();
      toast.success(t("personalisation.memories_deleted"));
    } catch (deleteError) {
      const message = describeError(deleteError);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <LayoutStack>
        {!props.client ? (
          <SettingsNotice tone="warning">
            {t("personalisation.server_required")}
          </SettingsNotice>
        ) : null}
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}

        <LayoutSection>
          <LayoutSectionHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <LayoutSectionTitle>{t("personalisation.system_prompt_title")}</LayoutSectionTitle>
                <LayoutSectionDescription>
                  {t("personalisation.system_prompt_desc")}
                </LayoutSectionDescription>
              </div>
              <Button
                size="sm"
                disabled={disabled || !instructionsChanged || remainingCharacters < 0}
                onClick={() => void persist(
                  { ...settings, customInstructions: instructionsDraft },
                  "System prompt additions saved.",
                )}
              >
                {t("common.save")}
              </Button>
            </div>
          </LayoutSectionHeader>

          <div className="space-y-1.5">
            <Textarea
              value={instructionsDraft}
              maxLength={12_000}
              disabled={disabled}
              onChange={(event) => setInstructionsDraft(event.currentTarget.value)}
              placeholder={t("personalisation.system_prompt_placeholder")}
              aria-label={t("personalisation.system_prompt_title")}
              className="min-h-52 resize-y rounded-2xl bg-surface px-4 py-3.5"
            />
            <div className="text-right text-xs text-muted-foreground">
              {t("personalisation.characters_remaining", { count: remainingCharacters.toLocaleString() })}
            </div>
          </div>
          <FirmInstructions />
        </LayoutSection>

        <LayoutSection>
          <LayoutSectionHeader>
            <LayoutSectionTitle>{t("personalisation.memory_title")}</LayoutSectionTitle>
            <LayoutSectionDescription>{t("personalisation.memory_desc")}</LayoutSectionDescription>
          </LayoutSectionHeader>

          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>{t("personalisation.delete_memories")}</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                {t("personalisation.delete_memories_desc")}
              </LayoutSectionItemDescription>
              <LayoutSectionItemHeaderActions>
                <Button variant="destructive" size="sm" disabled={disabled} onClick={() => setDeleteOpen(true)}>
                  Delete
                </Button>
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
          </LayoutSectionItem>
        </LayoutSection>

        <div className="flex items-start gap-3 rounded-2xl border border-amber-7/30 bg-amber-2/30 px-4 py-3 text-sm text-amber-12">
          <Info className="mt-0.5 size-4 shrink-0 text-amber-10" />
          <span>
            {t("personalisation.personality_note")}
          </span>
        </div>

        <LayoutSection>
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>{t("personalisation.personality")}</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>{t("personalisation.tone_desc")}</LayoutSectionItemDescription>
              <OrgPolicyNote policyKey="personalization.personality" />
              <LayoutSectionItemHeaderActions>
                <Select
                  value={firmPersonality?.value ?? settings.personality}
                  // Base UI resolves the trigger label from `items`; without it
                  // the trigger shows the raw value ("pragmatic").
                  items={personalityItems}
                  disabled={disabled || firmPersonality?.locked === true}
                  onValueChange={(value) => {
                    if (isPersonality(value)) void changeOrgPolicySetting("personalization.personality", () => persist({ ...settings, personality: value }));
                  }}
                >
                  <SelectTrigger className="w-44" aria-label={t("personalisation.personality")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {personalityItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
          </LayoutSectionItem>
        </LayoutSection>
      </LayoutStack>

      <ConfirmModal
        open={deleteOpen}
        title={t("personalisation.delete_confirm_title")}
        message={t("personalisation.delete_confirm_message")}
        confirmLabel={t("personalisation.delete_confirm_label")}
        cancelLabel={t("personalisation.cancel")}
        variant="danger"
        onConfirm={() => void deleteMemories()}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}
