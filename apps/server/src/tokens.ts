import { randomBytes, randomUUID } from "node:crypto";
import type { LauncherInvocation } from "@legalwork/types/launcher";
import type { ServerConfig, TokenScope } from "./types.js";
import { tokensMatch, hashToken } from "./utils.js";

/** The configured app credential and one revocable, route-scoped Raycast credential. */
export class TokenService {
  private raycastToken: string | null = null;
  private readonly handoffs = new Map<string, { invocation: LauncherInvocation; expires: number }>();
  rotateRaycast(enabled: boolean) {
    this.handoffs.clear();
    this.raycastToken = enabled ? randomBytes(32).toString("base64url") : null;
    return this.raycastToken;
  }
  stageRaycast(request: Request, invocation: LauncherInvocation) {
    // Recheck after reading the body in case pairing changed during the request.
    if (!this.requestHasRaycastToken(request)) return null;
    const now = Date.now();
    for (const [id, record] of this.handoffs) if (record.expires <= now || this.handoffs.size >= 32) this.handoffs.delete(id);
    const id = randomUUID();
    this.handoffs.set(id, { invocation, expires: now + 60_000 });
    return id;
  }
  consumeRaycast(id: string) {
    const record = this.handoffs.get(id);
    this.handoffs.delete(id);
    return record && record.expires > Date.now() ? record.invocation : null;
  }
  constructor(private config: ServerConfig) {}

  private matchesRaycast(token: string): boolean {
    return this.raycastToken !== null && tokensMatch(token, this.raycastToken);
  }

  requestHasRaycastToken(request: Request): boolean {
    const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    return Boolean(token && this.matchesRaycast(token));
  }

  async isActiveHash(hash: string): Promise<boolean> {
    return hash === hashToken(this.config.token);
  }

  async scopeForToken(token: string, request?: Request): Promise<TokenScope | null> {
    const trimmed = token.trim();
    if (request && this.matchesRaycast(trimmed)) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && ["/workspaces", "/launcher/search", "/launcher/catalog", "/launcher/folders", "/assistant/work"].includes(path)) return "viewer";
      if (request.method === "POST" && path === "/launcher/files/visible") return "viewer";
      if (request.method === "POST" && ["/launcher/context", "/launcher/raycast/handoff"].includes(path)) return "collaborator";
      return null;
    }
    return trimmed && tokensMatch(trimmed, this.config.token) ? "collaborator" : null;
  }
}
