/** @jsxImportSource react */
/**
 * The plan screen. LegalWork has no free model tier, so while no model is
 * usable (see aiAccessState) this screen lies over the blurred app, and it is
 * the last onboarding step. A free own-model banner above Plus, Pro and Max cards
 * with the same tiers as the platform.
 *
 *  - Own model is free and opens the provider connection. Closing that
 *    without connecting lands back here: the route keeps the screen up until
 *    a model is usable.
 *  - Paid plans confirm billing and seats here. The browser handles Eigenwelt
 *    sign-in, Stripe checkout and model setup, then connects the app.
 *
 * The variant follows the account: "signed-out" asks to sign in first (the
 * cards stay one click away), "ended" offers to restart a plan, and
 * "no-models" sends the firm to its billing page to upgrade.
 *
 * Analytics (in memory only, like every other app event): the route sends
 * ai_plans_viewed, ai_plans_own_model_closed and ai_plans_completed; this
 * screen sends what happens on it. Every event carries `mode` and `variant`.
 *   ai_plans_option_selected     { choice, previous_choice } own_model | plus | pro | max | sign_in;
 *                                previous_choice is the earlier choice on this
 *                                screen, e.g. own_model before plus
 *   ai_plans_sign_in_started     { choice } the browser opened
 *   ai_plans_confirmation_viewed { plan, interval, seats, trial_offered } once per visit
 *   ai_plans_billing_interval_changed { plan, from, to, seats }
 *   ai_plans_seats_adjusted      { plan, from, to, interval }
 *   ai_plans_confirmation_back  { plan, interval, seats, source } back | change_plan
 *   ai_plans_checkout_confirmed  { plan, interval, seats, trial_offered } native confirmation
 *   ai_plans_sign_in_cancelled   { choice } "Cancel" while the browser was open
 *   ai_plans_sign_in_failed      { choice }
 *   ai_plans_connected           { choice } the sign-in finished
 *   ai_plans_other_options_clicked          "See plans and other options"
 *   ai_plans_account_switched               "Use another account"
 *   ai_plans_updates_opened                 "Check for updates"
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { EigenweltCheckoutSelection } from "@legalwork/types/eigenwelt-checkout";
import {
  ArrowLeft,
  Check,
  Loader2,
  RefreshCcw,
  type LucideIcon,
} from "lucide-react";

import legalworkMark from "@/assets/legalwork-mark-dark.svg";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
import { openDesktopUrl } from "@/app/lib/desktop";
import type { AiPlansVariant } from "@/app/lib/eigenwelt-access";
import { EigenweltSignInTimeoutError } from "@/app/lib/eigenwelt-sign-in";
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
import { PlanConfirmation } from "./plan-confirmation";
import "./ai-plans-transition.css";

type SignInResult = {
  connected: boolean;
  cancelled?: boolean;
  message?: string;
  preferredAiProvider?: "openai" | "other";
};

export type AiPlansAccount = { email: string | null; firmName: string | null };

/** What a user can pick on the screen, as analytics names it. */
type AiPlansChoice = "own_model" | EigenweltPlanId | "sign_in";

export type AiPlansOverlayProps = {
  /** Desktop has six onboarding steps; the web has three. */
  totalSteps?: number;
  /** Assistant requires an AI subscription, even when an own model is connected. */
  assistantUpgrade?: boolean;
  /** "onboarding": connect an AI provider (step dots, Back). "gate": no model is usable. */
  mode: "onboarding" | "gate";
  variant: AiPlansVariant;
  /** The account the screen talks about: the remembered one, or the signed-in one. */
  account: AiPlansAccount | null;
  /** The LegalWork server is up. Every action needs it. */
  serverReady: boolean;
  /** Project approval must stay reachable while this screen covers the app. */
  projectApproval?: ReactNode;
  initialSeats?: number;
  /** Bind the sign-in loopback and return the platform URL to open. */
  onStartSignIn: (opts: {
    intent?: "sign-in";
    plan?: EigenweltPlanId;
    checkout?: EigenweltCheckoutSelection;
  }) => Promise<{ authorizeUrl: string; sessionId: string }>;
  /** Long-poll until the browser flow completes. */
  onWaitSignIn: (
    sessionId: string,
    opts: { cancelled: () => boolean },
  ) => Promise<SignInResult>;
  /** The browser flow finished and the app is connected. */
  onSignedIn: (plan: EigenweltPlanId | null) => void;
  /** "I bring my own model": open the provider connection. */
  onBringOwnModel: (preferredProviderId?: string) => void;
  /** "no-models": open the firm's billing page. */
  onOpenBilling: () => void;
  /** "no-models": re-read the plan now; true once it includes the models. */
  onCheckModels: () => Promise<boolean>;
  /** Sign out and forget the account ("Use another account"). */
  onUseOtherAccount?: () => Promise<void>;
  /** Onboarding: back to the previous step. */
  onBack?: () => void;
  /**
   * Open the app's update settings above the screen. Offered in every state,
   * so an app that cannot get past this screen can still be updated.
   */
  onOpenUpdates?: () => void;
};

type Phase =
  | { kind: "choose" }
  | { kind: "confirm"; plan: EigenweltPlanId }
  | { kind: "expired" }
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

const TAGLINE: Record<EigenweltPlan["id"], string> = {
  plus: "ai_plans.tagline_plus",
  pro: "ai_plans.tagline_pro",
  max: "ai_plans.tagline_max",
};

const FEATURES = [
  "ai_plans.feature_models",
  "ai_plans.feature_ai_tasks",
  "ai_plans.feature_hub",
  "ai_plans.feature_matter_management",
  "ai_plans.feature_office",
  "ai_plans.feature_hosting_retention",
];

// Side by side, each card spans six tracks (name, tagline, price, usage,
// action, features), so the buttons line up across the cards whatever the
// length of the text above them.
const cardClass =
  "flex flex-col rounded-2xl border border-dls-border bg-dls-surface p-4 md:row-span-6 md:grid md:grid-rows-subgrid md:gap-y-0 roomy:p-5";
const planButtonClass =
  "h-10 w-full rounded-full text-[14px] roomy:h-11 roomy:text-[15px]";
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
  if (account.email && account.firmName)
    return `${account.email} (${account.firmName})`;
  return account.email ?? account.firmName ?? null;
}

/** One line of a card's list. The first line of a list can be `strong`, with its own icon. */
function FeatureRow(props: {
  children: ReactNode;
  strong?: boolean;
  icon?: LucideIcon;
}) {
  const Icon = props.icon ?? Check;
  return (
    <li
      className={
        props.strong
          ? "flex items-start gap-2.5 font-medium"
          : "flex items-start gap-2.5"
      }
    >
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

/** Name, tagline, price, included usage, action and features in the app's tokens. */
function CardFrame(props: {
  icon?: ReactNode;
  name: string;
  tagline: string;
  price: string;
  priceSuffix: string;
  action: ReactNode;
  features: ReactNode;
  usage: ReactNode;
  testId: string;
  switcher?: ReactNode;
}) {
  return (
    <article className={cardClass} data-testid={props.testId} style={{ viewTransitionName: props.testId.replace("ai-plan-", "ai-plan-card-") }}>
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[26px] font-medium leading-none tracking-[-0.03em] text-dls-text roomy:gap-2.5 roomy:text-[30px]" style={{ viewTransitionName: props.testId.replace("ai-plan-", "ai-plan-name-") }}>
          {props.icon ? (
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center roomy:size-7"
            >
              {props.icon}
            </span>
          ) : null}
          {props.name}
        </h2>
        {props.switcher}
      </div>
      <p className="ai-plan-tagline mt-2 text-[12px] leading-[18px] text-dls-secondary roomy:text-[13.5px] roomy:leading-5">
        {props.tagline}
      </p>
      <div className="mt-3 roomy:mt-4">
        <div className="text-[34px] font-medium leading-none tracking-[-0.04em] text-dls-text tabular-nums roomy:text-[44px]" style={{ viewTransitionName: props.testId.replace("ai-plan-", "ai-plan-price-") }}>
          {props.price}
        </div>
        <div className="mt-1.5 text-[13px] leading-[18px] text-dls-secondary roomy:mt-2 roomy:text-[15px] roomy:leading-[22px]">
          {props.priceSuffix}
        </div>
      </div>
      {props.usage}
      <div className="mt-3 roomy:mt-4">{props.action}</div>
      {props.features}
    </article>
  );
}

function PlanCard(props: {
  plan: EigenweltPlan;
  locale: string;
  label: string;
  disabled: boolean;
  onChoose: () => void;
  interval: EigenweltCheckoutSelection["interval"];
  switcher?: ReactNode;
}) {
  const { plan, locale } = props;
  const price = props.interval === "year" ? plan.yearlyPerMonthCents : plan.monthlyCents;
  const features = [...FEATURES];
  if (locale === "de") features.push("ai_plans.feature_confidentiality");
  if (plan.id !== "plus") features.push(
    "ai_plans.feature_admin",
    "ai_plans.feature_priority_support",
  );
  return (
    <CardFrame
      testId={`ai-plan-${plan.id}`}
      switcher={props.switcher}
      icon={<BrandMark size={28} className="size-6 roomy:size-7" />}
      name={plan.name}
      tagline={t(TAGLINE[plan.id])}
      price={formatEuroCents(price, locale)}
      priceSuffix={t("ai_plans.per_seat_month")}
      usage={
        <div className="mt-3 rounded-xl bg-muted/65 p-3 roomy:mt-4" role="group" aria-label={t("ai_plans.included_usage")}>
          <p className="text-xs text-dls-secondary">{t("ai_plans.included_usage")}</p>
          <p className="mt-2 flex flex-wrap items-baseline gap-2 tabular-nums">
            {plan.includedMonthlyUsageCents > price && <s aria-hidden="true" className="text-sm text-dls-secondary">{formatEuroCents(price, locale)}</s>}
            <strong className="text-2xl font-medium tracking-tight text-dls-text roomy:text-[28px]">{formatEuroCents(plan.includedMonthlyUsageCents, locale)}</strong>
            <span className="text-xs text-dls-secondary">{t("ai_plans.per_month")}</span>
          </p>
        </div>
      }
      action={
        <Button
          size="lg"
          className={planButtonClass}
          disabled={props.disabled}
          onClick={props.onChoose}
        >
          {props.label}
        </Button>
      }
      features={
        <div className="mt-3 flex flex-col border-t border-dls-border pt-3 text-[12px] leading-[18px] text-dls-text roomy:text-[13px] roomy:leading-5">
          <ul className="mb-2 space-y-1.5">
            <FeatureRow>{t("ai_plans.feature_models")}</FeatureRow>
            <FeatureRow>{t("ai_plans.summary_team")}</FeatureRow>
            {plan.id !== "plus" && <FeatureRow>{t("ai_plans.summary_admin")}</FeatureRow>}
          </ul>
          <Dialog>
            <DialogTrigger render={<button type="button" className="mt-auto self-start rounded-sm text-xs font-medium text-dls-secondary underline underline-offset-4 transition-colors hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30" />}>
              {t("ai_plans.view_features")}
            </DialogTrigger>
            <DialogContent className="max-h-[calc(100dvh-3rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{t("ai_plans.features_title", { plan: plan.name })}</DialogTitle>
                <DialogDescription>{t(TAGLINE[plan.id])}</DialogDescription>
              </DialogHeader>
              <ul className="min-h-0 space-y-3 overflow-y-auto text-[13px] leading-5">
                {features.map(key => <FeatureRow key={key}>{t(key)}</FeatureRow>)}
              </ul>
            </DialogContent>
          </Dialog>
        </div>
      }
    />
  );
}

function OwnModelBanner(props: { disabled: boolean; onChoose: () => void }) {
  return (
    <aside data-testid="ai-plan-byo" className="ai-plan-own mt-4 flex flex-col items-start justify-between gap-3 rounded-2xl border border-dls-border bg-dls-surface px-4 py-3 md:flex-row md:items-center">
      <div>
        <h2 className="text-base font-medium text-dls-text">{t("ai_plans.free_banner")}</h2>
        <p className="mt-1 text-xs leading-[18px] text-dls-secondary">{t("ai_plans.free_description")}</p>
      </div>
      <Button variant="secondary" className="h-9 shrink-0 rounded-full text-xs" disabled={props.disabled} onClick={props.onChoose}>
        {t("ai_plans.byo_cta")}
      </Button>
    </aside>
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

function UpdatesLink(props: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 text-[13px] text-dls-secondary transition-colors hover:text-dls-text roomy:text-[14px]"
      onClick={props.onClick}
    >
      <RefreshCcw className="size-3.5" />
      {t("ai_plans.check_updates")}
    </button>
  );
}

export function AiPlansOverlay(props: AiPlansOverlayProps) {
  const locale = useLocale();
  const { mode, variant } = props;
  const titleId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "choose" });
  const [checkout, setCheckout] = useState<EigenweltCheckoutSelection>({ interval: "year", seats: Math.min(Math.max(props.initialSeats ?? 1, 1), 500) });
  const transitionRef = useRef<ViewTransition | null>(null);
  const confirmationVisitRef = useRef<EigenweltPlanId | null>(null);
  const choiceScroll = useRef(0);
  const confirmPlan = (plan: EigenweltPlanId | null, source?: "back" | "change_plan") => {
    if (!plan && phase.kind === "confirm" && source) {
      captureAnalyticsEvent("ai_plans_confirmation_back", { plan: phase.plan, interval: checkout.interval, seats: checkout.seats, source, mode, variant });
    }
    const scroller = containerRef.current?.querySelector<HTMLElement>(".overflow-y-auto");
    if (plan) choiceScroll.current = scroller?.scrollTop ?? 0;
    const update = () => {
      flushSync(() => setPhase(plan ? { kind: "confirm", plan } : { kind: "choose" }));
      const heading = containerRef.current?.querySelector<HTMLElement>("h1");
      if (heading?.hasAttribute("tabindex")) heading.focus({ preventScroll: true });
      else containerRef.current?.focus({ preventScroll: true });
      scroller?.scrollTo({ top: plan ? 0 : choiceScroll.current, behavior: "instant" });
    };
    if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { update(); return; }
    transitionRef.current?.skipTransition();
    document.documentElement.dataset.aiPlanTransition = "true";
    const active = document.startViewTransition(update);
    transitionRef.current = active;
    void active.ready.catch(() => {});
    void active.finished.finally(() => {
      if (transitionRef.current === active) { transitionRef.current = null; delete document.documentElement.dataset.aiPlanTransition; }
    }).catch(() => {});
  };
  useEffect(() => () => { transitionRef.current?.skipTransition(); delete document.documentElement.dataset.aiPlanTransition; }, []);
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

  const signInFirst = variant === "signed-out" && !showPlans;
  const offerTrial = variant === "new" || variant === "signed-out";

  useEffect(() => {
    if (phase.kind !== "confirm") { confirmationVisitRef.current = null; return; }
    // Billing edits and Strict Mode effect replays are still the same visit.
    if (confirmationVisitRef.current === phase.plan) return;
    confirmationVisitRef.current = phase.plan;
    captureAnalyticsEvent("ai_plans_confirmation_viewed", { plan: phase.plan, interval: checkout.interval, seats: checkout.seats, trial_offered: offerTrial, mode, variant });
  }, [phase, checkout.interval, checkout.seats, offerTrial, mode, variant]);

  const changeCheckout = (selection: EigenweltCheckoutSelection) => {
    const plan = phase.kind === "confirm" ? phase.plan : null;
    if (selection.interval !== checkout.interval) {
      captureAnalyticsEvent("ai_plans_billing_interval_changed", { plan, from: checkout.interval, to: selection.interval, seats: selection.seats, mode, variant });
    }
    if (selection.seats !== checkout.seats) {
      captureAnalyticsEvent("ai_plans_seats_adjusted", { plan, from: checkout.seats, to: selection.seats, interval: selection.interval, mode, variant });
    }
    setCheckout(selection);
  };

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
    setPhase((current) =>
      current.kind === "connecting" || current.kind === "confirm" ? { kind: "choose" } : current,
    );
  }, [variant]);

  useEffect(() => {
    if (phase.kind !== "connecting") return;
    const timer = window.setTimeout(
      () => setPhase({ kind: "choose" }),
      CONNECTING_TIMEOUT_MS,
    );
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

  const signIn = async (plan: EigenweltPlanId | null, confirmed = false) => {
    if (disabled) return;
    const flow = ++flowRef.current;
    const choice: AiPlansChoice = plan ?? "sign_in";
    setError(null);
    if (!confirmed) trackChoice(choice);
    else captureAnalyticsEvent("ai_plans_checkout_confirmed", { plan, interval: checkout.interval, seats: checkout.seats, trial_offered: offerTrial, mode, variant });
    // New customers land on sign-up; everyone who had an account on sign-in.
    const intent = variant === "new" && plan ? undefined : ("sign-in" as const);
    try {
      const { authorizeUrl, sessionId } = await props.onStartSignIn({
        ...(intent ? { intent } : {}),
        ...(plan ? { plan } : {}),
        ...(plan && confirmed ? { checkout } : {}),
      });
      if (flowRef.current !== flow) return;
      setPhase({ kind: "browser", plan, authorizeUrl });
      captureAnalyticsEvent("ai_plans_sign_in_started", {
        choice,
        mode,
        variant,
      });
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
      setPhase(confirmed && plan ? { kind: "confirm", plan } : { kind: "choose" });
      if (!result.cancelled && result.message) setError(result.message);
    } catch (signInError) {
      if (flowRef.current !== flow) return;
      if (signInError instanceof EigenweltSignInTimeoutError) {
        setError(null);
        setPhase({ kind: "expired" });
      } else {
        setPhase(confirmed && plan ? { kind: "confirm", plan } : { kind: "choose" });
        setError(signInError instanceof Error ? signInError.message : String(signInError));
      }
      captureAnalyticsEvent("ai_plans_sign_in_failed", {
        choice,
        mode,
        variant,
      });
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
    else { setError(null); trackChoice(plan); confirmPlan(plan); }
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
    setPhase(phase.kind === "browser" && phase.plan ? { kind: "confirm", plan: phase.plan } : { kind: "choose" });
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
      setError(
        switchError instanceof Error
          ? switchError.message
          : String(switchError),
      );
    } finally {
      setSwitchingAccount(false);
    }
  };

  const planLabel = (plan: EigenweltPlan) => {
    switch (variant) {
      case "ended":
        return t("ai_plans.restart", { plan: plan.name });
      case "no-models":
        return t("ai_plans.upgrade", { plan: plan.name });
      default:
        return t("ai_plans.try", { plan: plan.name });
    }
  };
  const firm = props.account?.firmName ?? t("ai_plans.your_firm");
  const title =
    props.assistantUpgrade ? t("assistant.upgrade_plans_title") : variant === "ended"
      ? t("ai_plans.title_ended")
      : variant === "no-models"
        ? t("ai_plans.title_no_models")
        : t("ai_plans.title");
  const subtitle =
    props.assistantUpgrade ? t("assistant.upgrade_plans_description") : variant === "ended"
      ? t("ai_plans.subtitle_ended", { firm })
      : variant === "no-models"
        ? t("ai_plans.subtitle_no_models", { firm })
        : t("ai_plans.subtitle");
  const account = accountLabel(props.account);

  const notice = error ? (
    <p role="alert" className="text-[12.5px] leading-relaxed text-red-11">
      {error}
    </p>
  ) : !props.serverReady ? (
    <p className="text-[12.5px] leading-relaxed text-dls-secondary">
      {t("ai_plans.server_starting")}
    </p>
  ) : null;

  const stepDots =
    mode === "onboarding" ? (
      <div className="flex justify-center [&>div]:mb-4">
        <StepDots step={(props.totalSteps ?? 7) - 2} total={props.totalSteps ?? 7} />
      </div>
    ) : null;

  const backRow = phase.kind === "confirm" ? <BackButton onClick={() => confirmPlan(null, "back")} /> :
    (mode === "onboarding" || props.assistantUpgrade) && props.onBack ? (
      <BackButton onClick={props.onBack} />
    ) : null;
  const onOpenUpdates = props.onOpenUpdates;
  const updatesLink = onOpenUpdates ? (
    <UpdatesLink
      onClick={() => {
        captureAnalyticsEvent("ai_plans_updates_opened", { mode, variant });
        onOpenUpdates();
      }}
    />
  ) : null;

  let body: ReactNode;
  // Pinned to the bottom of the window: Back on the left, the account line in
  // the middle, the update check on the right.
  let footerCenter: ReactNode = null;
  if (phase.kind === "expired") {
    body = (
      <div className="mx-auto w-full max-w-[480px]">
        {stepDots}
        <FocusCard>
          <div aria-hidden="true" className="mx-auto flex size-12 items-center justify-center rounded-full bg-dls-surface text-dls-secondary">
            <RefreshCcw className="size-5" />
          </div>
          <h1 id={titleId} className="mt-5 text-[26px] font-medium leading-[1.15] tracking-[-0.03em] text-dls-text">
            {t("ai_plans.sign_in_expired_title")}
          </h1>
          <div role="status">
            <p className="mt-3 text-[14px] leading-[1.6] text-dls-secondary">
              {t("ai_plans.sign_in_expired_body")}
            </p>
            <p className="mt-4 text-[13px] leading-[1.6] text-dls-secondary">
              {t("ai_plans.sign_in_expired_checkout")}
            </p>
          </div>
          <Button size="lg" className={`mt-7 ${planButtonClass}`} disabled={disabled} onClick={() => void signIn(null)}>
            {t("ai_plans.sign_in_again")}
          </Button>
        </FocusCard>
      </div>
    );
  } else if (
    phase.kind === "browser" ||
    phase.kind === "upgrade" ||
    phase.kind === "connecting"
  ) {
    const waitingBody =
      phase.kind === "browser"
        ? phase.plan
          ? t("ai_plans.waiting_body_plan", {
              plan:
                EIGENWELT_PLANS.find((plan) => plan.id === phase.plan)?.name ??
                phase.plan,
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
        <h1
          id={titleId}
          className="mt-5 text-[22px] font-medium tracking-[-0.02em] text-dls-text"
        >
          {phase.kind === "connecting"
            ? t("ai_plans.connecting")
            : t("ai_plans.waiting_title")}
        </h1>
        {waitingBody ? (
          <p className="mt-2 text-[13.5px] leading-[1.6] text-dls-secondary">
            {waitingBody}
          </p>
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
  } else if (phase.kind === "confirm") {
    body = <>
      <header className="mx-auto max-w-[760px] text-center roomy:max-w-[900px]">
        {stepDots}
        <h1 id={titleId} tabIndex={-1} className="text-[30px] font-medium leading-[1.08] tracking-[-0.035em] text-dls-text outline-none lg:text-[32px] roomy:text-[38px]">{t("ai_plans.confirm_title")}</h1>
        {notice ? <div className="mt-4">{notice}</div> : null}
      </header>
      <div className="mt-8 md:mt-10 roomy:mt-14 md:[@media(max-height:800px)]:mt-6"><PlanConfirmation planId={phase.plan} selection={checkout} disabled={disabled} offerTrial={offerTrial}
        onChange={changeCheckout} onBack={() => confirmPlan(null, "change_plan")} onConfirm={() => void signIn(phase.plan, true)} /></div>
    </>;
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
          <p className="mt-2.5 text-[14px] leading-[1.6] text-dls-secondary">
            {t("ai_plans.welcome_body")}
          </p>
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
              captureAnalyticsEvent("ai_plans_other_options_clicked", {
                mode,
                variant,
              });
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
            className="text-[28px] font-medium leading-[1.08] tracking-[-0.035em] text-dls-text lg:text-[30px] roomy:text-[34px]"
          >
            {title}
          </h1>
          <p className="ai-plans-subtitle mx-auto mt-1.5 max-w-[740px] text-[13px] leading-[1.5] text-dls-secondary roomy:max-w-[860px] roomy:text-[14px]">
            {subtitle}
          </p>
          {notice ? <div className="mt-4">{notice}</div> : null}
        </header>
        <div className="ai-plans-billing mt-3 flex justify-center">
          <div role="radiogroup" aria-label={t("ai_plans.confirm_interval")} className="inline-grid h-8 grid-cols-2 gap-1 rounded-full border border-dls-border/60 bg-muted/65 p-1">
            {(["year", "month"] satisfies EigenweltCheckoutSelection["interval"][]).map(interval => <button type="button" role="radio" key={interval} aria-checked={checkout.interval === interval} disabled={disabled} onClick={() => changeCheckout({ ...checkout, interval })}
              className={`rounded-full border px-5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${checkout.interval === interval ? "border-dls-border/70 bg-dls-surface text-dls-text" : "border-transparent text-dls-secondary hover:text-dls-text"}`}>
              {t(interval === "year" ? "ai_plans.confirm_yearly" : "ai_plans.confirm_monthly")}
            </button>)}
          </div>
        </div>
        {!props.assistantUpgrade && <OwnModelBanner disabled={disabled} onChoose={bringOwnModel} />}
        <div className="mt-4 grid gap-4 md:grid-cols-3 md:gap-x-4 md:gap-y-0 xl:gap-x-5 roomy:mt-5 roomy:gap-x-7">
          {EIGENWELT_PLANS.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              locale={locale}
              label={planLabel(plan)}
              disabled={disabled}
              onChoose={() => choosePlan(plan.id)}
              interval={checkout.interval}
            />
          ))}
        </div>
        <p className="mt-3 text-center text-[11px] leading-4 text-dls-secondary roomy:text-xs">
          {t("ai_plans.confirm_footnote")}{offerTrial ? ` ${t("ai_plans.confirm_trial_footnote")}` : ""}
        </p>
      </>
    );
    footerCenter = (
      <p className="text-center text-xs text-dls-secondary roomy:text-[13px]">
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
          <button
            type="button"
            className={textLinkClass}
            onClick={() => setShowPlans(false)}
          >
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
        "fixed inset-0 z-40 flex flex-col outline-none",
        props.mode === "onboarding"
          ? "bg-background"
          : "bg-background/35 backdrop-blur-[14px] dark:bg-background/70",
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
          {props.projectApproval}
          <div className={cn("flex flex-1 flex-col justify-center", phase.kind === "choose" && !signInFirst ? "py-3 roomy:py-6" : "py-8 roomy:py-10", phase.kind === "confirm" && "[@media(max-height:780px)]:py-4")}>
            {body}
          </div>
          {backRow || footerCenter || updatesLink ? (
            <footer className={cn("flex flex-col items-center gap-3 pt-2 md:grid md:grid-cols-[1fr_auto_1fr]", phase.kind === "choose" && !signInFirst ? "pb-3 roomy:pb-4" : "pb-6 roomy:pb-8")}>
              <div className="justify-self-start">{backRow}</div>
              {footerCenter ?? <div />}
              <div className="justify-self-end">{updatesLink}</div>
            </footer>
          ) : null}
        </div>
      </div>
    </div>
  );
}
