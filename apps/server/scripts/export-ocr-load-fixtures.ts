import { createCanvas } from "@napi-rs/canvas";
import { writeFile } from "node:fs/promises";

const [output] = process.argv.slice(2);
if (!output) throw new Error("Usage: bun apps/server/scripts/export-ocr-load-fixtures.ts /private/synthetic-pages.json");
const customers = [];
const words = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT", "GOLF", "HOTEL", "INDIA", "JULIET", "KILO", "LIMA", "MIKE", "NOVEMBER", "OSCAR", "PAPA", "QUEBEC", "ROMEO", "SIERRA", "TANGO"];
for (let customer = 0; customer < 20; customer++) {
  const pages = [];
  const count = customer === 0 ? 11 : 1 + 2 * (customer % 3);
  for (let page = 0; page < count; page++) {
    const marker = `MARKER ${words[customer]} ${words[page]}`;
    const canvas = createCanvas(1240, 1754), context = canvas.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, 1240, 1754); context.fillStyle = "black";
    context.font = "bold 38px Arial"; context.fillText("SYNTHETIC DOCUMENT", 75, 105);
    context.font = "bold 34px Arial"; context.fillText(marker, 75, 170);
    context.font = "28px Arial";
    const amount = 1000 + customer * 111 + page * 17;
    const lines = customer % 3 === 0 ? [
      "Generated test agreement. Contains no real customer information.",
      `Reference ${customer + 1}-${page + 1}. Term: ${12 + page} months.`,
      `The synthetic fee is EUR ${amount}. Payment is due within 14 days.`,
      "Either party may terminate with thirty days written notice.",
      `The effective date is 18 November 2026. Test schedule ${page + 1}.`,
    ] : customer % 3 === 1 ? [
      "Generated test invoice. Contains no real customer information.",
      `Invoice reference: TEST-${customer + 1}-${page + 1}`,
      "ITEM                         QUANTITY       EUR",
      `Synthetic service                 ${page + 1}          ${amount}`,
      `Synthetic processing              ${customer + 1}          ${amount + 50}`,
      `Total: EUR ${amount * 2 + 50}. Payable within 30 days.`,
    ] : [
      "Synthetisches Testschreiben. Keine echten Falldaten.",
      `Wir bestätigen den Eingang des Testdokuments ${customer + 1}-${page + 1}.`,
      `Der vorgeschlagene synthetische Betrag ist EUR ${amount}.`,
      "Dieses Beispiel enthält kein Anerkenntnis einer Haftung.",
      `Die Frist für diese Testantwort beträgt ${7 + page} Tage.`,
    ];
    lines.forEach((line, index) => context.fillText(line, 75, 280 + index * 65));
    context.fillText(`Synthetic source page ${page + 1}`, 75, 1600);
    pages.push({ file: (await canvas.encode("png")).toString("base64"), width: 1240, height: 1754, marker, expectedAmount: String(amount) });
  }
  customers.push({ customer: `synthetic-${customer + 1}`, pages });
}
await writeFile(output, JSON.stringify(customers), { mode: 0o600 });
console.log(JSON.stringify({ synthetic: true, customers: customers.length, pages: customers.reduce((sum, customer) => sum + customer.pages.length, 0) }));
