import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DOMParser, XMLSerializer, type Element } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  formatInvoiceHours,
  formatInvoiceMinor,
  starterInvoiceWord,
  type InvoiceTemplate,
} from "./timesheet-schema.js";
import { ApiError } from "../errors.js";

const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const invoiceWordMime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type InvoiceOutput = {
  template: InvoiceTemplate;
  date: string;
  number?: number;
  client: string;
  clientAddress: string;
  currency: string;
  hourly: boolean;
  showHours: boolean;
  totalMinor: number;
  lines: {
    date: string;
    narrative: string;
    workedMinutes: number;
    billableMinutes: number;
    amountMinor: number;
  }[];
};
function invalid(message: string): never {
  throw new ApiError(422, "invoice_template_invalid", message);
}
const expr =
  /{{\s*([a-z_]+(?:\.[a-z_]+)?)\s*}}|{%\s*(for\s+line\s+in\s+lines|endfor)\s*%}/g;
const all = (el: Element, name: string) =>
  Array.from(el.getElementsByTagNameNS(w, name));
function fillParagraph(
  paragraph: Element,
  values: Record<string, string>,
  used: Set<string>,
) {
  const nodes = all(paragraph, "t");
  const runs = nodes.map((node) => node.textContent ?? "");
  const joined = runs.join("");
  const tokens = [...joined.matchAll(expr)];
  if (/{{|}}|{%|%}/.test(joined.replace(expr, "")))
    invalid("Unsupported or incomplete invoice template expression.");
  const offsets: number[] = [];
  let offset = 0;
  for (const run of runs) {
    offsets.push(offset);
    offset += run.length;
  }
  for (const match of tokens.reverse()) {
    const field = match[1];
    if (field && !Object.hasOwn(values, field))
      invalid("Unknown or misplaced invoice template field: " + field);
    if (field) used.add(field);
    const first = match.index!,
      end = first + match[0].length;
    for (let i = runs.length - 1; i >= 0; i--) {
      const left = Math.max(0, first - offsets[i]),
        right = Math.min(nodes[i].textContent?.length ?? 0, end - offsets[i]);
      if (right <= left) continue;
      runs[i] =
        runs[i].slice(0, left) +
        (offsets[i] <= first && field ? values[field] : "") +
        runs[i].slice(right);
    }
  }
  nodes.forEach((node, index) => {
    if (node.textContent !== runs[index]) {
      const [first, ...more] = runs[index].split(/\r?\n/);
      node.textContent = first;
      node.setAttribute("xml:space", "preserve");
      const parent = node.parentNode!,
        next = node.nextSibling;
      for (const text of more) {
        const line = node.cloneNode(false) as Element;
        line.textContent = text;
        parent.insertBefore(
          node.ownerDocument!.createElementNS(w, "w:br"),
          next,
        );
        parent.insertBefore(line, next);
      }
    }
  });
}
export function renderWordInvoice(input: InvoiceOutput) {
  const data = Buffer.from(
    input.template.word?.contentBase64 ?? starterInvoiceWord,
    "base64",
  );
  let expanded = 0,
    count = 0;
  const parts = unzipSync(data, {
    filter: (entry) => {
      expanded += entry.originalSize;
      if (
        ++count > 1000 ||
        expanded > 24 * 1024 * 1024 ||
        entry.name.split(/[\\/]/).includes("..") ||
        /(^\/|[\\:]|vbaProject|embeddings\/|activeX\/|externalLinks\/|customUI\/)/i.test(
          entry.name,
        )
      )
        invalid(
          "Use a static DOCX under 1 MB without macros or embedded files.",
        );
      return true;
    },
  });
  if (!parts["word/document.xml"] || !parts["[Content_Types].xml"])
    invalid("Choose a Word DOCX template.");
  const de = input.template.locale === "de-AT";
  const money = (minor: number) =>
    formatInvoiceMinor(input.template.locale, input.currency, minor);
  const hours = (minutes: number) =>
    formatInvoiceHours(input.template.locale, minutes);
  const values: Record<string, string> = {
    invoice_number: input.number?.toString() ?? (de ? "Entwurf" : "Draft"),
    invoice_date: input.date,
    client_name: input.client,
    client_address: input.clientAddress,
    title: input.template.title,
    letterhead: input.template.letterhead,
    footer: input.template.footer,
    total: money(input.totalMinor),
    currency: input.currency,
    description_label: de ? "Leistung" : "Service",
    amount_label: de ? "Honorar" : "Fee",
    total_label: de ? "Summe" : "Total",
  };
  const used = new Set<string>();
  let repeats = 0;
  for (const [name, bytes] of Object.entries(parts)) {
    if (!/\.(xml|rels)$/i.test(name)) continue;
    const xml = strFromU8(bytes);
    if (
      /<!DOCTYPE|<!ENTITY|TargetMode\s*=\s*["']External|macroEnabled|vbaProject|<\w+:altChunk\b|<\w+:instrText\b|<\w+:fldSimple\b/i.test(
        xml,
      )
    )
      invalid(
        "Remove external references, automatic fields and embedded content from the template.",
      );
    if (!/^word\/(document|header\d+|footer\d+)\.xml$/.test(name)) continue;
    const doc = new DOMParser({
      onError: (severity) => {
        if (severity !== "warning") invalid("Invalid Word XML.");
      },
    }).parseFromString(xml, "application/xml");
    const root = doc.documentElement!;
    const outside = new Set(all(root, "p"));
    for (const row of all(root, "tr")) {
      const paragraphs = all(row, "p");
      const text = paragraphs
        .map((p) =>
          all(p, "t")
            .map((n) => n.textContent)
            .join(""),
        )
        .join("\n");
      if (!/{%/.test(text)) continue;
      if (
        !/{%\s*for\s+line\s+in\s+lines\s*%}/.test(text) ||
        !/{%\s*endfor\s*%}/.test(text) ||
        text.match(/{%/g)?.length !== 2 ||
        !/\{\{\s*line\.description\s*}}/.test(text) ||
        !/\{\{\s*line\.amount\s*}}/.test(text)
      )
        invalid(
          "Put the lines loop, line.description and line.amount in one repeating table row.",
        );
      repeats++;
      paragraphs.forEach((p) => outside.delete(p));
      for (const line of input.lines) {
        const copy = row.cloneNode(true) as Element;
        const actual = input.showHours ? hours(line.workedMinutes) : "",
          billable = input.hourly ? hours(line.billableMinutes) : "";
        const labels = [
          actual && actual + " h " + (de ? "erfasst" : "recorded"),
          billable && billable + " h " + (de ? "verrechenbar" : "billable"),
        ].filter(Boolean);
        const fields = {
          ...values,
          "line.date": line.date,
          "line.description": line.narrative,
          "line.hours": actual,
          "line.billable_hours": billable,
          "line.hours_label": labels.length ? " · " + labels.join(" · ") : "",
          "line.amount": money(line.amountMinor),
        };
        for (const p of all(copy, "p")) fillParagraph(p, fields, used);
        row.parentNode!.insertBefore(copy, row);
      }
      row.parentNode!.removeChild(row);
    }
    for (const p of outside) {
      if (
        /{%/.test(
          all(p, "t")
            .map((n) => n.textContent)
            .join(""),
        )
      )
        invalid("Use the lines loop only inside a Word table row.");
      fillParagraph(p, values, used);
    }
    parts[name] = strToU8(new XMLSerializer().serializeToString(doc));
  }
  for (const required of [
    "invoice_number",
    "invoice_date",
    "client_name",
    "client_address",
    "total",
  ])
    if (!used.has(required)) invalid("Missing required field: " + required);
  if (
    (input.showHours || input.hourly) &&
    !used.has("line.hours_label") &&
    (!used.has("line.hours") ||
      (input.hourly && !used.has("line.billable_hours")))
  )
    invalid(
      "Include line.hours_label or the appropriate line.hours and line.billable_hours fields for the selected mode.",
    );
  if (repeats !== 1)
    invalid("The Word template needs one repeating service row.");
  return Buffer.from(zipSync(parts));
}
export function validateWordTemplate(template: InvoiceTemplate) {
  try {
    return renderWordInvoice({
      template,
      date: "2026-01-01",
      client: "Example",
      clientAddress: "Example address",
      currency: "EUR",
      hourly: true,
      showHours: true,
      totalMinor: 100,
      lines: [
        {
          date: "2026-01-01",
          narrative: "Example service",
          workedMinutes: 6,
          billableMinutes: 6,
          amountMinor: 100,
        },
      ],
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalid("The file could not be read as a Word DOCX template.");
  }
}
export async function convertInvoicePdf(docx: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-invoice-"));
  try {
    const source = join(dir, "Invoice.docx");
    await writeFile(source, docx, { mode: 0o600 });
    const commands = process.env.LEGALWORK_LIBREOFFICE_BINARY
      ? [process.env.LEGALWORK_LIBREOFFICE_BINARY]
      : [
          "soffice",
          ...(process.platform === "darwin"
            ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
            : process.platform === "win32"
              ? [
                  join(
                    process.env.ProgramFiles ?? "C:\\Program Files",
                    "LibreOffice",
                    "program",
                    "soffice.exe",
                  ),
                ]
              : []),
        ];
    for (const command of commands) {
      try {
        await promisify(execFile)(
          command,
          [
            "-env:UserInstallation=" + pathToFileURL(join(dir, "profile")).href,
            "--headless",
            "--convert-to",
            "pdf:writer_pdf_Export",
            "--outdir",
            dir,
            source,
          ],
          { timeout: 60_000, maxBuffer: 64 * 1024 },
        );
        const pdf = await readFile(join(dir, "Invoice.pdf"));
        if (pdf.subarray(0, 5).toString() !== "%PDF-")
          throw new Error("Invalid PDF");
        return pdf;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") break;
      }
    }
    throw new ApiError(
      503,
      "invoice_pdf_unavailable",
      "PDF conversion needs a working LibreOffice installation. Retry the same invoice when the converter is available.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
