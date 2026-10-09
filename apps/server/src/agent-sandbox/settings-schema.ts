import { z } from "zod";
import { networkModeSchema } from "./network.js";

export const sandboxSettingsSchema = z.object({ enabled: z.boolean(), networkMode: networkModeSchema }).strict();
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;
export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = { enabled: false, networkMode: "approve" };
export const sandboxSyncSchema = z.object({
  account: z.string(), revision: z.number().int().nonnegative(), dirty: z.boolean(),
}).strict();
