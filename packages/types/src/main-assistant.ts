import { z } from "zod";

export const AssistantIconSchema = z.enum(["cat", "fox", "owl", "panda", "rabbit", "bear", "dog", "penguin", "otter", "frog", "robot", "sprout"]);
export const AssistantProfileSchema = z.object({ name: z.string().trim().min(1).max(60).nullable(), icon: AssistantIconSchema });
export type AssistantIcon = z.infer<typeof AssistantIconSchema>;
export type AssistantProfile = z.infer<typeof AssistantProfileSchema>;
export const DEFAULT_ASSISTANT_PROFILE: AssistantProfile = { name: null, icon: "cat" };
