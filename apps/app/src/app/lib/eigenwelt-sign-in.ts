/** A routine sign-in expiry with a dedicated reconnect action in onboarding. */
export class EigenweltSignInTimeoutError extends Error {
  override name = "EigenweltSignInTimeoutError";
}
