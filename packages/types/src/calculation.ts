import { z } from "zod";
import { CalendarAttachmentPathSchema } from "./calendar.js";

export const CalculationSourceInputSchema = z.object({
  path: CalendarAttachmentPathSchema, page: z.number().int().positive().nullable().default(null), quote: z.string().min(1).max(6000),
  source: z.enum(["native", "ocr"]).default("native"), preparationPath: z.string().optional(),
});
export const CalculationSourceSchema = CalculationSourceInputSchema.extend({ hash: z.string() });
export const CalculationStepSchema = z.object({
  title: z.string(), reason: z.string(), inputs: z.record(z.string(), z.unknown()).default({}),
  output: z.unknown(), code: z.string().optional(), line: z.number().int().optional(),
});
export const CalculationResultSchema = z.object({
  title: z.string(), date: z.iso.date(), cutoff: z.string(), timeZone: z.string(), calculationId: z.uuid(),
});
export const CalculationRunSchema = z.object({
  id: z.uuid(), skill: z.string(), version: z.string(), codeHash: z.string(), createdAt: z.string(),
  origin: z.enum(["skill", "assessment"]), status: z.enum(["calculated", "needs_information", "requires_specialist_review"]),
  inputs: z.record(z.string(), z.unknown()), steps: z.array(CalculationStepSchema), results: z.array(CalculationResultSchema),
  missingFacts: z.array(z.string()), sources: z.array(z.string()), code: z.string().optional(),
});
export const CalculationPresentationInputSchema = z.object({
  supersedes: z.uuid().optional().describe("Previous card ID to close when correcting its inputs or legal selection. Unrelated deadlines remain independent."),
  title: z.string().min(1).max(255), selection: z.string().min(1).max(4000).describe("Explain which legal deadline was requested and why the chosen rule applies. This is an agent assessment, separate from the code execution."),
  mode: z.enum(["show", "confirm"]).default("show").describe("Show evidence by default. Confirm only when review before saving was requested or required; missing facts need a focused question, not approval."), sessionId: z.string().optional(),
  calculationIds: z.array(z.uuid()).max(30).default([]), runId: z.uuid().optional(),
  assessment: z.object({ status: z.enum(["needs_information", "requires_specialist_review"]),
    missingFacts: z.array(z.string().min(1).max(2000)).min(1).max(30), skill: z.string().min(1), inputs: z.record(z.string(), z.unknown()).default({}),
  }).optional(),
  sources: z.array(CalculationSourceInputSchema).max(40).default([]),
}).refine(value => [!!value.calculationIds.length, !!value.runId, !!value.assessment].filter(Boolean).length === 1, "Supply receipts, an executed run, or an assessment, exclusively.");
export const CalculationPresentationSchema = z.object({
  id: z.uuid(), workspaceId: z.string(), sessionId: z.string().optional(), title: z.string(), selection: z.string(),
  mode: z.enum(["show", "confirm"]), state: z.enum(["shown", "pending", "saved", "rejected", "acknowledged"]),
  runs: z.array(CalculationRunSchema), sources: z.array(CalculationSourceSchema), itemIds: z.array(z.string()), createdAt: z.string(),
});
export const CalculationCardSchema = z.object({ presentation: CalculationPresentationSchema.pick({ id: true, workspaceId: true, title: true }) });
export type CalculationRun = z.infer<typeof CalculationRunSchema>;
export type CalculationPresentation = z.infer<typeof CalculationPresentationSchema>;
export type CalculationPresentationInput = z.infer<typeof CalculationPresentationInputSchema>;
