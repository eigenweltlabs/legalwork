import { z } from "zod";
export const SkillExtensionSchema = z.object({
  base: z.string().min(1), baseHash: z.string(),
  correction: z.string().min(1).max(16000), appliesWhen: z.string().min(1).max(4000),
  examples: z.array(z.object({ input: z.string().min(1).max(4000), expected: z.string().min(1).max(4000) })).min(1).max(20),
  createdAt: z.string(),
});
export const SkillLessonInputSchema = SkillExtensionSchema.omit({ baseHash: true, createdAt: true });
