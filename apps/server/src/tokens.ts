import type { ServerConfig, TokenScope } from "./types.js";
import { tokensMatch, hashToken } from "./utils.js";

/** Only the configured application credential is accepted. Legacy share tokens are retired. */
export class TokenService {
  constructor(private config: ServerConfig) {}

  async isActiveHash(hash: string): Promise<boolean> {
    return hash === hashToken(this.config.token);
  }

  async scopeForToken(token: string): Promise<TokenScope | null> {
    const trimmed = token.trim();
    return trimmed && tokensMatch(trimmed, this.config.token) ? "collaborator" : null;
  }
}
