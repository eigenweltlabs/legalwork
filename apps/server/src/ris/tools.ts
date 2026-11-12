import { z } from "zod";
import { buildAboutTool } from "./tools/about.js";
import { buildListScopesTool } from "./tools/list-scopes.js";
import { buildSearchTool } from "./tools/search.js";
import { buildGetDocumentTool } from "./tools/get-document.js";
import { buildGetSectionTool } from "./tools/get-section.js";
import { buildGetRelatedTool } from "./tools/get-related.js";
import { buildVerifyTool } from "./tools/verify.js";
import { buildGetHistoryTool } from "./tools/get-history.js";
import { buildDownloadPdfTool, type SaveRisPdf } from "./tools/download-pdf.js";
import { RisClient } from "./client/ris-client.js";
import { RisValidationError } from "./infrastructure/errors.js";

function defineTool<I, O>(action: string, tool: {
  description: string; inputSchema: z.ZodType<I>; outputSchema: z.ZodType<O>;
  handler: (input: I) => Promise<O>;
}, writes = false) {
  return { action, title: `RIS: ${action.replace(/^ris_/, "").replaceAll("_", " ")}`, description: tool.description, writes,
    inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }), outputSchema: z.toJSONSchema(tool.outputSchema),
    async run(args: unknown) {
      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) throw new RisValidationError(`Invalid RIS tool arguments: ${parsed.error.issues.map(issue => `${issue.path.join(".") || "args"}: ${issue.message}`).join("; ")}`, { issues: parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })) });
      validateDates(parsed.data);
      const output = await tool.handler(parsed.data);
      // Validate without stripping the richer full citation variant through
      // the lean-first union inherited from the upstream MCP contract.
      if (!tool.outputSchema.safeParse(output).success) throw new Error("RIS returned an invalid tool result. No verified result is available.");
      return output;
    },
  };
}

export function risTools(client: RisClient, savePdf?: SaveRisPdf) {
  return [defineTool("ris_about", buildAboutTool(client)), defineTool("ris_list_scopes", buildListScopesTool()),
    defineTool("ris_search", buildSearchTool(client)), defineTool("ris_get_document", buildGetDocumentTool(client)),
    defineTool("ris_get_section", buildGetSectionTool(client)), defineTool("ris_get_related", buildGetRelatedTool(client)),
    defineTool("ris_verify", buildVerifyTool(client)), defineTool("ris_get_history", buildGetHistoryTool(client)),
    defineTool("ris_download_pdf", buildDownloadPdfTool(client, savePdf), true)];
}

function validateDates(value: unknown) {
  if (typeof value !== "object" || value === null) return;
  const fields = Object.fromEntries(Object.entries(value));
  for (const key of ["date_from", "date_to", "in_force_on", "fassung_vom", "at_date", "from_date", "to_date"]) {
    if (fields[key] !== undefined && !z.iso.date().safeParse(fields[key]).success)
      throw new RisValidationError(`${key} must be a real calendar date in YYYY-MM-DD format.`);
  }
  for (const [from, to] of [["date_from", "date_to"], ["from_date", "to_date"]]) {
    const start = fields[from], end = fields[to];
    if (typeof start === "string" && typeof end === "string" && start > end)
      throw new RisValidationError(`${from} must not be after ${to}.`);
  }
}

export const RIS_ACTIONS = risTools(new RisClient()).map(({ run, ...action }) => ({ ...action, extensionId: "ris" }));
