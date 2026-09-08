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

import { t } from "@/i18n";

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
      return query
        ? t("legalmemory_activity.searching_knowledge", { query })
        : t("legalmemory_activity.searching_knowledge_generic");
    }
    case "search_filter":
      return args.only_final === true
        ? t("legalmemory_activity.filtering_final")
        : t("legalmemory_activity.filtering_metadata");
    case "find_related_documents":
      return t("legalmemory_activity.resolving_amendments");
    case "traverse":
      return t("legalmemory_activity.following_relations");
    case "get_document":
      return t("legalmemory_activity.reading_source");
    case "download_document":
      return t("legalmemory_activity.preparing_original");
    case "list_matters":
      return t("legalmemory_activity.listing_matters");
    case "search_decisions":
      return t("legalmemory_activity.checking_positions");
    case "resolve_entity":
      return t("legalmemory_activity.resolving_parties");
    case "billing_rollup":
    case "list_invoices":
      return t("legalmemory_activity.rolling_up_billed");
    case "list_taxonomies":
    case "ontology_search":
    case "ontology_roots":
    case "ontology_children":
    case "ontology_node":
      return t("legalmemory_activity.consulting_ontology");
    case "preview_search_scope":
      return t("legalmemory_activity.compiling_scope");
    default:
      return t("legalmemory_activity.querying_graph");
  }
}
