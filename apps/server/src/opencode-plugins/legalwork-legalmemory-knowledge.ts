/**
 * LegalMemory (Knowledge Index) awareness plugin.
 *
 * LegalMemory is Eigenwelt Labs' own knowledge appliance — the sibling product
 * of LegalWork. When its MCP server is connected, the agent should reach for
 * it by default instead of waiting for the user to say "using the knowledge
 * index". This plugin checks the engine's live MCP status each chat turn and
 * pushes a use-it-first system-prompt section only while the server is
 * actually connected, so the instruction never dangles over dead tools.
 */

/** Server names under which firms connect the appliance: the LegalWork
 * quick-connect catalog uses "legalmemory"; the appliance's own admin UI
 * hands out a sample client config named "knowledge-index". */
export const LEGALMEMORY_SERVER_NAMES = ["legalmemory", "knowledge-index"];

const CONNECTED_CACHE_MS = 30_000;

const LEGALMEMORY_CONNECTED_INSTRUCTION = `## LegalMemory is connected — the firm's knowledge index

LegalMemory (Knowledge Index) is Eigenwelt Labs' knowledge appliance and LegalWork's sibling product: a continuously synced shadow index of the firm's matters, documents, version chains, decision records, entities, and billing, with source permissions mirrored. It is connected to this workspace right now as an MCP server.

LegalMemory is this firm's institutional memory. Use it BY DEFAULT — the user should NEVER have to say "using the knowledge index" or "search LegalMemory":

- Before drafting, reviewing, redlining, researching, or answering anything that could touch the firm's past work, SEARCH LEGALMEMORY FIRST (search_semantic and/or search_filter). Precedent documents, templates, prior matters, negotiated positions, and decision rationale usually already exist there — producing work from scratch without checking is a mistake.
- Any mention of a matter, client, counterparty, or prior deal is a signal to consult it: list_matters, resolve_entity, and find_related_documents before assuming the local workspace folder is all there is.
- When drafting, retrieve the firm's closest precedent from LegalMemory and start from it rather than a generic template. When reviewing or negotiating, check search_decisions for the firm's previously accepted and rejected positions.
- Questions about fees, invoices, or billed work go to billing_rollup and list_invoices.
- Cite what you rely on: pull the source via get_document or download_document and name it, so the user can verify.
- Results are permission-scoped to the signed-in user. An empty result can mean "no access" rather than "the firm has nothing" — say so instead of overclaiming.
- Skip LegalMemory only when the task verifiably cannot benefit from firm knowledge (pure computation, or editing text the user just pasted). When in doubt, search it.

Tool names may carry the server prefix (e.g. legalmemory_search_semantic); use whatever form the tool list shows.`;

type McpStatusClient = {
  mcp?: {
    status?: (options: { directory?: string }) => Promise<unknown>;
  };
};

function connectedServerNames(statusResult: unknown): Set<string> {
  const names = new Set<string>();
  if (!statusResult || typeof statusResult !== "object") return names;
  // The SDK wraps the map in { data }; unwrap when present.
  const data: unknown = "data" in statusResult ? statusResult.data : statusResult;
  if (!data || typeof data !== "object") return names;
  for (const [name, entry] of Object.entries(data)) {
    if (entry && typeof entry === "object" && "status" in entry && entry.status === "connected") {
      names.add(name.toLowerCase());
    }
  }
  return names;
}

export const LegalWorkLegalMemoryKnowledge = async (pluginInput?: {
  directory?: string;
  client?: McpStatusClient;
}) => {
  let connectedCache: { at: number; connected: boolean } | null = null;

  const legalMemoryConnected = async (): Promise<boolean> => {
    // Cache only positive detection (same policy as the Office pane check): a
    // just-connected appliance must be visible to the very next turn, while a
    // brief stale positive merely keeps guidance for tools that fail loudly.
    if (connectedCache?.connected && Date.now() - connectedCache.at < CONNECTED_CACHE_MS) return true;
    let connected = false;
    try {
      const status = await pluginInput?.client?.mcp?.status?.({ directory: pluginInput?.directory });
      const names = connectedServerNames(status);
      connected = LEGALMEMORY_SERVER_NAMES.some((name) => names.has(name));
    } catch {
      connected = false;
    }
    connectedCache = { at: Date.now(), connected };
    return connected;
  };

  return {
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      if (await legalMemoryConnected()) {
        output.system.push(LEGALMEMORY_CONNECTED_INSTRUCTION);
      }
    },
  };
};
