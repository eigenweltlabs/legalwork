/**
 * What a running LegalMemory tool is actually doing.
 *
 * While retrieval is in flight the transcript otherwise shows a bare tool name
 * like `legalmemory_search_filter`, which tells a lawyer nothing. Each label
 * below describes the real behavior of that tool, so the line stays true to
 * what the appliance is doing rather than narrating a fixed script.
 *
 * The tool arrives over MCP, so the name carries whichever server name the firm
 * connected under — the quick-connect catalog uses "legalmemory", the
 * appliance's own sample config says "knowledge-index".
 */

const SERVER_PREFIX = /^(?:legal[_-]?memory|knowledge[_-]?index)[_-]/i;

/** Every tool the appliance registers. Kept explicit so an unrelated MCP server
 * that happens to expose `get_document` is not mistaken for LegalMemory. */
const LEGALMEMORY_TOOLS = new Set([
  "search_filter",
  "search_semantic",
  "get_document",
  "download_document",
  "find_related_documents",
  "traverse",
  "list_matters",
  "billing_rollup",
  "list_invoices",
  "resolve_entity",
  "search_decisions",
  "list_taxonomies",
  "ontology_search",
  "ontology_roots",
  "ontology_children",
  "ontology_node",
  "preview_search_scope",
]);

/** Strip the server prefix, if the engine attached one. */
export function legalMemoryToolName(toolName: string): string | null {
  const bare = toolName.replace(SERVER_PREFIX, "").toLowerCase();
  return LEGALMEMORY_TOOLS.has(bare) ? bare : null;
}

type ActivityInput = {
  query?: unknown;
  only_final?: unknown;
  matter_id?: unknown;
  document_id?: unknown;
};

function quoted(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? `“${value.trim()}”` : null;
}

/**
 * A one-line description of the call in progress. Returns null when the tool is
 * not LegalMemory's, so callers can fall through to the generic tool card.
 */
export function legalMemoryActivityLabel(toolName: string, input: unknown): string | null {
  const name = legalMemoryToolName(toolName);
  if (!name) return null;
  const args = (input && typeof input === "object" ? input : {}) as ActivityInput;

  switch (name) {
    case "search_semantic": {
      const query = quoted(args.query);
      return query ? `Searching firm knowledge for ${query}` : "Searching firm knowledge";
    }
    case "search_filter":
      return args.only_final === true
        ? "Filtering to executed and effective documents"
        : "Filtering firm documents by legal metadata";
    case "find_related_documents":
      return "Resolving amendments, annexes and precedence";
    case "traverse":
      return "Following stored document relations";
    case "get_document":
      return "Reading the source document";
    case "download_document":
      return "Preparing the exact original";
    case "list_matters":
      return "Listing matters you can read";
    case "search_decisions":
      return "Checking the firm's decided positions";
    case "resolve_entity":
      return "Resolving parties and entities";
    case "billing_rollup":
    case "list_invoices":
      return "Rolling up billed work";
    case "list_taxonomies":
    case "ontology_search":
    case "ontology_roots":
    case "ontology_children":
    case "ontology_node":
      return "Consulting the firm ontology";
    case "preview_search_scope":
      return "Compiling your permission scope";
    default:
      return "Querying the LegalMemory knowledge graph";
  }
}
