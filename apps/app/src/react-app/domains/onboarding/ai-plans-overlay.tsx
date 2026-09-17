/** @jsxImportSource react */
/**
 * The plan screen. LegalWork has no free model tier, so while no model is
 * usable (see aiAccessState) this screen lies over the blurred app, and it is
 * the last onboarding step. Three cards: "own model" on the left, then the
 * same Plus and Pro cards as the platform's plan comparison.
 *
 *  - Own model is free and opens the provider connection. Closing that
 *    without connecting lands back here: the route keeps the screen up until
 *    a model is usable.
 *  - Plus and Pro run the Eigenwelt sign-in in the browser and carry the plan,
 *    so a firm without a subscription lands on that plan's checkout (sign-up,
 *    firm, trial) and the app connects when it is done.
 *
 * The variant follows the account: "signed-out" asks to sign in first (the
 * cards stay one click away), "ended" offers to restart a plan, and
 * "no-models" sends the firm to its billing page to upgrade.
 *
 * Analytics (in memory only, like every other app event): the route sends
 * ai_plans_viewed, ai_plans_own_model_closed and ai_plans_completed; this
 * screen sends what happens on it. Every event carries `mode` and `variant`.
 *   ai_plans_option_selected     { choice, previous_choice } own_model | plus | pro | sign_in;
 *                                previous_choice is the earlier choice on this
 *                                screen, e.g. own_model before plus
 *   ai_plans_sign_in_started     { choice } the browser opened
 *   ai_plans_sign_in_cancelled   { choice } "Cancel" while the browser was open
 *   ai_plans_sign_in_failed      { choice }
 *   ai_plans_connected           { choice } the sign-in finished
 *   ai_plans_other_options_clicked          "See plans and other options"
 *   ai_plans_account_switched               "Use another account"
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Check, KeyRound, Loader2, Sparkles, type LucideIcon } from "lucide-react";

import legalworkMark from "@/assets/legalwork-mark-dark.svg";
import { Button } from "@/components/ui/button";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { openDesktopUrl } from "@/app/lib/desktop";
import type { AiPlansVariant } from "@/app/lib/eigenwelt-access";
import {
  EIGENWELT_PLANS,
  formatEuroCents,
  type EigenweltPlan,
  type EigenweltPlanId,
} from "@/app/lib/eigenwelt-plans";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { cn } from "@/lib/utils";
import { StepDots } from "./onboarding-cover";

type SignInResult = { connected: boolean; cancelled?: boolean; message?: string };

export type AiPlansAccount = { email: string | null; firmName: string | null };

/** What a user can pick on the screen, as analytics names it. */
type AiPlansChoice = "own_model" | EigenweltPlanId | "sign_in";

export type AiPlansOverlayProps = {
  /** "onboarding": the last onboarding step (step dots, Back). "gate": no model is usable. */
  mode: "onboarding" | "gate";
  variant: AiPlansVariant;
  /** The account the screen talks about: the remembered one, or the signed-in one. */
  account: AiPlansAccount | null;
  /** The LegalWork server is up. Every action needs it. */
  serverReady: boolean;
  /** Bind the sign-in loopback and return the platform URL to open. */
  onStartSignIn: (opts: {
    intent?: "sign-in";
    plan?: EigenweltPlanId;
  }) => Promise<{ authorizeUrl: string; sessionId: string }>;
  /** Long-poll until the browser flow completes. */
  onWaitSignIn: (sessionId: string, opts: { cancelled: () => boolean }) => Promise<SignInResult>;
  /** The browser flow finished and the app is connected. */
  onSignedIn: (plan: EigenweltPlanId | null) => void;
  /** "I bring my own model": open the provider connection. */
  onBringOwnModel: () => void;
  /** "no-models": open the firm's billing page. */
  onOpenBilling: () => void;
  /** "no-models": re-read the plan now; true once it includes the models. */
  onCheckModels: () => Promise<boolean>;
  /** Sign out and forget the account ("Use another account"). */
  onUseOtherAccount?: () => Promise<void>;
  /** Onboarding: back to the previous step. */
  onBack?: () => void;
};

type Phase =
  | { kind: "choose" }
  /** A sign-in (with or without a plan) is open in the browser. */
  | { kind: "browser"; plan: EigenweltPlanId | null; authorizeUrl: string }
  /** "no-models": the billing page is open; the plan is re-read until it has the models. */
  | { kind: "upgrade"; timedOut: boolean }
  /** Signed in: waiting for the account to show up before the screen closes. */
  | { kind: "connecting" };

const UPGRADE_POLL_MS = 3_000;
const UPGRADE_TIMEOUT_MS = 10 * 60_000;
/** A sign-in that connected but never made a model usable falls back to the choices. */
const CONNECTING_TIMEOUT_MS = 20_000;

const TAGLINE: Record<EigenweltPlanId, string> = {
  plus: "ai_plans.tagline_plus",
  pro: "ai_plans.tagline_pro",
};

/** What each plan lists, in order; "usage" is the included amount. Pro only adds to Plus. */
const FEATURES: Record<EigenweltPlanId, string[]> = {
  plus: [
    "ai_plans.feature_models",
    "usage",
    "ai_plans.feature_hub",
    "ai_plans.feature_admin",
    "ai_plans.feature_hosting_retention",
  ],
  pro: ["usage", "ai_plans.feature_pro_headroom"],
};

// Side by side, each card spans the row's five tracks (name, tagline, price,
// action, features), so the buttons line up across the cards whatever the
// length of the text above them.
const cardClass =
  "flex flex-col rounded-2xl border border-dls-border bg-dls-surface p-5 shadow-[0_24px_60px_-34px_rgba(15,23,42,0.45)] md:row-span-5 md:grid md:grid-rows-subgrid md:gap-y-0 xl:p-6 roomy:p-7";
const planButtonClass = "h-11 w-full rounded-full text-[14px] roomy:h-12 roomy:text-[15px]";
const textLinkClass =
  "font-medium text-dls-text underline underline-offset-2 transition-opacity hover:opacity-80 disabled:pointer-events-none disabled:opacity-45";

/** The code-painted flower: the LegalWork and Eigenwelt mark. */
function BrandMark(props: { size: number; className?: string }) {
  return (
    <img
      src={legalworkMark}
      alt=""
      aria-hidden
      draggable={false}
      width={props.size}
      height={props.size}
      className={`shrink-0 select-none ${props.className ?? ""}`}
    />
  );
}

function accountLabel(account: AiPlansAccount | null): string | null {
  if (!account) return null;
  if (account.email && account.firmName) return `${account.email} (${account.firmName})`;
  return account.email ?? account.firmName ?? null;
}

/** One line of a card's list. The first line of a list can be `strong`, with its own icon. */
function FeatureRow(props: { children: ReactNode; strong?: boolean; icon?: LucideIcon }) {
  const Icon = props.icon ?? Check;
  return (
    <li className={props.strong ? "flex items-start gap-2.5 font-medium" : "flex items-start gap-2.5"}>
      <Icon
        className={
          props.strong
            ? "mt-px size-4 shrink-0 roomy:mt-[3px]"
            : "mt-px size-4 shrink-0 text-dls-secondary roomy:mt-[3px]"
        }
      />
      <span>{props.children}</span>
    </li>
  );
}

/** Name, tagline, price with its terms below, action, features: the platform's card, in the app's tokens. Five children, one per track. */
function CardFrame(props: {
  icon?: ReactNode;
  name: string;
  tagline: string;
  price: string;
  priceSuffix: string;
  action: ReactNode;
  features: ReactNode;
  testId: string;
}) {
  return (
    <article className={cardClass} data-testid={props.testId}>
      <h2 className="flex items-center gap-2 text-[26px] font-medium leading-none tracking-[-0.03em] text-dls-text roomy:gap-2.5 roomy:text-[30px]">
        {props.icon ? (
          <span aria-hidden className="flex size-6 shrink-0 items-center justify-center roomy:size-7">
            {props.icon}
          </span>
        ) : null}
        {props.name}
      </h2>
      <p className="mt-2 text-[13.5px] leading-5 text-dls-secondary roomy:mt-2.5 roomy:text-[14.5px] roomy:leading-[22px]">
        {props.tagline}
      </p>
      <div className="mt-4 roomy:mt-5">
        <div className="text-[34px] font-medium leading-none tracking-[-0.04em] text-dls-text tabular-nums roomy:text-[44px]">
          {props.price}
        </div>
        <div className="mt-1.5 text-[13px] leading-[18px] text-dls-secondary roomy:mt-2 roomy:text-[15px] roomy:leading-[22px]">
          {props.priceSuffix}
        </div>
      </div>
      <div className="mt-5 roomy:mt-6">{props.action}</div>
      <ul className="mt-5 space-y-2 border-t border-dls-border pt-5 text-[13px] leading-[18px] text-dls-text roomy:mt-6 roomy:space-y-2.5 roomy:pt-6 roomy:text-[14px] roomy:leading-5">
        {props.features}
      </ul>
    </article>
  );
}

function PlanCard(props: {
  plan: EigenweltPlan;
  locale: string;
  label: string;
  disabled: boolean;
  onChoose: () => void;
}) {
  const { plan, locale } = props;
  return (
    <CardFrame
      testId={`ai-plan-${plan.id}`}
      icon={<BrandMark size={28} className="size-6 roomy:size-7" />}
      name={plan.name}
      tagline={t(TAGLINE[plan.id])}
      price={formatEuroCents(plan.yearlyPerMonthCents, locale)}
      priceSuffix={t("ai_plans.per_seat_month")}
      action={
        <Button size="lg" className={planButtonClass} disabled={props.disabled} onClick={props.onChoose}>
          {props.label}
        </Button>
      }
      features={
        <>
          {plan.id === "pro" ? (
            <FeatureRow strong icon={Sparkles}>
              {t("ai_plans.everything_in_plus")}
            </FeatureRow>
          ) : null}
          {FEATURES[plan.id].map((key) => (
            <FeatureRow key={key}>
              {key === "usage"
                ? t("ai_plans.feature_usage", {
                    amount: formatEuroCents(plan.includedMonthlyUsageCents, locale),
                  })
                : t(key)}
            </FeatureRow>
          ))}
        </>
      }
    />
  );
}

function OwnModelCard(props: { disabled: boolean; onChoose: () => void }) {
  return (
    <CardFrame
      testId="ai-plan-byo"
      name={t("ai_plans.byo_name")}
      tagline={t("ai_plans.byo_tagline")}
      price={t("ai_plans.byo_price")}
      priceSuffix={t("ai_plans.byo_price_suffix")}
      action={
        <Button
          variant="secondary"
          size="lg"
          className={planButtonClass}
          disabled={props.disabled}
          onClick={props.onChoose}
        >
          {t("ai_plans.byo_cta")}
        </Button>
      }
      features={
        <>
          {/* The one thing to know before choosing this card: it needs a provider. */}
          <FeatureRow strong icon={KeyRound}>
            {t("ai_plans.byo_feature_requirement")}
          </FeatureRow>
        </>
      }
    />
  );
}

/** A single centered card: the sign-in greeting and the waiting states. */
function FocusCard(props: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[440px] rounded-2xl border border-dls-border bg-dls-surface px-8 py-9 text-center shadow-[0_24px_60px_-34px_rgba(15,23,42,0.45)] roomy:max-w-[480px] roomy:px-10 roomy:py-11">
      {props.children}
    </div>
  );
}

function BackButton(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 text-[13px] text-dls-secondary transition-colors hover:text-dls-text roomy:text-[14px]"
      onClick={props.onClick}
    >
      <ArrowLeft className="size-3.5" />
      {t("onboarding.back")}
    </button>
  );
}

export function AiPlansOverlay(props: AiPlansOverlayProps) {
  const locale = useLocale();
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  // "signed-out" starts on the sign-in card; this shows the cards instead.
  const [showPlans, setShowPlans] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  // Bumping cancels whatever flow is running (a sign-in wait, the upgrade poll).
  const flowRef = useRef(0);
  useEffect(() => () => void ++flowRef.current, []);
  // The upgrade poll outlives renders: it calls the newest check.
  const checkModelsRef = useRef(props.onCheckModels);
  useEffect(() => {
    checkModelsRef.current = props.onCheckModels;
  }, [props.onCheckModels]);
  // The previous choice on this screen, so a funnel can see "own model first,
  // then a plan". Lives as long as the screen does.
  const lastChoiceRef = useRef<AiPlansChoice | null>(null);

  const { mode, variant } = props;
  const signInFirst = variant === "signed-out" && !showPlans;

  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // The account changed under the screen (a sign-in connected a firm without
  // a plan, a subscription ended): start over from the new variant's choices.
  // A flow still open in the browser keeps running.
  const variantRef = useRef(variant);
  useEffect(() => {
    if (variantRef.current === variant) return;
    variantRef.current = variant;
    setShowPlans(false);
    setPhase((current) => (current.kind === "connecting" ? { kind: "choose" } : current));
  }, [variant]);

  useEffect(() => {
    if (phase.kind !== "connecting") return;
    const timer = window.setTimeout(() => setPhase({ kind: "choose" }), CONNECTING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [phase.kind]);

  const disabled = !props.serverReady || switchingAccount;

  const trackChoice = (choice: AiPlansChoice) => {
    captureAnalyticsEvent("ai_plans_option_selected", {
      choice,
      previous_choice: lastChoiceRef.current ?? "none",
      mode,
      variant,
    });
    lastChoiceRef.current = choice;
  };

  const signIn = async (plan: EigenweltPlanId | null) => {
    if (disabled) return;
    const flow = ++flowRef.current;
    const choice: AiPlansChoice = plan ?? "sign_in";
    setError(null);
    trackChoice(choice);
    // New customers land on sign-up; everyone who had an account on sign-in.
    const intent = variant === "new" && plan ? undefined : ("sign-in" as const);
    try {
      const { authorizeUrl, sessionId } = await props.onStartSignIn({
        ...(intent ? { intent } : {}),
        ...(plan ? { plan } : {}),
      });
      if (flowRef.current !== flow) return;
      setPhase({ kind: "browser", plan, authorizeUrl });
      captureAnalyticsEvent("ai_plans_sign_in_started", { choice, mode, variant });
      await openDesktopUrl(authorizeUrl);
      const result = await props.onWaitSignIn(sessionId, {
        cancelled: () => flowRef.current !== flow,
      });
      if (flowRef.current !== flow) return;
      if (result.connected) {
        captureAnalyticsEvent("ai_plans_connected", { choice, mode, variant });
        setPhase({ kind: "connecting" });
        props.onSignedIn(plan);
        return;
      }
      setPhase({ kind: "choose" });
      if (!result.cancelled && result.message) setError(result.message);
    } catch (signInError) {
      if (flowRef.current !== flow) return;
      setPhase({ kind: "choose" });
      setError(signInError instanceof Error ? signInError.message : String(signInError));
      captureAnalyticsEvent("ai_plans_sign_in_failed", { choice, mode, variant });
    }
  };

  const upgrade = (plan: EigenweltPlanId) => {
    if (disabled) return;
    const flow = ++flowRef.current;
    setError(null);
    trackChoice(plan);
    props.onOpenBilling();
    setPhase({ kind: "upgrade", timedOut: false });
    const deadline = Date.now() + UPGRADE_TIMEOUT_MS;
    const poll = async () => {
      if (flowRef.current !== flow) return;
      const included = await checkModelsRef.current().catch(() => false);
      if (flowRef.current !== flow) return;
      if (included) {
        setPhase({ kind: "connecting" });
        return;
      }
      if (Date.now() > deadline) {
        setPhase({ kind: "upgrade", timedOut: true });
        return;
      }
      window.setTimeout(() => void poll(), UPGRADE_POLL_MS);
    };
    void poll();
  };

  const choosePlan = (plan: EigenweltPlanId) => {
    if (variant === "no-models") upgrade(plan);
    else void signIn(plan);
  };

  const bringOwnModel = () => {
    if (disabled) return;
    setError(null);
    trackChoice("own_model");
    props.onBringOwnModel();
  };

  const cancelFlow = () => {
    if (phase.kind === "browser") {
      captureAnalyticsEvent("ai_plans_sign_in_cancelled", {
        choice: phase.plan ?? "sign_in",
        mode,
        variant,
      });
    }
    ++flowRef.current;
    setPhase({ kind: "choose" });
  };

  const switchAccount = async () => {
    if (!props.onUseOtherAccount || switchingAccount) return;
    ++flowRef.current;
    setSwitchingAccount(true);
    setError(null);
    captureAnalyticsEvent("ai_plans_account_switched", { mode, variant });
    try {
      await props.onUseOtherAccount();
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    } finally {
      setSwitchingAccount(false);
    }
  };

  const planLabel = (plan: EigenweltPlan) => {
    switch (variant) {
      case "new":
        return t("ai_plans.try", { plan: plan.name });
      case "ended":
        return t("ai_plans.restart", { plan: plan.name });
      case "no-models":
        return t("ai_plans.upgrade", { plan: plan.name });
      default:
        return t("ai_plans.get", { plan: plan.name });
    }
  };
  const firm = props.account?.firmName ?? t("ai_plans.your_firm");
  const title =
    variant === "ended"
      ? t("ai_plans.title_ended")
      : variant === "no-models"
        ? t("ai_plans.title_no_models")
        : t("ai_plans.title");
  const subtitle =
    variant === "ended"
      ? t("ai_plans.subtitle_ended", { firm })
      : variant === "no-models"
        ? t("ai_plans.subtitle_no_models", { firm })
        : variant === "signed-out"
          ? t("ai_plans.subtitle_returning")
          : t("ai_plans.subtitle");
  const account = accountLabel(props.account);

  const notice = error ? (
    <p role="alert" className="text-[12.5px] leading-relaxed text-red-11">
      {error}
    </p>
  ) : !props.serverReady ? (
    <p className="text-[12.5px] leading-relaxed text-dls-secondary">{t("ai_plans.server_starting")}</p>
  ) : null;

  const stepDots =
    mode === "onboarding" ? (
      <div className="flex justify-center [&>div]:mb-4">
        <StepDots step={5} total={5} />
      </div>
    ) : null;

  const backRow =
    mode === "onboarding" && props.onBack ? <BackButton onClick={props.onBack} /> : null;

  let body: ReactNode;
  // Pinned to the bottom of the window: Back on the left, the account line in the middle.
  let footerCenter: ReactNode = null;
  if (phase.kind === "browser" || phase.kind === "upgrade" || phase.kind === "connecting") {
    const waitingBody =
      phase.kind === "browser"
        ? phase.plan
          ? t("ai_plans.waiting_body_plan", {
              plan: EIGENWELT_PLANS.find((plan) => plan.id === phase.plan)?.name ?? phase.plan,
            })
          : t("ai_plans.waiting_body_sign_in")
        : phase.kind === "upgrade"
          ? phase.timedOut
            ? t("ai_plans.upgrade_timeout")
            : t("ai_plans.waiting_body_upgrade")
          : null;
    const spinning = !(phase.kind === "upgrade" && phase.timedOut);
    body = (
      <FocusCard>
        {spinning ? (
          <Loader2 className="mx-auto size-7 animate-spin text-dls-secondary" />
        ) : (
          <BrandMark size={36} className="mx-auto" />
        )}
        <h1 id={titleId} className="mt-5 text-[22px] font-medium tracking-[-0.02em] text-dls-text">
          {phase.kind === "connecting" ? t("ai_plans.connecting") : t("ai_plans.waiting_title")}
        </h1>
        {waitingBody ? (
          <p className="mt-2 text-[13.5px] leading-[1.6] text-dls-secondary">{waitingBody}</p>
        ) : null}
        {phase.kind === "browser" ? (
          <Button
            variant="outline"
            size="lg"
            className="mt-6 h-10 w-full rounded-full"
            onClick={() => void openDesktopUrl(phase.authorizeUrl)}
          >
            {t("ai_plans.open_again")}
          </Button>
        ) : null}
        {phase.kind === "upgrade" ? (
          <Button
            variant="outline"
            size="lg"
            className="mt-6 h-10 w-full rounded-full"
            onClick={props.onOpenBilling}
          >
            {t("ai_plans.open_again")}
          </Button>
        ) : null}
        {phase.kind !== "connecting" ? (
          <button
            type="button"
            className="mt-4 text-[13px] text-dls-secondary underline underline-offset-2 transition-colors hover:text-dls-text"
            onClick={cancelFlow}
          >
            {t("ai_plans.cancel")}
          </button>
        ) : null}
      </FocusCard>
    );
  } else if (signInFirst) {
    body = (
      <div className="mx-auto flex w-full max-w-[480px] flex-col">
        {stepDots}
        <FocusCard>
          <BrandMark size={52} className="mx-auto" />
          <h1
            id={titleId}
            className="mt-5 text-[28px] font-medium leading-[1.1] tracking-[-0.03em] text-dls-text"
          >
            {t("ai_plans.welcome_title")}
          </h1>
          <p className="mt-2.5 text-[14px] leading-[1.6] text-dls-secondary">{t("ai_plans.welcome_body")}</p>
          {account ? (
            <p className="mt-3 break-words text-[13px] text-dls-text">
              {t("ai_plans.welcome_account", { account })}
            </p>
          ) : null}
          {notice ? <div className="mt-4">{notice}</div> : null}
          <Button
            size="lg"
            className={`mt-7 ${planButtonClass}`}
            disabled={disabled}
            onClick={() => void signIn(null)}
          >
            {t("ai_plans.sign_in_cta")}
          </Button>
          <button
            type="button"
            className="mt-4 text-[13px] text-dls-secondary underline underline-offset-2 transition-colors hover:text-dls-text"
            onClick={() => {
              captureAnalyticsEvent("ai_plans_other_options_clicked", { mode, variant });
              setError(null);
              setShowPlans(true);
            }}
          >
            {t("ai_plans.other_options")}
          </button>
        </FocusCard>
      </div>
    );
  } else {
    body = (
      <>
        <header className="mx-auto max-w-[760px] text-center roomy:max-w-[900px]">
          {stepDots}
          <h1
            id={titleId}
            className="text-[30px] font-medium leading-[1.08] tracking-[-0.035em] text-dls-text lg:text-[32px] roomy:text-[38px]"
          >
            {title}
          </h1>
          <p className="mx-auto mt-2.5 max-w-[740px] text-[14px] leading-[1.6] text-dls-secondary roomy:mt-3 roomy:max-w-[860px] roomy:text-[15.5px]">
            {subtitle}
          </p>
          {notice ? <div className="mt-4">{notice}</div> : null}
        </header>
        <div className="mt-10 grid gap-4 md:grid-cols-3 md:gap-x-4 md:gap-y-0 xl:gap-x-5 roomy:mt-14 roomy:gap-x-7">
          <OwnModelCard disabled={disabled} onChoose={bringOwnModel} />
          {EIGENWELT_PLANS.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              locale={locale}
              label={planLabel(plan)}
              disabled={disabled}
              onChoose={() => choosePlan(plan.id)}
            />
          ))}
        </div>
      </>
    );
    footerCenter = (
      <p className="text-center text-[13px] text-dls-secondary roomy:text-[14px]">
        {variant === "new" ? (
          <>
            {t("ai_plans.sign_in_prompt")}{" "}
            <button
              type="button"
              className={textLinkClass}
              disabled={disabled}
              onClick={() => void signIn(null)}
            >
              {t("ai_plans.sign_in_link")}
            </button>
          </>
        ) : variant === "signed-out" ? (
          <button type="button" className={textLinkClass} onClick={() => setShowPlans(false)}>
            {t("ai_plans.back_to_sign_in")}
          </button>
        ) : (
          <>
            {account ? `${t("ai_plans.signed_in_as", { account })} ` : null}
            {props.onUseOtherAccount ? (
              <button
                type="button"
                className={textLinkClass}
                disabled={switchingAccount}
                onClick={() => void switchAccount()}
              >
                {t("ai_plans.use_other_account")}
              </button>
            ) : null}
          </>
        )}
      </p>
    );
  }

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-testid="ai-plans-overlay"
      className={cn(
        "fixed inset-0 z-40 flex flex-col bg-background/35 outline-none backdrop-blur-[14px] dark:bg-background/70",
        // Over a working app the screen fades in. In onboarding it follows
        // an opaque step, and a fade would show the bare app first.
        props.mode === "gate" && "duration-300 animate-in fade-in-0",
      )}
    >
      {/* The window stays draggable by its top edge while the screen covers
          it (macOS app only, like the onboarding covers' titlebar region). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 mac:pointer-events-auto mac:titlebar-drag"
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[1200px] flex-col px-6 lg:px-8 roomy:max-w-[1360px] roomy:px-12">
          <div className="flex flex-1 flex-col justify-center py-8 roomy:py-10">{body}</div>
          {backRow || footerCenter ? (
            <footer className="flex flex-col items-center gap-3 pb-6 pt-2 md:grid md:grid-cols-[1fr_auto_1fr] roomy:pb-8">
              <div className="justify-self-start">{backRow}</div>
              {footerCenter ?? <div />}
              <div />
            </footer>
          ) : null}
        </div>
      </div>
    </div>
  );
}
