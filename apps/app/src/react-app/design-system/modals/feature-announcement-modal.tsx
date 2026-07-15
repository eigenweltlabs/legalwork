/** @jsxImportSource react */
/**
 * Presentational shell for feature-announcement modals: a deep-navy hero
 * (eyebrow + headline + intro) followed by numbered feature rows and an
 * optional primary CTA plus a dismiss link.
 *
 * It owns no visibility or "seen" state — callers decide when to show it and
 * what dismiss means. Used by the post-update "What's new" dialog and by
 * first-run feature onboarding (e.g. the benchmark screen).
 */
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export type FeatureAnnouncementEntry = { title: string; body: string };

export type FeatureAnnouncementModalProps = {
  open: boolean;
  /** Small uppercase eyebrow inside the hero, e.g. "What's new" / "Benchmark". */
  eyebrow: string;
  headline: string;
  intro: string;
  entries: FeatureAnnouncementEntry[];
  /** Optional primary action button. */
  primaryAction?: { label: string; onClick: () => void };
  /** Optional secondary dismiss link (rendered below the primary action). */
  dismissLabel?: string;
  /** Fired on Esc, backdrop click, or the dismiss link. */
  onDismiss: () => void;
  /**
   * Optional hero background layer (absolutely positioned, behind the text).
   * Replaces the default radial-gradient wash — e.g. the onboarding's grained
   * blue. Rendered inside the same deep-navy hero, so it composites on top.
   */
  heroOverlay?: React.ReactNode;
};

export function FeatureAnnouncementModal(props: FeatureAnnouncementModalProps) {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onDismiss();
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        {/* Hero: the welcome page's deep-navy paper gradient, dialog-sized. */}
        <div className="relative overflow-hidden bg-[#05080f] px-7 pb-8 pt-7">
          {props.heroOverlay ? (
            <div aria-hidden className="absolute inset-0 z-0">
              {props.heroOverlay}
            </div>
          ) : (
            <div
              aria-hidden
              className="absolute inset-0 bg-[radial-gradient(120%_120%_at_85%_-10%,rgba(11, 132, 254,0.55),transparent_55%),radial-gradient(90%_90%_at_0%_110%,rgba(10, 103, 198,0.45),transparent_55%)]"
            />
          )}
          <div className="relative z-10">
            <span className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-white/60">
              <span className="size-[7px] rounded-[1.5px] bg-[#0a58c2] shadow-[0_0_0_3px_rgba(11, 132, 254,0.25)]" />
              {props.eyebrow}
            </span>
            <DialogTitle className="mt-3 text-[26px] font-medium leading-[1.08] tracking-[-0.03em] text-white">
              {props.headline}
            </DialogTitle>
            <p className="mt-2.5 max-w-sm text-[13px] leading-[1.6] text-white/70">{props.intro}</p>
          </div>
        </div>

        {/* Numbered feature rows, exactly like the welcome page steps. */}
        <div className="flex flex-col px-7 py-2">
          {props.entries.map((entry, index) => (
            <div
              key={entry.title}
              className={`flex items-start gap-4 py-4 ${index > 0 ? "border-t border-dls-border" : ""}`}
            >
              <span className="pt-0.5 font-mono text-[12px] tabular-nums text-dls-secondary/70">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <div className="text-[14px] font-medium tracking-[-0.01em] text-dls-text">{entry.title}</div>
                <div className="mt-1 text-[13px] leading-relaxed text-dls-secondary">{entry.body}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-2 px-7 pb-6 pt-1">
          {props.primaryAction ? (
            <Button size="lg" className="w-full text-white" onClick={props.primaryAction.onClick}>
              {props.primaryAction.label}
            </Button>
          ) : null}
          {props.dismissLabel ? (
            <button
              type="button"
              className="w-full py-1.5 text-center text-[12px] text-dls-secondary transition-colors hover:text-dls-text"
              onClick={props.onDismiss}
            >
              {props.dismissLabel}
            </button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
