import { loadStripe } from "@stripe/stripe-js/pure";
import type { TopUpResult } from "@legalwork/types/usage-control";

/** Called only by the explicit Pay action, after displaying this exact total. */
export async function confirmSavedCardTopUp(payment: Extract<TopUpResult, { status: "requires_client_confirmation" }>) {
  const stripe = await loadStripe(payment.publishableKey);
  if (!stripe) throw new Error("payment_confirmation_unavailable");
  const checkout = stripe.initCheckoutElementsSdk({ clientSecret: payment.clientSecret });
  const loaded = await checkout.loadActions();
  if (loaded.type === "error") throw new Error(loaded.error.message);
  const session = loaded.actions.getSession();
  if (session.currency !== "eur" || session.total.total.minorUnitsAmount !== payment.totalCents ||
      payment.totalCents !== payment.amountCents + payment.taxCents)
    throw new Error("top_up_amount_changed");
  const confirmed = await loaded.actions.confirm({ paymentMethod: payment.paymentMethodId, redirect: "if_required" });
  if (confirmed.type === "error") throw new Error(confirmed.error.message);
  // The caller reads the server's Stripe state next. Browser success never grants credits.
}
