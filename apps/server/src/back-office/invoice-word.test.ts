import { extractPdfText } from "../document-preparation/render.js";
import { expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  starterInvoiceWord,
  standardInvoice,
} from "@legalwork/types/invoice-template";
import {
  convertInvoicePdf,
  renderWordInvoice,
  validateWordTemplate,
  type InvoiceOutput,
} from "./invoice-word.js";

const invoice: InvoiceOutput = {
  template: standardInvoice,
  date: "2026-11-20",
  client: "A & B",
  clientAddress: "Teststraße 1",
  number: 438,
  currency: "EUR",
  hourly: true,
  showHours: true,
  totalMinor: 3500,
  lines: [
    {
      date: "2026-11-19",
      narrative: "Drafting <revision>",
      workedMinutes: 12,
      billableMinutes: 18,
      amountMinor: 1800,
    },
    {
      date: "2026-11-20",
      narrative: "Amending {{ total }}",
      workedMinutes: 9,
      billableMinutes: 12,
      amountMinor: 1700,
    },
  ],
};
function edit(change: (text: string) => string) {
  const parts = unzipSync(Buffer.from(starterInvoiceWord, "base64"));
  parts["word/document.xml"] = strToU8(
    change(strFromU8(parts["word/document.xml"])),
  );
  return {
    ...standardInvoice,
    word: {
      name: "Custom.docx",
      contentBase64: Buffer.from(zipSync(parts)).toString("base64"),
    },
  };
}
const xml = (data: Uint8Array) =>
  strFromU8(unzipSync(data)["word/document.xml"]);
test("split Word runs, exact approved amounts, repeated table rows and literal client text", () => {
  const template = edit((text) =>
    text.replace(
      "{{ client_name }}",
      "{{ cli</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ent_name }}",
    ),
  );
  const output = xml(renderWordInvoice({ ...invoice, template }));
  for (const text of [
    "438",
    "2026-11-20",
    "A &amp; B",
    "Teststraße 1",
    "Drafting &lt;revision&gt;",
    "Amending {{ total }}",
    "18.00",
    "17.00",
    "35.00",
    "0.2 h recorded",
    "0.3 h billable",
  ])
    expect(output).toContain(text);
  expect(output.match(/<w:tr>/g)?.length).toBe(4);
  const fixed = xml(
    renderWordInvoice({ ...invoice, hourly: false, showHours: false }),
  );
  expect(fixed).not.toMatch(/h recorded|h billable/);
  expect(
    xml(renderWordInvoice({ ...invoice, hourly: false, showHours: true })),
  ).toContain("0.2 h recorded");
});
test("reject missing required fields and expressions outside the supported Jinja2 vocabulary", () => {
  for (const [from, to] of [
    ["client_address", "other"],
    ["{{ invoice_number }}", "123"],
    ["{% endfor %}", ""],
    ["{{ title }}", "{{ caller() }}"],
  ]) {
    expect(() =>
      validateWordTemplate(edit((text) => text.replace(from, to))),
    ).toThrow();
  }
});
test.skipIf(!process.env.LEGALWORK_TEST_LIBREOFFICE)(
  "convert the populated Word bytes with the installed office renderer",
  async () => {
    const pdf = await convertInvoicePdf(renderWordInvoice(invoice));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
    const { pages } = await extractPdfText(pdf, AbortSignal.timeout(10_000));
    const text = pages.map((page) => page.text).join(" ");
    for (const expected of [
      "438",
      "A & B",
      "Teststraße 1",
      "Drafting <revision>",
      "Amending {{ total }}",
      "18.00",
      "17.00",
      "35.00",
    ])
      expect(text).toContain(expected);
  },
  90_000,
);
