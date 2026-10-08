import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AssistantAvatarIcon, AssistantOnboardingState } from "@legalwork/types/main-assistant";
import { Message, MessageContent } from "@/components/ui/message";
import { t } from "@/i18n";
import { AssistantAvatar, AssistantAvatarPicker } from "../sidebar/assistant-appearance";

export type AssistantOnboardingControls = {
  state: AssistantOnboardingState;
  onIcon: (icon: AssistantAvatarIcon) => Promise<void>;
};

function AssistantSetupMessage({ children, id }: { children: ReactNode; id?: string }) {
  return <Message data-message-id={id} className="scroll-mt-36"><MessageContent data-assistant-message-bubble="" className="space-y-3 text-sm">{children}</MessageContent></Message>;
}

export function AssistantOnboardingConversation({ state, onIcon, workspaceId, onAvatarQuestionComplete }: {
  workspaceId: string;
  onAvatarQuestionComplete?: () => void;
  state: AssistantOnboardingState;
  onIcon?: (icon: AssistantAvatarIcon) => Promise<void>;
}) {
  return <div className="space-y-6 pb-6 pt-24" aria-live="polite" data-assistant-onboarding={state.step}>
    <AssistantSetupMessage id="assistant-onboarding-name">
      <OnboardingReply text={`${t("assistant.intro_greeting")}\n\n${t("assistant.intro_name_question")}`} />
    </AssistantSetupMessage>
    {state.name && !state.agentNamed && <>
      <Message className="justify-end"><MessageContent data-user-message-bubble="" className="max-w-[85%] rounded-3xl bg-blue-3 px-5 py-2.5 text-sm">{state.name}</MessageContent></Message>
      <AssistantAvatarQuestion state={state} workspaceId={workspaceId} onIcon={onIcon} onQuestionComplete={onAvatarQuestionComplete} />
    </>}
  </div>;
}

/** The naming tool places this question after the user's real message. */
export function AssistantAvatarQuestion({ state, onIcon, workspaceId, onQuestionComplete }: {
  workspaceId: string;
  state: AssistantOnboardingState;
  onIcon?: (icon: AssistantAvatarIcon) => Promise<void>;
  onQuestionComplete?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [questionReady, setQuestionReady] = useState(state.step === "complete");
  const [error, setError] = useState<string | null>(null);
  const choose = async (icon: AssistantAvatarIcon) => {
    if (!onIcon || saving) return;
    setSaving(true); setError(null);
    try { await onIcon(icon); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t("assistant.save_failed")); }
    finally { setSaving(false); }
  };
  return <div className="space-y-5" data-message-id="assistant-onboarding-avatar">
    <AssistantSetupMessage><OnboardingReply text={t("assistant.intro_icon_question")} onComplete={() => { setQuestionReady(true); onQuestionComplete?.(); }} /></AssistantSetupMessage>
    {state.step === "avatar" ? questionReady && <div className="w-full max-w-md rounded-2xl border border-border bg-background/70 p-4">
      <AssistantAvatarPicker large selected="dot" disabled={saving || !onIcon} onSelect={icon => void choose(icon)} />
      {saving && <p role="status" className="mt-2 text-sm text-muted-foreground">{t("common.saving")}</p>}
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </div> : <Message className="justify-end"><MessageContent data-user-message-bubble="" className="rounded-3xl bg-blue-3 px-5 py-2.5"><AssistantAvatar icon={state.icon} className="size-16" /></MessageContent></Message>}
    {state.step === "complete" && state.name !== null && <AssistantSetupMessage><OnboardingReply text={t("assistant.intro_ready", { name: state.name })} /></AssistantSetupMessage>}
  </div>;
}

/** Setup uses the same complete-bubble arrival as normal Assistant messages. */
function OnboardingReply({ text, onComplete }: { text: string; onComplete?: () => void }) {
  const notified = useRef(false);
  useEffect(() => {
    if (!notified.current) { notified.current = true; onComplete?.(); }
  }, [onComplete]);
  return <p className="whitespace-pre-line">{text}</p>;
}
