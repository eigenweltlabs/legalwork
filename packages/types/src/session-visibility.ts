export const LEGALMEMORY_INTERNAL_SESSION = "legalmemory";

/** Presentation only. Actual operation authority is checked separately. */
export function isInternalSession(session: unknown): boolean {
  if (!session || typeof session !== "object" || !("metadata" in session)) return false;
  const metadata = session.metadata;
  if (!metadata || typeof metadata !== "object") return false;
  return "legalworkReviewWorker" in metadata && metadata.legalworkReviewWorker === true
    || "legalworkInternal" in metadata && metadata.legalworkInternal === LEGALMEMORY_INTERNAL_SESSION;
}
