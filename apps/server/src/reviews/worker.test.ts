import { expect, test } from "bun:test";
import type { EvidencePage } from "./chunks.js";
import { ReviewWorkerClaims } from "./worker.js";
import { ReviewColumnSchema } from "./schema.js";
import { ReviewCitationError, ReviewFormatError } from "./citations.js";
import type { WorkspaceInfo } from "../types.js";
const workspace: WorkspaceInfo = { id: "matter", name: "Matter", path: "/matter", preset: "starter", workspaceType: "local" };
const column = ReviewColumnSchema.parse({ key: "assignment", label: "Assignment", question: "Allowed?", kind: "yes_no" });
const answer = () => ({ cells: { assignment: { value: "Yes", reason: "Permitted", quote: "Assignment is permitted.", page: 1, location: "Assignment", confidence: "high", citations: [{ page: 1, quote: "Assignment is permitted.", source: "native" }] } } });
function create(store = new ReviewWorkerClaims()) { return { store, claim: store.create({ sessionID: "ses_worker", workspace, selected: { providerId: "firm", model: "reviewer" }, column, pages: [{ page: 1, source: "native", text: "Assignment is permitted." }], instructions: "Review only." }) }; }
test("review claims bind session and project, preserve the original result, and reject replayed writes", async () => {
  const { store, claim } = create(), value = answer();
  for (const [project, session, id] of [[{ ...workspace, id: "other" }, "ses_worker", claim.id], [workspace, "ses_other", claim.id], [workspace, "ses_worker", "invented"]] satisfies Array<[WorkspaceInfo, string, string]>)
    expect(() => store.get(project, session, id)).toThrow("no longer active");
  const input = { value, messageID: "msg_native", toolID: "call_native" };
  expect(store.submit(workspace, "ses_worker", claim.id, input)).toEqual({ accepted: true });
  expect(await claim.completion).toMatchObject({ ok: true, raw: value, messageID: "msg_native", cell: { value: "Yes" } });
  expect(store.submit(workspace, "ses_worker", claim.id, input)).toEqual({ accepted: true });
  expect(() => store.submit(workspace, "ses_worker", claim.id, { ...input, toolID: "call_repeat" })).toThrow("already submitted");
  store.remove("ses_worker"); expect(() => store.get(workspace, "ses_worker", claim.id)).toThrow("no longer active");
});
test("exact schema and source verification never accept model-supplied replacement evidence", async () => {
  for (const failure of ["schema", "citation"]) {
    const { store, claim } = create(), value = answer();
    if (failure === "citation") value.cells.assignment.quote = "An invented permission.";
    const submitted = failure === "schema" ? { cells: { wrong: value.cells.assignment }, schema: {}, pages: [{ text: "An invented permission." }] } : value;
    store.submit(workspace, "ses_worker", claim.id, { value: submitted, messageID: "msg", toolID: "call" });
    const result = await claim.completion;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("An unsupported answer was accepted.");
    expect(result.error).toBeInstanceOf(failure === "schema" ? ReviewFormatError : ReviewCitationError);
  }
});
test("evidence and schema are immutable for the attempt even when the caller changes its originals", async () => {
  const store = new ReviewWorkerClaims(), pages: EvidencePage[] = [{ page: 1, source: "native", text: "Assignment is permitted." }];
  const question = structuredClone(column);
  const claim = store.create({ sessionID: "ses_worker", workspace, selected: { providerId: "firm", model: "reviewer" }, column: question, pages, instructions: "Review only." });
  question.key = "different"; pages[0].text = "Something else.";
  store.submit(workspace, "ses_worker", claim.id, { value: answer(), messageID: "msg", toolID: "call" });
  expect(await claim.completion).toMatchObject({ ok: true, cell: { value: "Yes" } });
});
