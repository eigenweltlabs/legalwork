import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PDFDocument } from "pdf-lib";
import { epostDraft, epostQuote, epostReceipt } from "@legalwork/types/epost";
import { z } from "zod";
import { hasConnectorRuntimeCapability } from "../connectors/capability.js";
import { connectorSettingsPath } from "../connectors/settings.js";
import { atomicPrivateFile, missingFile } from "../connectors/storage-state.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { ApiError } from "../errors.js";
import { canonicalFilePath } from "../file-write-lock.js";
import { normalizeWorkspaceRelativePath } from "./files.js";
import { addRoute, type Route } from "./registry.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";

const maxBytes = 20_000_000;
const rawQuote = epostQuote.omit({ reviewId: true }).extend({ proof: z.string().length(64) });
const platformError = z.object({ error: z.string() });
const convert = promisify(execFile);
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function localPath(workspace: WorkspaceInfo, path: string) {
  const root = await canonicalFilePath(workspace.path);
  const target = await canonicalFilePath(resolve(root, normalizeWorkspaceRelativePath(path, { allowSubdirs: true })));
  const child = relative(root, target);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`))
    throw new ApiError(400, "epost_file_path", "Choose files inside this workspace.");
  return target;
}

async function fileBytes(workspace: WorkspaceInfo, path: string, limit = maxBytes) {
  const file = await open(await localPath(workspace, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
    throw new ApiError(404, "epost_file_missing", "A selected document is unavailable.");
  });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw new ApiError(413, "epost_file_size", "Selected documents must total 20 MB or less.");
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== data.length || (await file.stat()).size !== stat.size)
      throw new ApiError(409, "epost_file_changed", "A document changed. Review it again.");
    return data;
  } finally { await file.close(); }
}

async function createPacket(workspace: WorkspaceInfo, files: string[]) {
  const sources: { path: string; digest: string }[] = [];
  const packet = await PDFDocument.create();
  let remaining = maxBytes;
  let single: Buffer | undefined;
  for (const path of files) {
    if (!/\.pdf$/i.test(path)) throw new ApiError(400, "epost_pdf_required", "Choose PDF documents.");
    const data = await fileBytes(workspace, path, remaining);
    sources.push({ path, digest: hash(data) });
    remaining -= data.length;
    if (files.length === 1) { single = data; break; }
    try {
      const document = await PDFDocument.load(data, { updateMetadata: false, throwOnInvalidObject: true });
      for (const page of await packet.copyPages(document, document.getPageIndices())) packet.addPage(page);
      if (packet.getPageCount() > 186) throw new Error("page limit");
    } catch { throw new ApiError(400, "epost_pdf_invalid", "Choose readable, unencrypted PDFs within the page limit."); }
  }
  const pdf = single ?? Buffer.from(await packet.save({ useObjectStreams: false }));
  if (pdf.length > maxBytes) throw new ApiError(413, "epost_file_size", "The print packet must be 20 MB or less.");
  return { pdf: pdf.toString("base64"), sources };
}

async function platformRequest(config: ServerConfig, input?: unknown) {
  const connection = await readEigenweltConnection(config);
  const token = await ensureFreshPlatformToken(config);
  if (!connection.platformURL || !token) throw new ApiError(403, "epost_unavailable", "Connect a development account to use postal mail.");
  return fetch(`${connection.platformURL.replace(/\/$/, "")}/api/desktop/epost`, {
    method: input === undefined ? "GET" : "POST", redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(55_000),
  });
}

async function platformResult(config: ServerConfig, input: unknown): Promise<unknown> {
  let result: Response;
  try { result = await platformRequest(config, input); }
  catch { throw new ApiError(503, "epost_unavailable", "The postal mail service is unavailable. Check the submission status before trying again."); }
  const body: unknown = await result.json().catch(() => null);
  if (result.ok) return body;
  const parsed = platformError.safeParse(body);
  const code = parsed.success ? parsed.data.error : "epost_unavailable";
  const messages: Record<string, string> = {
    epost_invalid_input: "Check the sender, recipient, and mailing options. German postal codes require five digits.",
    epost_pdf_a4_portrait_required: "All pages must be portrait A4.",
    epost_invalid_pdf: "Choose a readable, unencrypted PDF.",
    epost_page_limit: "This mailing exceeds the 94-sheet limit, including its cover sheet.",
    epost_review_required: "The quote expired or the mailing changed. Review it again.",
    epost_operation_missing: "This mailing has no submission record yet.",
  };
  throw new ApiError(result.status, code, result.status === 402 ? "The development wallet or spending limit cannot cover this mailing." :
    messages[code] ?? "Postal mail could not complete the request.");
}

export function registerEpostRoutes(options: {
  routes: Route[]; config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const { routes, config, jsonResponse, readJsonBodyLimited, resolveWorkspace } = options;
  const statePath = async () => {
    const { account } = await readEigenweltConnection(config);
    return account?.orgId ? join(dirname(connectorSettingsPath(config)), `epost-${hash(JSON.stringify([account.orgId, account.userId]))}.json`) : null;
  };
  async function enabled(path: string | null) {
    if (!path) return false;
    try { return JSON.parse(await readFile(path, "utf8")) === true; }
    catch (error) { if (missingFile(error)) return false; throw error; }
  }
  const office = process.env.LEGALWORK_EPOST_SOFFICE ?? (process.platform === "darwin"
    ? "/Applications/LibreOffice.app/Contents/MacOS/soffice" : "/usr/bin/libreoffice");
  const available = async () => !config.readOnly && Boolean(await platformRequest(config).then(result => result.ok).catch(() => false));
  const status = async () => {
    const devAvailable = await available();
    const wordAvailable = devAvailable && Boolean(office && isAbsolute(office) &&
      await access(office, constants.X_OK).then(() => true).catch(() => false));
    return { available: devAvailable, enabled: devAvailable && await enabled(await statePath()), wordAvailable };
  };
  const reviews = new Map<string, {
    workspaceId: string; accountPath: string; sources: { path: string; digest: string }[];
    letter: Omit<z.infer<typeof epostDraft>, "files" | "workspaceId"> & { pdf: string };
    quote: z.infer<typeof rawQuote>;
  }>();
  const host = (method: string, path: string, handler: Route["handler"]) => addRoute(routes, method, path, "host-token", async ctx => {
    if (ctx.actor?.type !== "host" || ctx.actor.scope !== "owner") throw new ApiError(403, "forbidden", "Only the server owner can use postal mail.");
    if (method !== "GET" && config.readOnly) throw new ApiError(403, "read_only", "This server is read-only.");
    try { return await handler(ctx); }
    catch (error) {
      if (error instanceof z.ZodError) throw new ApiError(400, "epost_invalid_input", "Check the postal mail details.");
      throw error;
    }
  });
  host("GET", "/epost/settings", async () => jsonResponse(await status()));
  host("PUT", "/epost/settings", async ctx => {
    const { enabled: value } = z.object({ enabled: z.boolean() }).strict().parse(await readJsonBodyLimited(ctx.request, 1000));
    const path = await statePath();
    if (!path || (value && !await available())) throw new ApiError(403, "epost_unavailable", "Postal mail is unavailable.");
    await atomicPrivateFile(path, JSON.stringify(value));
    if (!value) reviews.clear();
    return jsonResponse(await status());
  });
  addRoute(routes, "GET", "/epost/agent", "client", async ctx => {
    if (!hasConnectorRuntimeCapability(config, ctx.request)) throw new ApiError(403, "forbidden", "Postal mail drafting requires the managed workspace agent.");
    const current = await status();
    return jsonResponse({ enabled: current.enabled });
  });
  host("POST", "/workspace/:id/epost", async ctx => {
    const accountPath = await statePath();
    if (!accountPath || !await enabled(accountPath)) throw new ApiError(403, "epost_disabled", "Enable Postal mail in Settings first.");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const input = z.discriminatedUnion("action", [
      z.object({ action: z.literal("review"), draft: epostDraft }),
      z.object({ action: z.literal("submit"), reviewId: z.uuid() }),
      z.object({ action: z.literal("status"), id: z.uuid() }),
      z.object({ action: z.literal("convert"), path: z.string().min(1).max(2048) }),
    ]).parse(await readJsonBodyLimited(ctx.request, 65_536));
    if (input.action === "status") return jsonResponse(epostReceipt.parse(await platformResult(config, input)));
    if (input.action === "convert") {
      if (!office || !isAbsolute(office) || !/\.docx$/i.test(input.path))
        throw new ApiError(400, "epost_word_unavailable", "Configure the development Word-to-PDF converter.");
      const temp = await mkdtemp(join(tmpdir(), "legalwork-epost-"));
      try {
        const source = join(temp, "source.docx");
        await writeFile(source, await fileBytes(workspace, input.path), { mode: 0o600 });
        await convert(office, [`-env:UserInstallation=${pathToFileURL(join(temp, "profile")).href}`, "--headless", "--convert-to",
          'pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"1"}}', "--outdir", temp, source],
          { timeout: 60_000, maxBuffer: 16_384 });
        const pdf = await readFile(join(temp, "source.pdf"));
        if (pdf.length > maxBytes) throw new Error("converted PDF exceeds the limit");
        const file = `.legalwork/epost/${randomUUID()}/Word document.pdf`;
        const target = await localPath(workspace, file);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, pdf, { flag: "wx", mode: 0o600 });
        return jsonResponse({ path: file });
      } catch { throw new ApiError(422, "epost_word_conversion_failed", "The Word document could not be converted to a PDF."); }
      finally { await rm(temp, { recursive: true, force: true }); }
    }
    if (input.action === "review") {
      const { files, workspaceId, ...draft } = input.draft;
      if (workspaceId !== workspace.id) throw new ApiError(403, "forbidden", "The draft belongs to another workspace.");
      for (const [id, item] of reviews) if (item.quote.expires <= Date.now()) reviews.delete(id);
      for (const [id, item] of reviews) if (item.letter.id === draft.id && item.accountPath === accountPath) reviews.delete(id);
      if (reviews.size >= 5) throw new ApiError(429, "epost_review_limit", "Finish an open mailing review before starting another.");
      const { pdf, sources } = await createPacket(workspace, files);
      const letter = { ...draft, pdf };
      const quote = rawQuote.parse(await platformResult(config, { action: "review", letter }));
      if (reviews.size >= 5) throw new ApiError(429, "epost_review_limit", "Finish an open mailing review before starting another.");
      const reviewId = randomUUID();
      reviews.set(reviewId, { workspaceId, accountPath, sources, letter, quote });
      const { proof: _proof, ...display } = quote;
      return jsonResponse({ ...display, reviewId });
    }
    const review = reviews.get(input.reviewId);
    if (!review || review.accountPath !== accountPath || review.workspaceId !== workspace.id || review.quote.expires <= Date.now())
      throw new ApiError(409, "epost_review_required", "Review the postal mail again before submitting it.");
    for (const { path, digest } of review.sources)
      if (hash(await fileBytes(workspace, path)) !== digest) throw new ApiError(409, "epost_file_changed", "A document changed. Review it again.");
    if (!await enabled(accountPath) || accountPath !== await statePath() || reviews.get(input.reviewId) !== review)
      throw new ApiError(409, "epost_review_required", "Review the postal mail again before submitting it.");
    reviews.delete(input.reviewId);
    return jsonResponse(epostReceipt.parse(await platformResult(config, { action: "submit", letter: review.letter, ...review.quote })));
  });
}
