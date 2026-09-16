/**
 * Can LegalWork reach a model right now, and if not, which plan screen fits?
 *
 * LegalWork has no free model tier: it works with an Eigenwelt subscription
 * (Plus or Pro) or with a model provider the user connects. While neither is
 * usable, the session route lays the plan screen over the app, in one of
 * these variants:
 *
 *  - "new":        nobody signed in to Eigenwelt on this computer yet. The
 *                  three cards: own model, Plus and Pro with the 7-day trial.
 *  - "signed-out": an account was signed in before and is not any more (a
 *                  sign-out, or the platform revoked the sign-in). Sign-in
 *                  first, the cards one click away.
 *  - "ended":      signed in, but the firm's subscription no longer grants
 *                  anything (canceled, a trial that did not convert, a
 *                  payment that failed for good). The cards, to restart a plan.
 *  - "no-models":  signed in and subscribed, but the plan carries no Eigenwelt
 *                  models (no current plan is like that). The cards, as an
 *                  upgrade.
 *
 * "ready" means a model is usable. "unknown" means the inputs are still
 * loading: nothing is shown then, so the screen never flashes over a working
 * app while the engine starts.
 *
 * Pure and dependency-free apart from the entitlement status list, so the
 * route and the tests share it.
 */
import { isEigenweltEntitledStatus } from "./eigenwelt-trial";

export type AiAccessState = "unknown" | "ready" | "new" | "signed-out" | "ended" | "no-models";

/** The states that show the plan screen. */
export type AiPlansVariant = Exclude<AiAccessState, "unknown" | "ready">;

export function isAiPlansVariant(state: AiAccessState): state is AiPlansVariant {
  return state !== "unknown" && state !== "ready";
}

const EIGENWELT_PROVIDER_ID = "eigenwelt";

/**
 * Providers that never count as "your own model": the retired free tiers
 * (mirror of RETIRED_FREE_PROVIDER_IDS in react-app/infra/provider-list-query,
 * which this layer may not import).
 */
const NOT_OWN_PROVIDER_IDS = new Set([EIGENWELT_PROVIDER_ID, "eigenwelt-free", "opencode"]);

type ConnectedProvider = {
  id: string;
  models?: Record<string, unknown> | null;
};

type EigenweltConnectionView = {
  connected: boolean;
  entitlements: {
    subscriptionStatus: string | null;
    features?: string[] | null;
  } | null;
};

export type AiAccessInput = {
  /**
   * The engine's connected providers with the user-disabled ones removed;
   * null while the provider list loads.
   */
  connectedProviders: readonly ConnectedProvider[] | null;
  /**
   * The Eigenwelt connection view: undefined while it loads, null when the
   * read failed.
   */
  eigenwelt: EigenweltConnectionView | null | undefined;
  /** An Eigenwelt account was signed in on this computer before. */
  signedInBefore: boolean;
};

const servesModels = (provider: ConnectedProvider) =>
  Object.keys(provider.models ?? {}).length > 0;

export function aiAccessState(input: AiAccessInput): AiAccessState {
  const providers = input.connectedProviders;
  if (!providers) return "unknown";

  // A provider of the user's own that serves at least one model: the app
  // works, whatever the Eigenwelt account says.
  if (providers.some((provider) => !NOT_OWN_PROVIDER_IDS.has(provider.id) && servesModels(provider))) {
    return "ready";
  }

  const engineServesEigenwelt = providers.some(
    (provider) => provider.id === EIGENWELT_PROVIDER_ID && servesModels(provider),
  );
  const view = input.eigenwelt;

  if (view?.connected) {
    const entitlements = view.entitlements;
    // Signed in without a plan on record: a sign-in from before entitlements
    // existed. Its models decide; without them, signing in again refreshes
    // everything.
    if (!entitlements) return engineServesEigenwelt ? "ready" : "signed-out";
    // The account is the source of truth while signed in: the engine keeps
    // listing the Eigenwelt models until its next reload after a
    // subscription ends.
    if (!isEigenweltEntitledStatus(entitlements.subscriptionStatus)) return "ended";
    return (entitlements.features ?? []).includes("premium_models") ? "ready" : "no-models";
  }

  // Not signed in, or the account is not known yet. Models the engine still
  // serves count: a key from an older sign-in, or a provider list that has
  // not caught up with a sign-in yet.
  if (engineServesEigenwelt) return "ready";
  if (view === undefined) return "unknown";
  return input.signedInBefore ? "signed-out" : "new";
}

/* ------------------------------------------------------------------ */
/*  The account signed in before on this computer                      */
/* ------------------------------------------------------------------ */

const LAST_ACCOUNT_KEY = "legalwork.eigenwelt.lastAccount";

/**
 * What the plan screen remembers about the last Eigenwelt account, to greet
 * a returning user with a sign-in instead of the plans. The connection
 * itself lives in the server and is gone after a sign-out; this stays.
 */
export type RememberedEigenweltAccount = {
  email: string | null;
  firmName: string | null;
};

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export function readRememberedEigenweltAccount(
  storage: KeyValueStorage | null = defaultStorage(),
): RememberedEigenweltAccount | null {
  try {
    const raw = storage?.getItem(LAST_ACCOUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return { email: textOrNull(record.email), firmName: textOrNull(record.firmName) };
  } catch {
    return null;
  }
}

export function rememberEigenweltAccount(
  account: RememberedEigenweltAccount,
  storage: KeyValueStorage | null = defaultStorage(),
): void {
  try {
    storage?.setItem(
      LAST_ACCOUNT_KEY,
      JSON.stringify({ email: textOrNull(account.email), firmName: textOrNull(account.firmName) }),
    );
  } catch {
    // Storage unavailable: a returning user sees the plans instead.
  }
}

/** "Use another account": the next plan screen starts from the plans. */
export function forgetEigenweltAccount(storage: KeyValueStorage | null = defaultStorage()): void {
  try {
    storage?.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    // Storage unavailable: nothing to forget.
  }
}
