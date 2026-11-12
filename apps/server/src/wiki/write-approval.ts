import type { WikiRegistration } from "@legalwork/types/wiki";
import type { ApprovalRequest, ServerConfig } from "../types.js";
import type { RequestContext } from "../routes/registry.js";
import { ApiError } from "../errors.js";
import { authenticateWikiAgentRequest } from "./agent-access.js";
import { wikiForDirectory } from "./access.js";

/** Project agents can stage drafts, but only a human review action publishes them. */
export async function approveWikiWrite(ctx: RequestContext, config: ServerConfig, wiki: WikiRegistration,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
  standard: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>,
) {
  const agent = await authenticateWikiAgentRequest(config, ctx.request);
  if (!agent || wikiForDirectory([wiki], agent.directory, config.workspaces)?.id === wiki.id) return standard(ctx, input);
  throw new ApiError(403, "wiki_suggestion_required", "Project agents cannot write directly to a wiki. Use wiki_suggest to contribute a page and sources. The wiki approval setting controls whether it waits for human review or is saved in the background. Edit or delete other wiki resources in that wiki workspace.");
}
