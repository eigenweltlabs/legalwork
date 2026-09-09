import { prepareMailStore } from "../storage/maintenance.js";
const maximum = 32768; let bytes = 0; const chunks: Buffer[] = [];
process.stdin.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maximum) process.exit(1); chunks.push(chunk); });
process.stdin.on("end", async () => {
  let sourceKey: Buffer | undefined, destinationKey: Buffer | undefined;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    for (const chunk of chunks) chunk.fill(0);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const input = Object.getOwnPropertyDescriptors(value);
    const text = (name: string) => { const found: unknown = input[name]?.value; if (typeof found !== "string") throw new Error(); return found; };
    if (Object.keys(input).sort().join(",") !== "destinationKey,destinationPath,expectedSha256,ownerId,restore,sourceKey,sourcePath" || typeof input.restore?.value !== "boolean") throw new Error();
    sourceKey = Buffer.from(text("sourceKey"), "base64"); destinationKey = Buffer.from(text("destinationKey"), "base64");
    if (sourceKey.toString("base64") !== text("sourceKey") || destinationKey.toString("base64") !== text("destinationKey")) throw new Error();
    const result = await prepareMailStore({ sourcePath: text("sourcePath"), destinationPath: text("destinationPath"), ownerId: text("ownerId"), sourceKey, destinationKey, restore: input.restore.value, expectedSha256: input.expectedSha256?.value === null ? null : text("expectedSha256") });
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
  } catch { process.stdout.write('{"ok":false}\n'); process.exitCode = 1; }
  finally { sourceKey?.fill(0); destinationKey?.fill(0); for (const chunk of chunks) chunk.fill(0); }
});
