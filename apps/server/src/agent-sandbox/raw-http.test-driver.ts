import { rawHttpInputSchema, rawHttpRequest } from "./raw-http.js";
import { createNodeRawHttpTransport } from "./raw-http-node.js";
import { setDefaultResultOrder } from "node:dns";

// Isolated Node/Bun transport fixture. No production environment or HTTP route selects it.
setDefaultResultOrder("ipv6first");
const input = rawHttpInputSchema.parse(JSON.parse(process.argv[2]));
const controller = new AbortController();
process.stdin.on("data", () => controller.abort(new Error("Fixture Stop")));
const transport = process.argv[3] ? createNodeRawHttpTransport(() => process.argv[3]) : undefined;
try {
  const result = await rawHttpRequest(input, async () => true, controller.signal, { allowPrivate: true, ...(transport ? { send: transport.send } : {}) });
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
} finally { await transport?.close(); process.stdin.destroy(); }
