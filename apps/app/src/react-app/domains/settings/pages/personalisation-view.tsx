/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";

import {
  LEGALWORK_PERSONALITY_VALUES,
  type LegalworkPersonality,
  type LegalworkPersonalizationSettings,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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

const DEFAULT_SETTINGS: LegalworkPersonalizationSettings = {
  customInstructions: "",
  localMemoriesEnabled: false,
  allowToolAssistedMemory: true,
  personality: "pragmatic",
};

const PERSONALITY_LABELS: Record<LegalworkPersonality, string> = {
  default: "Default",
  pragmatic: "Pragmatic",
  professional: "Professional",
  friendly: "Friendly",
  candid: "Candid",
};

function isPersonality(value: unknown): value is LegalworkPersonality {
  return typeof value === "string" && LEGALWORK_PERSONALITY_VALUES.some((personality) => personality === value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Personalisation settings could not be updated.";
}

export type PersonalisationViewProps = {
  client: LegalworkServerClient | null;
  onSettingsApplied: () => void;
  onOpenLink: (url: string) => void;
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

  const personalityItems = useMemo(
    () => LEGALWORK_PERSONALITY_VALUES.map((value) => ({ value, label: PERSONALITY_LABELS[value] })),
    [],
  );

  const deleteMemories = async () => {
    if (!props.client) return;
    setDeleteOpen(false);
    setBusy(true);
    setError(null);
    try {
      await props.client.deleteLocalMemories();
      toast.success("Local memories deleted.");
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
            Connect to the LegalWork server to manage host-wide personalisation.
          </SettingsNotice>
        ) : null}
        {error ? <SettingsNotice tone="error">{error}</SettingsNotice> : null}

        <LayoutSection>
          <LayoutSectionHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <LayoutSectionTitle>System prompt additions</LayoutSectionTitle>
                <LayoutSectionDescription>
                  Add instructions and context that LegalWork includes in the system prompt for every chat on this host.
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
                Save
              </Button>
            </div>
          </LayoutSectionHeader>

          <div className="space-y-1.5">
            <Textarea
              value={instructionsDraft}
              maxLength={12_000}
              disabled={disabled}
              onChange={(event) => setInstructionsDraft(event.currentTarget.value)}
              placeholder="Add your system prompt additions…"
              aria-label="System prompt additions"
              className="min-h-52 resize-y rounded-2xl bg-surface px-4 py-3.5"
            />
            <div className="text-right text-xs text-muted-foreground">
              {remainingCharacters.toLocaleString()} characters remaining
            </div>
          </div>
        </LayoutSection>

        <LayoutSection>
          <LayoutSectionHeader>
            <LayoutSectionTitle>Memory</LayoutSectionTitle>
            <LayoutSectionDescription>
              Configure how local memories are collected and used on this host.{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => props.onOpenLink("https://www.opencode.asia/ecosystem/plugins/agent-memory/")}
              >
                Learn more
              </button>
            </LayoutSectionDescription>
          </LayoutSectionHeader>

          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>Enable local memories</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                Create private memory blocks from chats on this host and use them to personalise future chats.
              </LayoutSectionItemDescription>
              <LayoutSectionItemHeaderActions>
                <Switch
                  aria-label="Enable local memories"
                  checked={settings.localMemoriesEnabled}
                  disabled={disabled}
                  onCheckedChange={(checked) => void persist({ ...settings, localMemoriesEnabled: checked })}
                />
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
          </LayoutSectionItem>

          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>Allow memory generation from tool-assisted chats</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                Let LegalWork retain durable context from chats that used MCP tools or web search.
              </LayoutSectionItemDescription>
              <LayoutSectionItemHeaderActions>
                <Switch
                  aria-label="Allow memory generation from tool-assisted chats"
                  checked={settings.allowToolAssistedMemory}
                  disabled={disabled}
                  onCheckedChange={(checked) => void persist({ ...settings, allowToolAssistedMemory: checked })}
                />
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
          </LayoutSectionItem>

          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>Delete local memories</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                Permanently delete all global and workspace memory blocks stored on this host.
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
            Personality settings may be followed differently by different models. Fine-tune LegalWork&apos;s tone in System prompt additions.
          </span>
        </div>

        <LayoutSection>
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>Personality</LayoutSectionItemTitle>
              <LayoutSectionItemDescription>Choose the default tone for LegalWork responses.</LayoutSectionItemDescription>
              <LayoutSectionItemHeaderActions>
                <Select
                  value={settings.personality}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (isPersonality(value)) void persist({ ...settings, personality: value });
                  }}
                >
                  <SelectTrigger className="w-44" aria-label="Personality">
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
        title="Delete all local memories?"
        message="This permanently removes the global and workspace memory blocks stored on this LegalWork host. This cannot be undone."
        confirmLabel="Delete memories"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => void deleteMemories()}
        onCancel={() => setDeleteOpen(false)}
      />
    </>
  );
}
