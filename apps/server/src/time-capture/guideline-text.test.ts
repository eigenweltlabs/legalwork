import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { guidePdfText } from "./guideline-text.js";

test("guideline PDF preview reads its text layer and identifies pages without searchable text", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Firm billing guidance");
  pdf.addPage();
  const file = await pdf.save();
  const request = new Request(
    "http://localhost/private-timesheet/workday?preview=guideline-pdf",
    {
      method: "POST",
      body: new Blob([new Uint8Array(file)]),
    },
  );
  expect(await guidePdfText(request)).toEqual({
    text: "Firm billing guidance",
    textlessPages: [2],
  });
});

test("guideline PDF preview rejects other formats", async () => {
  const request = new Request(
    "http://localhost/private-timesheet/workday?preview=guideline-pdf",
    {
      method: "POST",
      body: "not a PDF",
    },
  );
  await expect(guidePdfText(request)).rejects.toMatchObject({
    code: "guideline_pdf",
    status: 400,
  });
});
