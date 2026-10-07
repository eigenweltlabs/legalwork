import { z } from "zod";

// OpenCode ConfigProviderV1 model options/variants. Preserve provider-specific
// controls verbatim; LegalWork does not enumerate efforts or translate them.
export const OpenCodeModelConfigSchema = z.object({
  options: z.record(z.string(), z.unknown()).optional(),
  variants: z.record(z.string(), z.object({ disabled: z.boolean().optional() }).catchall(z.unknown())).optional(),
  interleaved: z.union([z.boolean(), z.string(), z.object({ field: z.string() })]).optional(),
});
export type OpenCodeModelConfig = z.infer<typeof OpenCodeModelConfigSchema>;
