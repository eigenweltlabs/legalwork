import { z } from "zod";
import type { Plugin } from "@opencode/plugin";
import type { Result } from "@opencode/plugin/promise/tool";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { PDFDocument } from "pdf-lib";
import { ApiError } from "../errors.js";
import { nativeToolContext } from "./native-tool.js";
import { pdfReadOptions, pdfTextResult, PDF_MAX_BYTES, PDF_ATTACHMENT_MAX_BYTES, PDF_READING_RECOVERY } from "../pdf-read-schema.js";
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
  path: z.string(),
  offset: z.number().int().min(0).optional().describe("PDF: 0-based character offset in returned embedded/OCR text (default 0). Follow next_offset with the same pages and modes. Does not select PDF pages, reduce extraction/OCR work or affect attachments. Other files use native line offsets."),
  limit: z.number().int().min(0).optional().describe("PDF: maximum returned text characters, including OCR text (default 16000, maximum 80000). Does not limit extraction/OCR work or attachment size; select pages for that. Other files use native line limits."),
});
const nativeMediaLimit = z.object({
  _tag: z.literal("Tool.Error"),
  error: z.object({ _tag: z.literal("ReadTool.MediaIngestLimitError"), resource: z.string(), maximumBytes: z.literal(20 * 1024 * 1024) }),
});

async function attachPdf(file: Attachment, pages: number[] | undefined, signal: AbortSignal | undefined): Promise<PdfResult> {
  signal?.throwIfAborted();
  let bytes: Uint8Array = new Uint8Array(Buffer.from(file.url.slice("data:application/pdf;base64,".length), "base64"));
  const source = await PDFDocument.load(bytes);
  const pageCount = source.getPageCount();
  if (pageCount > 1000) throw new ApiError(400, "pdf_page_count", "PDFs must contain at most 1000 pages. Split the source into smaller PDFs before reading.");
  const selected = [...new Set(pages ?? Array.from({ length: pageCount }, (_, i) => i + 1))].sort((a, b) => a - b);
  if (selected.some(page => page > pageCount)) throw new ApiError(400, "pdf_page", `This PDF has ${pageCount} pages. Choose source page numbers between 1 and ${pageCount} with pages.`);
  if (pages) {
    const subset = await PDFDocument.create();
    for (const page of await subset.copyPages(source, selected.map(page => page - 1))) subset.addPage(page);
    bytes = await subset.save();
  }
  signal?.throwIfAborted();
  const attachment = { ...file, url: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}` };
  // Count the serialized attachment, including base64 and its file envelope, before it reaches the model.
  const attachmentBytes = Buffer.byteLength(JSON.stringify({ type: "file", uri: attachment.url, mime: attachment.mime, name: attachment.filename }));
  const metadata = { extraction: "pdf", page_count: pageCount, pages: selected,
    pdf_bytes: bytes.byteLength, attachment_bytes: attachmentBytes, max_attachment_bytes: PDF_ATTACHMENT_MAX_BYTES };
  if (attachmentBytes > PDF_ATTACHMENT_MAX_BYTES) {
    const output = { ...metadata, ok: false, attached: false, code: "pdf_attachment_too_large",
      message: "The selected PDF attachment is too large (maximum 2 MB including base64 overhead). Nothing was attached. Pick fewer pages with attach=true, or use attach=false for text extraction (text=true), OCR (ocr=true), or both (text=true, ocr=true). Do not repeat the unchanged attachment request." };
    return { title: file.filename ?? "PDF", output: JSON.stringify(output), metadata: output };
  }
  const output = { ...metadata, attached: true, truncated: false, message: "PDF supplied directly. Read its text and page images. Attached pages follow the source page numbers in pages. offset/limit do not affect this attachment; use pages to select PDF pages." };
  return { title: file.filename ?? "PDF", output: JSON.stringify(output), metadata: output, attachments: [attachment] };
}

export function pdfReading() {
  const models = new Map<string, boolean>();
  const description = " Read PDFs with this tool; no PDF skill or shell is needed. Three combinable modes are available: text=true extracts embedded text only; ocr=true explicitly recognizes selected pages and returns recognized text; attach=true sends selected PDF pages directly to a PDF-capable model for visual inspection (maximum 2 MB including base64 overhead). When no mode is specified, text defaults to true and ocr/attach to false. pages selects 1-based source pages for all requested modes; omitted means all pages. Source PDFs can be at most 64 MiB and 1000 pages; OCR can process at most 100 pages per call; text extraction is limited to 2 million characters. pages_without_embedded_text and page_sources report text-layer and extraction coverage. Pages without embedded text may contain scans, images or be blank. complete describes extraction coverage of selected pages, not whether all text was returned or visual content inspected. offset and limit only paginate returned embedded/OCR text, never PDF pages, processing work or attachment bytes. offset is a 0-based character position; limit defaults to 16000 characters (maximum 80000). When truncated=true, next_offset is the continuation position with the same path, pages and modes. Other files retain native line offsets and limits. Errors include recovery information. Missing extracted text is not evidence of absent content.";

  const read = async (file: Attachment, options: z.infer<typeof pdfReadOptions> & { offset?: number; limit?: number }, context: OpenCodeContext): Promise<PdfResult> => {
    try {
      const prefix = "data:application/pdf;base64,";
      if (!file.url.startsWith(prefix) || file.url.length - prefix.length > Math.ceil(PDF_MAX_BYTES / 3) * 4)
        throw new ApiError(400, "pdf_input", "PDF reading requires a local PDF file of at most 64 MiB. Split an oversized source into smaller PDFs; pages and offset/limit do not reduce the source file size.");
      const text = options.text ?? (!options.attach && options.ocr !== true);
      let attached: PdfResult | undefined;
      if (options.attach) {
        const supportsPdf = context.sessionID ? models.get(context.sessionID) : undefined;
        if (supportsPdf === undefined) throw new ApiError(400, "pdf_model_unknown", "Cannot determine the model's PDF capability. Select a PDF-capable model, or use attach=false with text=true and/or ocr=true.");
        if (!supportsPdf) throw new ApiError(400, "pdf_model_unsupported", "The selected model does not accept PDF attachments. Use attach=false with text=true, ocr=true, or both.");
        attached = await attachPdf(file, options.pages, context.abort);
        if (!attached.attachments || !text && !options.ocr) return attached;
      }
      if (!text && !options.ocr) throw new ApiError(400, "pdf_read_mode", "No PDF read mode was selected. Choose text=true for embedded text, ocr=true for recognition, attach=true for visual inspection, or combine these modes.");
      const workspace = await resolveWorkspaceId(context, { requireDirectory: true });
      const response = await fetch(`${serverUrl()}/workspace/${encodeURIComponent(workspace)}/pdf/read`, {
        method: "POST", headers: { ...await workspaceToolHeaders(context), "Content-Type": "application/json" },
        body: JSON.stringify({ dataBase64: file.url.slice(prefix.length), text, ocr: options.ocr === true, pages: options.pages }),
        signal: context.abort ? AbortSignal.any([context.abort, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000),
      });
      if (!response.ok) {
        const error = z.object({ code: z.string().optional(), message: z.string() }).safeParse(await response.json().catch(() => null));
        throw new ApiError(response.status, error.success ? error.data.code ?? "pdf_read_failed" : "pdf_read_failed",
          error.success ? error.data.message : `PDF reading failed (HTTP ${response.status}). Check the server and OCR settings; use pages to select fewer pages before retrying.`);
      }
      const parsed = pdfTextResult.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ApiError(502, "pdf_read_response", "The PDF reader returned an invalid response. Check that the LegalWork server and PDF tools use the same version before retrying.");
      const result = parsed.data;
      const full = result.pages.map(page => page.native_text === undefined
        ? `[Page ${page.page}]\n${page.text}`
        : `[Page ${page.page} - embedded text]\n${page.native_text}\n\n[Page ${page.page} - OCR]\n${page.text}`).join("\n\n");
      const offset = options.offset ?? 0, end = offset + Math.max(1, Math.min(options.limit ?? 16000, 80000));
      const errors = result.pages.flatMap(page => page.error ? [{ page: page.page, error: page.error }] : []);
      const pagesWithoutEmbeddedText = result.pages.filter(page => page.embedded_text_chars === 0).map(page => page.page);
      const unrecognizedPages = result.pages.filter(page => page.extraction === "native" && page.embedded_text_chars === 0).map(page => page.page);
      const metadata = { ...attached?.metadata, attached: Boolean(attached), extraction: result.extraction, complete: result.complete, source_hash: result.source_hash,
        page_count: result.page_count, pages: result.pages.map(page => page.page),
        page_sources: result.pages.map(page => ({ page: page.page, extraction: page.extraction, embedded_text_chars: page.embedded_text_chars })),
        pages_without_embedded_text: pagesWithoutEmbeddedText, ocr_requested: options.ocr === true,
        errors, total_chars: full.length, returned_chars: full.slice(offset, end).length,
        truncated: end < full.length, ...(end < full.length ? { next_offset: end } : {}) };
      return { title: file.filename ?? "PDF", output: JSON.stringify({ ...metadata, text: full.slice(offset, end),
        ...(errors.length ? { issue: "OCR failed on the pages listed in errors. Embedded text may still be present, but recognition is incomplete. Resolve the reported OCR error before retrying those pages, or use attach=true with selected pages for visual inspection. Do not infer missing content is absent." }
          : unrecognizedPages.length ? { issue: `No embedded text on source pages ${unrecognizedPages.join(", ")}. OCR was not requested and did not run. These pages may contain scans, images or be blank. Read those pages with ocr=true, attach=true, or both to inspect them.` } : {}) }),
        metadata, ...(attached ? { attachments: attached.attachments } : {}) };
    } catch (error) {
      context.abort?.throwIfAborted();
      const timeout = error instanceof Error && (error.name === "TimeoutError" || /timed out|timeout/i.test(error.message));
      const output = { ok: false, attached: false, code: error instanceof ApiError ? error.code : timeout ? "pdf_read_timeout" : "pdf_read_failed",
        requested: { text: options.text ?? (!options.attach && options.ocr !== true), ocr: options.ocr === true, attach: options.attach === true, pages: options.pages },
        message: timeout ? "PDF reading timed out. Select fewer pages with pages, especially for OCR. offset/limit only paginate returned text and do not reduce extraction/OCR work. Use text=true without ocr for embedded text, or attach=true with selected pages for visual inspection (maximum 2 MB encoded). Do not repeat the unchanged call."
          : error instanceof ApiError ? error.message : `PDF reading failed: ${error instanceof Error ? error.message : String(error)}. Check that the PDF is valid and not password-protected. Select fewer pages for OCR; use text=true for embedded text or attach=true for visual inspection. Do not repeat an unchanged failed call.` };
      return { title: file.filename ?? "PDF", output: JSON.stringify(output), metadata: output };
    }
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
          tool.description = tool.description.replace("Images and PDFs are presented directly to the model.", "Images are presented directly to the model.")
            + description + " " + PDF_READING_RECOVERY;
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
