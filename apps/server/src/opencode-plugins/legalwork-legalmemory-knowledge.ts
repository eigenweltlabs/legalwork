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
 * hands out a sample client config named "knowledge-index".
 *
 * Deliberately NOT exported. The engine's plugin loader treats every export of
 * a plugin module as a plugin factory and calls it, so exporting a value here
 * fails the whole module with "Plugin export is not a function" and the
 * guidance below silently never loads. */
const LEGALMEMORY_SERVER_NAMES = ["legalmemory", "knowledge-index"];

const LEGALMEMORY_CONNECTED_INSTRUCTION = `## LegalMemory is connected — the firm's knowledge index

LegalMemory (Knowledge Index) is Eigenwelt Labs' knowledge appliance and LegalWork's sibling product: a continuously synced shadow index of the firm's matters, documents, version chains, decision records, entities, and billing, with source permissions mirrored. It is connected to this workspace right now as an MCP server.

LegalMemory is this firm's institutional memory. Use it BY DEFAULT — the user should NEVER have to say "using the knowledge index" or "search LegalMemory":

- Before drafting from scratch, conducting a substantive review, researching, negotiating, or answering anything that depends on the firm's past work, SEARCH LEGALMEMORY FIRST (search_semantic and/or search_filter). Precedent documents, templates, prior matters, negotiated positions, and decision rationale usually already exist there — producing new substantive work from scratch without checking is a mistake.
- Do NOT search LegalMemory for a direct, fully specified edit to the current/open document (for example, "replace X with Y", "increase these figures by 10%", or "fix this typo"). Read and edit the document the user is looking at. Search only if the user asks for firm precedent/knowledge or the requested work genuinely requires missing facts.
- Any mention of a matter, client, counterparty, or prior deal is a signal to consult it: list_matters, resolve_entity, and find_related_documents before assuming the local workspace folder is all there is.
- ANSWER FROM THE CURRENT, CONTROLLING DOCUMENT, NOT THE FIRST HIT. The index holds every version — drafts, redlines, superseded originals. For any question about what a document actually says or obliges today, search with only_final=true (search_filter) so you see executed and effective versions, then run find_related_documents on the leading hit and follow the supersedes / annex_of / references / responds_to edges (traverse for exact stored edges) to find the amendment, supplemental deed, side letter, or annex that varies it. State which instrument controls and which one it displaced. Quoting a superseded clause as current is the single worst failure mode here.
- TRAVERSE BEFORE YOU CONCLUDE. Once you have read the documents you intend to rely on, call find_related_documents on the leading one. This is not optional and not only for when the user asks for "related files": a term sheet has a definitive agreement, a draft has a final, a brief has its exhibits, and those links are stored with the evidence that established them. A search cannot reproduce them, so an answer that skips this step is an answer from search alone. It matters most when you are about to say something is absent: "the agreement is not in the index" is a strong claim, and traversing what you did find is how you check it rather than assume it. LegalWork renders the result as the matter graph, which is the one card in the reply that is not foldable.
- Do not approximate a graph with repeated semantic searches.
- Narrow by the firm's own ontology rather than guessing keywords: list_taxonomies for the document-type and Area of Law facets, ontology_search / ontology_children to find a node id, then pass it as doc_type (search_filter/search_semantic) or practice_area (list_matters). Both match the node's whole subtree.
- When drafting, retrieve the firm's closest precedent from LegalMemory and start from it rather than a generic template. When reviewing or negotiating, check search_decisions for the firm's previously accepted and rejected positions.
- Questions about fees, invoices, or billed work go to billing_rollup and list_invoices.
- Cite what you rely on: pull the source via get_document or download_document and name it, so the user can verify. Every evidence-bearing result carries a citations array — never make a factual claim from a result whose citations array is empty.
- CITE EVERY DOCUMENT YOU NAME, as a markdown link carrying its real id from the tool results: [<document title>](legalmemory://document/<document_id>). Take document_id verbatim from citations[].document.id; never invent, abbreviate or reformat it. LegalWork turns these into chips that open the original, and builds the Sources list under your answer from them. A claim about a document without a citation is not an answer; if you cannot cite it, do not assert it.
- Cite a document where you actually rely on it, not everywhere it might be relevant. The Sources list is built from these citations, so a document you cite once because it looked related puts a source under the answer that supports none of it.
- DO NOT write your own "Sources", "References" or bibliography section, and do not name a document in bold prose instead of citing it. LegalWork renders the source list from your citation links, and a hand-written one sits directly above a duplicate of itself while its entries are not clickable.
- Do not download or copy a document just so the user can open it. Clicking a citation opens the original in LegalWork directly. Call download_document only when the task genuinely needs the file's bytes in the workspace, for example to edit or redline it.
- Results are permission-scoped to the signed-in user. An empty result can mean "no access" rather than "the firm has nothing" — say so instead of overclaiming.
- Skip LegalMemory when the task verifiably cannot benefit from firm knowledge: pure computation, editing text the user just pasted, or applying a concrete user-specified change to the current/open document. When substantive firm context could change the answer, search it.

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
  const connected = async (): Promise<Set<string>> => {
    try {
      return connectedServerNames(await pluginInput?.client?.mcp?.status?.({ directory: pluginInput?.directory }));
    } catch {
      return new Set();
    }
  };
  const serverForTool = (tool: string) => LEGALMEMORY_SERVER_NAMES.find(
    (name) => tool.startsWith(`${name}_`) || tool.startsWith(`${name.replaceAll("-", "_")}_`),
  );

  return {
    "experimental.chat.system.transform": async (_input: unknown, output: { system: string[] }) => {
      const names = await connected();
      if (LEGALMEMORY_SERVER_NAMES.some((name) => names.has(name))) {
        output.system.push(LEGALMEMORY_CONNECTED_INSTRUCTION);
      }
    },
    // Tool definitions can survive inside an already-running turn. Check the
    // live connection again before each call, without a positive cache.
    "tool.execute.before": async (input: { tool: string }) => {
      const name = serverForTool(input.tool);
      if (name && !(await connected()).has(name)) {
        throw new Error("LegalMemory is disconnected. Reconnect it in Settings before using its tools.");
      }
    },
    // MCP results reach this hook before OpenCode saves oversized output. A
    // compact JSON page can exceed ripgrep's 64 KiB record limit by itself.
    "tool.execute.after": async (input: { tool: string }, output: { content?: unknown }) => {
      if (!serverForTool(input.tool) || !Array.isArray(output.content)) return;
      for (const item of output.content) {
        if (!item || typeof item !== "object" || item.type !== "text" || typeof item.text !== "string") continue;
        if (item.text.length < 16_384) continue;
        try {
          const value: unknown = JSON.parse(item.text);
          if (value && typeof value === "object") item.text = JSON.stringify(value, null, 2);
        } catch {
          // Plain text and incomplete JSON must remain verbatim.
        }
      }
    },
  };
};
