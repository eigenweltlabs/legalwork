import { CalendarCheck2, Mail, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AssistantAvatar } from "@/react-app/domains/session/sidebar/assistant-appearance";
import { t } from "@/i18n";

export function AssistantUpgradeModal({ open, onDismiss, onUpgrade }: {
  open: boolean; onDismiss: () => void; onUpgrade: () => void;
}) {
  return <Dialog open={open} onOpenChange={value => { if (!value) onDismiss(); }}>
    <DialogContent className="gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-[480px]">
      <div aria-hidden="true" className="relative flex h-48 items-end justify-center gap-2 overflow-hidden bg-gradient-to-b from-sky-50 via-violet-50/70 to-background px-8 pb-2 dark:from-sky-950/30 dark:via-violet-950/20">
        <div className="absolute top-8 rounded-full border border-white/80 bg-background/80 px-4 py-1.5 text-xs font-medium text-muted-foreground">{t("assistant.upgrade_eyebrow")}</div>
        <AssistantAvatar icon="rabbit" motion="idle" className="mb-1 size-24 -rotate-6" />
        <AssistantAvatar icon="cat" motion="idle" className="size-32" />
        <AssistantAvatar icon="bird" motion="idle" className="mb-1 size-24 rotate-6" />
      </div>
      <div className="px-7 pb-6 pt-4 sm:px-9">
        <DialogTitle className="text-center text-[28px] font-semibold leading-tight tracking-tight">{t("assistant.upgrade_title")}</DialogTitle>
        <DialogDescription className="mt-3 text-center text-sm leading-relaxed">{t("assistant.upgrade_description")}</DialogDescription>
        <div className="my-6 space-y-3 text-sm">
          <p className="flex items-center gap-3"><CalendarCheck2 className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />{t("assistant.upgrade_organise")}</p>
          <p className="flex items-center gap-3"><Mail className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />{t("assistant.upgrade_follow_up")}</p>
          <p className="flex items-center gap-3"><Sparkles className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />{t("assistant.upgrade_personal")}</p>
        </div>
        <Button className="h-11 w-full rounded-full" onClick={onUpgrade}>{t("assistant.upgrade_action")}</Button>
        <p className="mt-3 text-center text-xs text-muted-foreground">{t("assistant.upgrade_included")}</p>
        <Button variant="ghost" className="mt-2 w-full rounded-full text-muted-foreground" onClick={onDismiss}>{t("assistant.announcement_later")}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
