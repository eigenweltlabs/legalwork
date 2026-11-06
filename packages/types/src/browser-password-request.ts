import { z } from "zod";

export const websiteConnectionUrl = z.string().trim().max(2000).url().refine(value => {
  const url = new URL(value);
  return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
}, "Enter an HTTPS website address (HTTP is supported only on localhost).");
export const connectedWebsiteSchema = z.object({
  url: websiteConnectionUrl, name: z.string().trim().min(1).max(200),
  providerId: z.string().optional(), country: z.string().optional(),
});
export type ConnectedWebsite = z.infer<typeof connectedWebsiteSchema>;

/** Native form metadata and answers contain references only, never a password. */
export const browserPasswordRequestSchema = z.object({
  website: z.string().url().refine(value => {
    try {
      const url = new URL(value);
      return url.origin === value && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    } catch { return false; }
  }),
  label: z.string().min(1).max(200),
  username: z.string().max(500),
  startUrl: websiteConnectionUrl.optional(),
}).strict();

export type BrowserPasswordRequest = z.infer<typeof browserPasswordRequestSchema>;

export function browserPasswordRequest(metadata: unknown) {
  if (!metadata || typeof metadata !== "object") return null;
  const parsed = browserPasswordRequestSchema.safeParse(Reflect.get(metadata, "legalworkBrowserPassword"));
  return parsed.success ? parsed.data : null;
}
