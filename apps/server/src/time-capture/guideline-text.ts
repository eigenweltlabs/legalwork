import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPdfText } from "../document-preparation/render.js";
import { ApiError } from "../errors.js";
import { receiveRequestFile } from "../file-upload.js";

const maximumBytes = 8 * 1024 * 1024;

export async function guidePdfText(request: Request) {
  const temp = await mkdtemp(join(tmpdir(), "legalwork-guideline-"));
  try {
    const path = join(temp, "source.pdf");
    await receiveRequestFile(request, path, maximumBytes);
    const bytes = await readFile(path);
    if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
      throw new ApiError(400, "guideline_pdf", "Choose a valid PDF.");
    const { pages } = await extractPdfText(bytes, request.signal);
    return {
      text: pages
        .map((page) => page.text.trim())
        .filter(Boolean)
        .join("\n\n"),
      textlessPages: pages
        .filter((page) => !page.text.trim())
        .map((page) => page.page),
    };
  } catch (error) {
    request.signal.throwIfAborted();
    if (error instanceof ApiError && error.status === 413)
      throw new ApiError(
        413,
        "guideline_size",
        "Guideline files must be at most 8 MiB.",
      );
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      "guideline_pdf",
      "The PDF could not be read. Check whether it is password-protected or damaged.",
    );
  } finally {
    await rm(temp, { force: true, recursive: true });
  }
}
