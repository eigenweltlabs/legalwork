import { z } from "zod";

export const EngineProjectStatusSchema = z.object({
  state: z.enum(["approval_required", "ready", "configuration_conflict"]),
  required: z.boolean(),
  directory: z.string(),
  approvedAt: z.number().optional(),
  approvalScope: z.array(z.object({ directory: z.string(), configPaths: z.array(z.string()) })),
  projection: z.object({ path: z.string().optional(), diagnostic: z.string().optional() }),
  plugins: z.array(z.object({ target: z.string(), sources: z.array(z.string()), approved: z.boolean() })),
  recovery: z.object({
    mode: z.enum(["service", "recovery", "promoting"]),
    heldSessionIds: z.array(z.string()),
    waitingForOtherProjects: z.boolean(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }).optional(),
});
export type EngineProjectStatus = z.infer<typeof EngineProjectStatusSchema>;
