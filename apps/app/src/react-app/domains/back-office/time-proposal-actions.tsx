import { Check, X } from "lucide-react";
import { createContext, useContext, useEffect, useEffectEvent, useRef, type MouseEvent, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export type ProposalDecision = "accept" | "dismiss";
export type DirectProposalDecision = {
  key: string;
  digest: string;
  action: ProposalDecision;
  complete: (ok: boolean) => void;
};

export const DirectProposalDecisionContext = createContext<DirectProposalDecision | undefined>(undefined);

export function ProposalDecisionReceiver({ proposal, accept, dismiss }: {
  proposal: Pick<DirectProposalDecision, "key" | "digest">;
  accept: () => Promise<boolean>;
  dismiss: () => Promise<boolean>;
}) {
  const request = useContext(DirectProposalDecisionContext);
  const handled = useRef<DirectProposalDecision>(undefined);
  const perform = useEffectEvent(async (decision: DirectProposalDecision) => {
    decision.complete(await (decision.action === "accept" ? accept() : dismiss()));
  });
  useEffect(() => {
    if (!request || handled.current === request || request.key !== proposal.key || request.digest !== proposal.digest) return;
    handled.current = request;
    void perform(request);
  }, [request, proposal.key, proposal.digest]);
  return null;
}

export function TimeProposalActions({ busy, canAccept, onDismiss, onAccept, railRef, label }: {
  busy: boolean;
  canAccept: boolean;
  onDismiss: (event: MouseEvent<HTMLButtonElement>) => void;
  onAccept?: (event: MouseEvent<HTMLButtonElement>) => void;
  railRef?: Ref<HTMLDivElement>;
  label?: string;
}) {
  const dismiss = t("timesheets.sheet.decline");
  const accept = t("timesheets.sheet.accept");
  return (
    <div ref={railRef} className="time-proposal-decisions" data-calendar-proposal-actions={railRef ? "" : undefined}
      role={label ? "group" : undefined} aria-label={label}>
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
