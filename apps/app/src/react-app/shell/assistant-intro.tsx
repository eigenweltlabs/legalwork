import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { isOfficeAddinRuntime } from "@/app/utils";
import { t } from "@/i18n";
import { useLocal } from "@/react-app/kernel/local-provider";
import { AssistantAvatar } from "@/react-app/domains/session/sidebar/assistant-appearance";

const SEEN_KEY = "legalwork.assistantIntroSeen.v1";

function hasPendingAssistantIntro() {
  try { return window.localStorage.getItem(SEEN_KEY) !== "1"; }
  catch { return false; }
}

function markSeen() {
  try { window.localStorage.setItem(SEEN_KEY, "1"); } catch { /* Keep this visit dismissed. */ }
}

export function AssistantIntroDialog({ ready, onOpenAssistant }: {
  ready: boolean; onOpenAssistant: () => void;
}) {
  const local = useLocal();
  const [open, setOpen] = useState(false);
  const stage = local.prefs.onboardingStage;
  useEffect(() => {
    if (isOfficeAddinRuntime() || !ready || stage !== "done" || !hasPendingAssistantIntro()) return;
    const timer = window.setTimeout(() => setOpen(true), 1200);
    return () => window.clearTimeout(timer);
  }, [ready, stage]);
  const dismiss = () => { markSeen(); setOpen(false); };
  return <AssistantIntroModal open={open} onDismiss={dismiss} onOpenAssistant={() => { dismiss(); onOpenAssistant(); }} />;
}

export function AssistantIntroModal({ open, onDismiss, onOpenAssistant }: {
  open: boolean; onDismiss: () => void; onOpenAssistant: () => void;
}) {
  return <Dialog open={open} onOpenChange={value => { if (!value) onDismiss(); }}>
    <DialogContent className="gap-5 p-7 text-center sm:max-w-md">
      <div className="mx-auto flex size-20 items-center justify-center rounded-3xl bg-blue-3"><AssistantAvatar icon="dot" className="size-12" /></div>
      <div className="space-y-3">
        <DialogTitle className="text-2xl">{t("assistant.announcement_title")}</DialogTitle>
        <DialogDescription className="text-sm leading-relaxed">{t("assistant.announcement_description")}</DialogDescription>
      </div>
      <div className="flex flex-col gap-2">
        <Button onClick={onOpenAssistant}>{t("assistant.announcement_open")}</Button>
        <Button variant="ghost" onClick={onDismiss}>{t("assistant.announcement_later")}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
