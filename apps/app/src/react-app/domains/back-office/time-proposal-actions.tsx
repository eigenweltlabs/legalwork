import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function TimeProposalActions({ busy, canAccept, onDismiss, onAccept }: {
  busy: boolean;
  canAccept: boolean;
  onDismiss: () => void;
  onAccept?: () => void;
}) {
  const dismiss = t("timesheets.sheet.decline");
  const accept = t("timesheets.sheet.accept");
  return (
    <div className="time-proposal-decisions">
      <Button type="button" variant="ghost" size="icon-sm" title={dismiss} disabled={busy}
        focusableWhenDisabled onClick={onDismiss}>
        <X aria-hidden="true" /><span className="sr-only">{dismiss}</span>
      </Button>
      <Button type={onAccept ? "button" : "submit"} variant="ghost" size="icon-sm" title={accept}
        disabled={busy || !canAccept} focusableWhenDisabled={busy && canAccept} onClick={onAccept}>
        <Check aria-hidden="true" /><span className="sr-only">{accept}</span>
      </Button>
    </div>
  );
}
