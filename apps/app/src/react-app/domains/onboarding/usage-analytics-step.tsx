/** @jsxImportSource react */
import { Page, PageBackground, PageTitlebarRegion } from "@/components/page";

type UsageAnalyticsStepProps = {
  // enabled === user's analytics consent; called once, then onboarding finishes.
  onChoice: (enabled: boolean) => void;
};

/**
 * Final onboarding step: a single usage-analytics consent question. Sets
 * `analyticsEnabled`; never collects document, prompt, or matter content.
 */
export function UsageAnalyticsStep({ onChoice }: UsageAnalyticsStepProps) {
  return (
    <div className="fixed inset-0 z-50 bg-dls-surface">
      <Page className="min-h-screen bg-dls-surface">
        <PageBackground />
        <PageTitlebarRegion />

        <div className="relative z-10 flex min-h-screen items-center justify-center px-6">
          <div className="flex w-full max-w-md flex-col gap-8">
            <div>
              <span className="lw-section-eyebrow uppercase text-dls-secondary">Step four · Privacy</span>
              <h1 className="mt-3 text-[34px] font-medium leading-[1.05] tracking-[-0.035em] text-dls-text">
                Help improve LegalWork
              </h1>
              <p className="mt-3 text-[14px] leading-[1.6] text-dls-secondary">
                Share anonymous usage analytics — which features get used, errors, and performance. Never your
                documents, prompts, or any matter content. You can change this anytime in Settings.
              </p>
            </div>

            <div className="flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => onChoice(true)}
                className="inline-flex w-full items-center justify-center rounded-full bg-dls-accent px-5 py-3 text-[14px] font-medium text-[var(--dls-accent-fg)] transition-colors hover:bg-[var(--dls-accent-hover)]"
              >
                Share anonymous analytics
              </button>
              <button
                type="button"
                onClick={() => onChoice(false)}
                className="inline-flex w-full items-center justify-center rounded-full border border-dls-border bg-dls-surface px-5 py-3 text-[14px] font-medium text-dls-text transition-colors hover:bg-dls-hover"
              >
                Don&apos;t share
              </button>
            </div>

            <p className="text-center text-[12px] leading-relaxed text-dls-secondary/80">
              No document content, prompts, or matter data ever leaves this machine.
            </p>
          </div>
        </div>
      </Page>
    </div>
  );
}
