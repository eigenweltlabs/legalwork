import { ApiError } from "../errors.js";
import type { Actor } from "../types.js";

/** Captured only at authenticated execution admission, never from model input. */
export function reviewExecutionActor(actor: Actor | undefined): Actor & { scope: "owner" | "collaborator" } {
  if (actor?.scope !== "owner" && actor?.scope !== "collaborator")
    throw new ApiError(403, "review_actor_required", "Review execution requires the initiating member's write access.");
  return { ...actor, scope: actor.scope };
}
