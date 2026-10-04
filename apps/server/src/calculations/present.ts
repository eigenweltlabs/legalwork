import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CalculationPresentationInputSchema, type CalculationRun } from "./schema.js";
import type { CalendarStore } from "../calendar/store.js";
import type { WorkspaceInfo } from "../types.js";
import { sourceHash } from "../reviews/evidence.js";
import { reviewSourcePage } from "../reviews/source-page.js";
import { composedSkill } from "../skill-composition.js";
import { listSkills } from "../skills.js";
import { ApiError } from "../errors.js";

export async function presentCalculation(store: CalendarStore, workspace: WorkspaceInfo, raw: unknown, signal: AbortSignal) {
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
  for (const reference of input.sources) {
    const { hash } = await sourceHash(workspace.path, reference.path);
    const verified = await reviewSourcePage(workspace.path, reference.path, { sourceHash: hash, preparationPath: reference.preparationPath,
      citations: [{ page: reference.page, quote: reference.quote, source: reference.source }] }, 0, signal);
    if (!verified.regions.length) throw new ApiError(422, "calculation_source_ambiguous", "The passage could not be located uniquely. Supply a longer exact quote or prepared OCR evidence.");
    sources.push({ ...reference, hash });
  }
  return store.recordPresentation({ id: randomUUID(), workspaceId: workspace.id, sessionId: input.sessionId, title: input.title, selection: input.selection,
    mode: input.mode, state: input.mode === "confirm" ? "pending" : "shown", runs, sources, itemIds: [], createdAt: new Date().toISOString() }, input.supersedes);
}

export async function validatePresentationSources(workspace: WorkspaceInfo, sources: Array<{ path: string; hash: string }>) {
  for (const reference of sources) {
    if ((await sourceHash(workspace.path, reference.path)).hash !== reference.hash) throw new ApiError(409, "calculation_source_changed", "A source changed. Present a fresh calculation before saving.");
  }
}
