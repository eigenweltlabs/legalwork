import { open, stat } from "node:fs/promises";

// A valid PDF containing a large embedded file. Sparse payload bytes let us
// exercise the real 1 GiB boundary without allocating a 1 GiB test buffer.
export async function largePdf(path: string, size: number, largePageContent = false) {
  let payload = size - 10_000, prefix = "", suffix = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const content = "BT /F1 12 Tf 10 100 Td (Large source contract marker) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(large.bin) 8 0 R] >> >> >>",
      "<< /Type /Pages /Count 2 /Kids [3 0 R 7 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    prefix = "%PDF-1.7\n"; const offsets = [0];
    for (const [i, object] of objects.entries()) { offsets.push(prefix.length); prefix += `${i + 1} 0 obj\n${object}\nendobj\n`; }
    offsets.push(prefix.length); prefix += `6 0 obj\n<< /Type /EmbeddedFile /Length ${payload} >>\nstream\n`;
    suffix = "\nendstream\nendobj\n";
    offsets.push(prefix.length + payload + suffix.length);
    suffix += `7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> ${largePageContent ? "/Contents 6 0 R" : ""} >>\nendobj\n`;
    offsets.push(prefix.length + payload + suffix.length);
    suffix += "8 0 obj\n<< /Type /Filespec /F (large.bin) /EF << /F 6 0 R >> >>\nendobj\n";
    const xref = prefix.length + payload + suffix.length;
    suffix += `xref\n0 9\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const difference = size - (prefix.length + payload + suffix.length);
    if (!difference) break;
    payload += difference;
  }
  const handle = await open(path, "w");
  try { await handle.write(prefix, 0, "utf8"); await handle.write(suffix, prefix.length + payload, "utf8"); }
  finally { await handle.close(); }
  if ((await stat(path)).size !== size) throw new Error("Invalid large PDF fixture size");
}
