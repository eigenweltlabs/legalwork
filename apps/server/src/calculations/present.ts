import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CalculationPresentationInputSchema, type CalculationRun } from "./schema.js";
import type { CalendarStore } from "../calendar/store.js";
import type { WorkspaceInfo } from "../types.js";
import { prepareReviewEvidence, sourceHash, type ReviewEvidence } from "../reviews/evidence.js";
import type { DocumentPreparation } from "../document-preparation/service.js";
import { quoteRange } from "../document-preparation/highlights.js";
import { reviewSourcePage } from "../reviews/source-page.js";
import { composedSkill } from "../skill-composition.js";
import { listSkills } from "../skills.js";
import { ApiError } from "../errors.js";

export async function presentCalculation(store: CalendarStore, workspace: WorkspaceInfo, raw: unknown, signal: AbortSignal, preparation?: DocumentPreparation) {
  const input = CalculationPresentationInputSchema.parse(raw);
  const runs: CalculationRun[] = [];
  if (input.runId) runs.push(store.run(workspace.id, input.runId));
  for (const id of [...new Set(input.calculationIds)]) {
    const receipt = store.calculation(workspace.id, id);
    // Trace text comes from execution, never a replacement explanation invented for the card.
    runs.push({ id: receipt.id, skill: receipt.skill, version: receipt.version, codeHash: receipt.codeHash, createdAt: receipt.createdAt,
      origin: "skill", status: "calculated", inputs: receipt.input,
      steps: receipt.trace.map((trace, index) => ({ title: `${index + 1}`, reason: trace, inputs: {}, output: null })),
      results: [{ title: receipt.rule, date: receipt.deadlineDay, cutoff: receipt.cutoff, timeZone: receipt.timeZone, calculationId: receipt.id }],
      missingFacts: [], sources: receipt.sources,
    });
  }
  if (input.assessment) {
    const skill = await composedSkill(workspace.path, input.assessment.skill);
    runs.push({ id: randomUUID(), skill: skill.name, version: skill.chain.map(item => `${item.name}@${item.hash.slice(0, 12)}`).join(", "),
      codeHash: "", createdAt: new Date().toISOString(), origin: "assessment", status: input.assessment.status, inputs: input.assessment.inputs,
      steps: [], results: [], missingFacts: input.assessment.missingFacts, sources: [],
    });
  }
  // Keep the exact tested source alongside the receipt if it is still available, never substitute a newer script.
  const installed = await listSkills(workspace.path, true);
  for (const run of runs) {
    if (run.origin !== "skill" || run.code) continue;
    const skill = installed.find(skill => skill.name === run.skill);
    if (!skill) continue;
    const { createHash } = await import("node:crypto");
    try {
      const code = await readFile(join(skill.path, "..", "calculate.mjs"), "utf8");
      if (createHash("sha256").update(code).digest("hex") === run.codeHash) run.code = code;
    } catch { /* Old receipt still has its immutable trace and hash. */ }
  }
  const sources = [];
  const evidence = new Map<string, ReviewEvidence>();
  for (const reference of input.sources) {
    const { hash, source, bytes } = await sourceHash(workspace.path, reference.path);
    let bound = { ...reference, path: source.path, hash };
    if (/\.(txt|md)$/i.test(source.path)) {
      if (!quoteRange(new TextDecoder("utf-8", { fatal: true }).decode(bytes), reference.quote)) throw new ApiError(422, "calculation_source_ambiguous", "Supply an exact, unique passage from the source file.");
      bound = { ...bound, page: null, source: "native", preparationPath: undefined };
      sources.push(bound);
      continue;
    }
    if (!reference.page) throw new ApiError(422, "calculation_source_page", "Supply the page number for a PDF or image source.");
    const verify = () => reviewSourcePage(workspace.path, source.path, { sourceHash: hash, preparationPath: bound.preparationPath,
      citations: [{ page: bound.page, quote: bound.quote, source: bound.source }] }, 0, signal);
    let verified;
    try { verified = await verify(); }
    catch (error) {
      if (!preparation || reference.preparationPath || !(error instanceof ApiError) || error.code !== "review_citation") throw error;
    }
    if (!verified?.regions.length && preparation && !reference.preparationPath) {
      let prepared = evidence.get(source.path);
      if (!prepared) {
        prepared = await prepareReviewEvidence({ workspace: workspace.path, path: source.path, preparation, signal, force: false, onProgress: async () => {} });
        evidence.set(source.path, prepared);
      }
      if (prepared.hash !== hash) throw new ApiError(409, "calculation_source_changed", "The source changed during preparation. Present a fresh calculation.");
      const page = prepared.pages.find(page => page.page === reference.page && quoteRange(page.text, reference.quote));
      if (!page) throw new ApiError(422, "calculation_source_ambiguous", "The passage could not be located uniquely. Supply a longer exact quote.");
      bound = { ...bound, source: page.source ?? "native", preparationPath: prepared.preparationPath };
      verified = await verify();
    }
    if (!verified) throw new ApiError(422, "calculation_source_ambiguous", "The passage could not be verified. Supply an exact quote or prepare the document.");
    if (!verified.regions.length) throw new ApiError(422, "calculation_source_ambiguous", "The passage could not be located uniquely. Supply a longer exact quote or prepared OCR evidence.");
    sources.push(bound);
  }
  return store.recordPresentation({ id: randomUUID(), workspaceId: workspace.id, sessionId: input.sessionId, title: input.title, selection: input.selection,
    mode: input.mode, state: input.mode === "confirm" ? "pending" : "shown", runs, sources, itemIds: [], createdAt: new Date().toISOString() }, input.supersedes);
}

export async function validatePresentationSources(workspace: WorkspaceInfo, sources: Array<{ path: string; hash: string }>) {
  for (const reference of sources) {
    if ((await sourceHash(workspace.path, reference.path)).hash !== reference.hash) throw new ApiError(409, "calculation_source_changed", "A source changed. Present a fresh calculation before saving.");
  }
}
