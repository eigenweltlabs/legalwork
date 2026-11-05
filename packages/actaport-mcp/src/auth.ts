import { z } from "zod";
import { toolsetsSchema } from "./toolsets.js";
export { coreToolCount, toolsetsSchema, toolsetSummaries } from "./toolsets.js";

export const ACTAPORT_ORIGIN = "https://app.actaport.de";
export const credentialsSchema = z.object({
  realm: z.string().min(1).max(200).regex(/^[^/\\\u0000-\u001f\u007f]+$/).refine((value) => value.trim().length > 0 && value !== "." && value !== ".."),
  clientId: z.string().min(1).max(1000),
  clientSecret: z.string().min(1).max(4000),
  username: z.string().min(1).max(1000),
  password: z.string().min(1).max(4000),
}).strict();
export type Credentials = z.infer<typeof credentialsSchema>;
export const connectionSchema = z.object({
  credentials: credentialsSchema,
  allowWrites: z.boolean().default(false),
  toolsets: toolsetsSchema.default([]),
});
export type AccessToken = { accessToken: string; expiresAt: number };
export type TokenProvider = (force?: boolean) => Promise<AccessToken>;
const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

export class ActaportError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number,
    public readonly retryAfter?: number) { super(message); }
}

/** Password grant, not refresh-token OAuth. Raw credentials and responses never enter errors. */
export function createTokenProvider(credentials: Credentials, options: {
  fetch?: typeof fetch; origin?: string; now?: () => number;
} = {}): TokenProvider {
  const send = options.fetch ?? fetch;
  const origin = options.origin ?? ACTAPORT_ORIGIN;
  const now = options.now ?? Date.now;
  let cached: AccessToken | undefined;
  let pending: Promise<AccessToken> | undefined;
  return async (force = false) => {
    if (force) cached = undefined;
    if (cached && cached.expiresAt > now() + 30_000) return cached;
    if (pending) return pending;
    pending = (async () => {
      let response: Response;
      try {
        response = await send(`${origin}/auth/realms/${encodeURIComponent(credentials.realm)}/protocol/openid-connect/token`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret,
            grant_type: "password", username: credentials.username, password: credentials.password }),
        });
      } catch { throw new ActaportError("auth_unreachable", "Could not reach Actaport authentication."); }
      if (!response.ok) throw new ActaportError("auth_failed", "Actaport authentication failed. Check API access and credentials.", response.status);
      const result = tokenSchema.safeParse(await response.json().catch(() => null));
      if (!result.success) throw new ActaportError("auth_invalid", "Actaport returned an invalid token response.");
      cached = { accessToken: result.data.access_token, expiresAt: now() + result.data.expires_in * 1000 };
      return cached;
    })();
    try { return await pending; } finally { pending = undefined; }
  };
}
