import { z } from "zod";

export const projectFilePath = z.string().min(1).max(4096).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !/[\u0000-\u001f]/.test(value) &&
  !/^[A-Za-z]:/.test(value) && value.split("/").every(part => part && part !== "." && part !== ".."),
);
export const projectFileSourceSchema = z.object({
  projectId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
  path: projectFilePath,
  name: z.string().min(1).max(512),
  connectionId: z.string().min(1).max(256).optional(),
});
export type ProjectFileSource = z.infer<typeof projectFileSourceSchema>;
export const projectFileLinkSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(512).refine(value => !/[\/\\\u0000-\u001f]/.test(value)),
  folder: z.union([z.literal(""), projectFilePath]),
  source: projectFileSourceSchema,
  createdAt: z.number(),
});
export type ProjectFileLink = z.infer<typeof projectFileLinkSchema>;
