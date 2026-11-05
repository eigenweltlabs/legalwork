import { z } from "zod";
import type { Plugin } from "@opencode/plugin";
import type { Result } from "@opencode/plugin/promise/tool";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { nativeToolContext } from "./native-tool.js";
import { pdfReadOptions, pdfTextResult, PDF_MAX_BYTES } from "../pdf-read-schema.js";
import { resolveWorkspaceId, serverUrl, workspaceToolHeaders, type OpenCodeContext } from "./office-plugin-shared.js";

type Attachment = { type: "file"; mime: string; url: string; filename?: string };
type PdfResult = { title: string; output: string; metadata: Record<string, unknown>; attachments?: Attachment[] };
export class PdfToolResult { constructor(readonly result: Result) {} }

export function nativePdfResult(result: PdfResult): Result {
  return { output: JSON.parse(result.output), content: [{ type: "text", text: result.output },
    ...(result.attachments ?? []).map(file => ({ type: file.type, uri: file.url, mime: file.mime, name: file.filename }))],
    metadata: { ...result.metadata, title: result.title } };
}

const readArgs = pdfReadOptions.extend({
  path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(0).optional(),
});
const nativeMediaLimit = z.object({
  _tag: z.literal("Tool.Error"),
  error: z.object({ _tag: z.literal("ReadTool.MediaIngestLimitError"), resource: z.string(), maximumBytes: z.literal(20 * 1024 * 1024) }),
});

export function pdfReading() {
  const models = new Map<string, boolean>();
  const description = " Read PDFs with this tool; no PDF skill or shell is needed. PDF-capable models receive the PDF directly. Other models receive embedded text, using OCR only on pages without text. Set ocr=true only when OCR is explicitly requested or needed for visual additions. pages selects 1-based PDF pages for text/OCR; PDF-capable models still receive the original PDF. For PDF text, offset is a 0-based character offset and limit is a character count (default 16000, maximum 80000); follow next_offset. Other files retain their normal line offsets and limits. Never repeat an unchanged failed read; report the error or change the indicated settings.";

  const read = async (file: Attachment, options: z.infer<typeof pdfReadOptions> & { offset?: number; limit?: number }, context: OpenCodeContext): Promise<PdfResult> => {
    const supportsPdf = context.sessionID ? models.get(context.sessionID) : undefined;
    if (supportsPdf === undefined) throw new Error("PDF reading could not determine the current model's PDF capability. Select a model and retry.");
    const prefix = "data:application/pdf;base64,";
    if (!file.url.startsWith(prefix) || file.url.length - prefix.length > Math.ceil(PDF_MAX_BYTES / 3) * 4)
      throw new Error("PDF reading requires a local PDF attachment of at most 64 MiB.");
    const original: PdfResult = { title: file.filename ?? "PDF", output: JSON.stringify({ extraction: "pdf", message: "PDF supplied directly. Read its text and page images.", ...(options.pages ? { requested_pages: options.pages } : {}) }), metadata: { extraction: "pdf", truncated: false }, attachments: [file] };
    if (supportsPdf && !options.ocr) return original;
    let result: z.infer<typeof pdfTextResult>;
    try {
      const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
      const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/pdf/read`, {
        method: "POST", headers: { ...await workspaceToolHeaders(context), "Content-Type": "application/json" },
        body: JSON.stringify({ dataBase64: file.url.slice(prefix.length), ocr: options.ocr, pages: options.pages }),
        signal: context.abort ? AbortSignal.any([context.abort, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000),
      });
      if (!response.ok) {
        const error = z.object({ message: z.string() }).safeParse(await response.json().catch(() => null));
        throw new Error(error.success ? error.data.message : `PDF reading failed (HTTP ${response.status}). Check the document and OCR settings before retrying.`);
      }
      result = pdfTextResult.parse(await response.json());
    } catch (error) {
      context.abort?.throwIfAborted();
      if (!supportsPdf) throw error;
      const issue = error instanceof Error ? error.message : "Explicit OCR failed.";
      return { ...original, output: JSON.stringify({ extraction: "pdf", complete: false, ocr_error: issue, message: "The PDF is attached. Explicit OCR failed; report the error." }),
        metadata: { ...original.metadata, complete: false, ocr_error: issue } };
    }
    const full = result.pages.map(page => `[Page ${page.page}]\n${page.text}`).join("\n\n");
    const offset = options.offset ?? 0, end = offset + Math.max(1, Math.min(options.limit ?? 16000, 80000));
    const errors = result.pages.flatMap(page => page.error ? [{ page: page.page, error: page.error }] : []);
    const metadata = { extraction: result.extraction, complete: result.complete, source_hash: result.source_hash,
      page_count: result.page_count, pages: result.pages.map(page => page.page),
      page_sources: result.pages.map(page => ({ page: page.page, extraction: page.extraction })), errors, total_chars: full.length,
      truncated: end < full.length, ...(end < full.length ? { next_offset: end } : {}) };
    return { title: file.filename ?? "PDF", output: JSON.stringify({ ...metadata, text: full.slice(offset, end),
      ...(!result.complete ? { issue: "Some requested pages could not be recognized. Do not infer that missing content is absent. Resolve the reported error before retrying." } : {}) }),
      metadata, ...(supportsPdf ? { attachments: [file] } : {}) };
  };

  return {
    read,
    async register(ctx: Plugin.Context) {
      await ctx.session.hook("model.request", async event => {
        // Auxiliary title/compaction requests must not replace the active tool model.
        if (event.kind !== "primary") return;
        const session = await ctx.session.get({ sessionID: event.sessionID });
        const catalog = await ctx.model.list({ location: session.location });
        const model = catalog.data.find(model => model.providerID === event.model.providerID && model.id === event.model.id);
        if (!model) throw new Error("PDF reading could not determine the current model's PDF capability. Select a model and retry.");
        models.set(event.sessionID, model.capabilities.input.includes("pdf"));
      });
      await ctx.tool.transform(editor => {
        const original = editor.list().find(tool => tool.name === "read");
        if (!original) return;
        editor.update(original.id, tool => {
          const execute = tool.execute;
          tool.description += description;
          tool.input = z.toJSONSchema(readArgs);
          // Native text/directory results and PDF extraction envelopes are both retained truthfully.
          tool.output = z.toJSONSchema(z.json());
          tool.execute = async (input, call) => {
            const args = readArgs.parse(input);
            // The native reader still authorizes the path and handles all ordinary files.
            let result: Result;
            try { result = await execute(input, call); }
            catch (error) {
              call.signal.throwIfAborted();
              const limit = nativeMediaLimit.safeParse(error);
              if (!limit.success) throw error;
              // Only this native error occurs after native directory/read authorization.
              // Keep LegalWork's existing 64 MiB PDF reader instead of inheriting v2's 20 MiB media cap.
              const context = await nativeToolContext(ctx, call);
              const resource = limit.data.error.resource;
              const path = resolve(context.directory!, resource), target = await realpath(path);
              await ctx.permission.assert({ sessionID: call.sessionID, agent: call.agent,
                source: { type: "tool", messageID: call.messageID, id: call.id }, action: "read", resources: [resource, target] });
              if (await realpath(path) !== target) throw new Error("The PDF path changed during authorization. Retry the read.");
              const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > PDF_MAX_BYTES) throw error;
                const bytes = await handle.readFile({ signal: call.signal });
                call.signal.throwIfAborted();
                if (bytes.length > PDF_MAX_BYTES || !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw error;
                const pdf = await read({ type: "file", mime: "application/pdf", url: `data:application/pdf;base64,${bytes.toString("base64")}`, filename: resource }, args, context);
                call.signal.throwIfAborted();
                return nativePdfResult(pdf);
              } finally { await handle.close(); }
            }
            call.signal.throwIfAborted();
            const file = typeof result.content === "string" ? undefined : result.content?.find(item => item.type === "file" && item.mime === "application/pdf");
            if (!file || file.type !== "file") {
              const output = result.output;
              // Native page results are schema class instances; the JSON output schema needs their plain fields.
              if (output && typeof output === "object" && Object.getPrototypeOf(output) !== Object.prototype && "type" in output &&
                (output.type === "list-page" || output.type === "text-page")) return { ...result, output: { ...output } };
              return result;
            }
            const context = await nativeToolContext(ctx, call);
            const pdf = await read({ type: "file", mime: file.mime, url: file.uri, filename: file.name }, args, context);
            call.signal.throwIfAborted();
            return { ...nativePdfResult(pdf), metadata: { ...result.metadata, ...pdf.metadata, title: pdf.title } };
          };
        });
      });
    },
  };
}
