import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { parseReviewCells, reviewOutputSchema, ReviewFormatError } from "./citations.js";
import type { EvidencePage } from "./chunks.js";
import type { ReviewColumn, ReviewModel } from "./schema.js";
import { builtinJevFallback } from "./builtin-fallback.js";
import { validateColumnValue } from "./value-types.js";

export { REVIEW_SUBMIT_TOOL } from "./worker-identity.js";
type Cell = ReturnType<typeof parseReviewCells>[string];
type Submission = { ok: true; cell: Cell; raw: unknown; messageID: string } | { ok: false; error: unknown };
type ClaimInput = { sessionID: string; workspace: WorkspaceInfo; selected: ReviewModel; column: ReviewColumn; pages: EvidencePage[]; instructions: string };
type Claim = ClaimInput & { id: string; schema: ReturnType<typeof reviewOutputSchema>; completion: Promise<Submission>;
  settle: (value: Submission) => void; submitted: boolean; messageID: string; toolID: string; raw: string };

/** Ephemeral authority for one inference attempt; never reconstructed from document/model input. */
export class ReviewWorkerClaims {
  private claims = new Map<string, Claim>();
  create(input: ClaimInput): Claim {
    const done = Promise.withResolvers<Submission>();
    const claim = { ...structuredClone(input), id: randomUUID(), schema: reviewOutputSchema(input.column.key),
      completion: done.promise, settle: done.resolve, submitted: false, messageID: "", toolID: "", raw: "" };
    this.claims.set(input.sessionID, claim);
    return claim;
  }
  get(workspace: WorkspaceInfo, sessionID: string, id: string) {
    const claim = this.claims.get(sessionID);
    if (!claim || claim.id !== id || claim.workspace.id !== workspace.id || claim.workspace.path !== workspace.path)
      throw new ApiError(404, "review_worker_not_found", "This review inference attempt is no longer active.");
    return claim;
  }
  submit(workspace: WorkspaceInfo, sessionID: string, id: string, input: { value: unknown; messageID: string; toolID: string }) {
    const claim = this.get(workspace, sessionID, id), raw = JSON.stringify(input.value);
    if (claim.submitted) {
      if (claim.messageID !== input.messageID || claim.toolID !== input.toolID || claim.raw !== raw)
        throw new ApiError(409, "review_worker_submitted", "This inference attempt already submitted an answer.");
      return { accepted: true };
    }
    claim.submitted = true; claim.messageID = input.messageID; claim.toolID = input.toolID; claim.raw = raw;
    try {
      if (!z.fromJSONSchema(claim.schema).safeParse(input.value).success)
        throw new ReviewFormatError("The model returned an invalid cell structure. Use the requested fields and their exact types.");
      const cell = parseReviewCells({ pages: claim.pages, columns: [{ key: claim.column.key, fallback: builtinJevFallback(claim.column) }] }, input.value)[claim.column.key];
      if (cell.value !== "Not found" && cell.value !== "Needs review") {
        if (claim.column.kind === "yes_no" && !["Yes", "No"].includes(cell.value)) throw new Error("The model did not return a yes/no answer.");
        if (claim.column.kind === "classification" && !claim.column.options.includes(cell.value)) throw new Error("The model returned an undefined classification.");
        validateColumnValue(claim.column, cell.value);
      }
      claim.settle({ ok: true, cell, raw: input.value, messageID: input.messageID });
    } catch (error) { claim.settle({ ok: false, error }); }
    // The executor owns correction/retry and cancellation. Do not ask the model to retry in this session.
    return { accepted: true };
  }
  remove(sessionID: string) { this.claims.delete(sessionID); }
}
const stores = new WeakMap<ServerConfig, ReviewWorkerClaims>();
export function reviewWorkerClaims(config: ServerConfig): ReviewWorkerClaims {
  let value = stores.get(config);
  if (!value) { value = new ReviewWorkerClaims(); stores.set(config, value); }
  return value;
}
