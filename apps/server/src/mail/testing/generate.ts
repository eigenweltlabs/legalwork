import { mkdir, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { consume, corpus } from "./corpus.js";

// Explicit destination; exclusive creation prevents accidental overwrite on reruns.
if (import.meta.main) {
  const [destination, countArgument = "10", bytesArgument = "8388608"] = process.argv.slice(2);
  if (!destination) throw new Error("Usage: bun generate.ts OUTPUT_DIR [COUNT=10] [LARGE_ATTACHMENT_BYTES=8388608]");
  const count = Number(countArgument);
  const bytes = Number(bytesArgument);
  if (![count, bytes].every(value => Number.isSafeInteger(value) && value >= 0)) throw new RangeError("Count and bytes must be nonnegative safe integers");
  const output = resolve(destination);
  await mkdir(output, { recursive: true });
  const manifest = await open(join(output, "manifest.jsonl"), "wx");
  try {
    for (const message of corpus(count, bytes)) {
      const filename = `${message.accountId}-${message.sourceId}.eml`;
      const file = await open(join(output, filename), "wx");
      try {
        const entry = await consume(message, async chunk => { await file.writeFile(chunk); });
        await file.sync();
        await manifest.writeFile(JSON.stringify({ ...entry, filename }) + "\n");
      } finally { await file.close(); }
    }
    await manifest.sync();
  } finally { await manifest.close(); }
}
