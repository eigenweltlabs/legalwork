import { timingSafeEqual, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateWrite, readJson, sha256 } from "./evidence.mjs";

// Stateless Streamable HTTP MCP. Loads source and transport only, never suite/rubric files.
export async function startLongMcpServer({ directory, traces = join(directory, "fixture-traces"), port = 39182 }) {
  const root = resolve(directory);
  const transport = await readJson(join(root, "transport.json"));
  const sourceBytes = await readFile(join(root, "source-response.json"));
  const source = JSON.parse(sourceBytes.toString("utf8"));
  const definition = await readJson(join(root, "tool-definition.json"));
  const token = Buffer.from(`Bearer ${transport.token}`);
  await mkdir(traces, { recursive: true, mode: 0o700 });
  const records = [];
  const inFlight = new Set();
  const server = createServer(async (request, response) => {
    let finishRequest;
    const pending = new Promise(accept => { finishRequest = accept; });
    inFlight.add(pending);
    try {
      const authorization = Buffer.from(request.headers.authorization ?? "");
      if (authorization.length !== token.length || !timingSafeEqual(authorization, token)) {
        response.writeHead(401, { "Content-Type": "application/json" }); response.end('{"error":"Fixture authentication required"}'); return;
      }
      if (new URL(request.url, "http://127.0.0.1").pathname !== "/mcp") { response.writeHead(404); response.end(); return; }
      if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
      if (request.method !== "POST") { response.writeHead(405, { Allow: "POST, DELETE" }); response.end(); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const received = Buffer.concat(chunks);
      const rpc = JSON.parse(received.toString("utf8"));
      if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") throw new Error("Invalid JSON-RPC request");
      const identity = randomUUID();
      await privateWrite(join(traces, `${identity}.request.json`), received);
      if (rpc.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      let error;
      if (rpc.method === "initialize") result = { protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "legalwork-synthetic-long-mcp", version: "1.0.0" } };
      else if (rpc.method === "ping") result = {};
      else if (rpc.method === "tools/list") result = { tools: [definition] };
      else if (rpc.method === "tools/call") {
        if (rpc.params?.name !== definition.name || rpc.params.arguments?.matter_id !== source.matter_id || Object.keys(rpc.params.arguments ?? {}).some(key => key !== "matter_id")) result = { isError: true, content: [{ type: "text", text: "Unknown tool or matter identifier" }] };
        else result = { content: [{ type: "text", text: sourceBytes.toString("utf8") }], structuredContent: source };
      } else error = { code: -32601, message: "Method not found" };
      const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...(error ? { error } : { result }) }));
      await privateWrite(join(traces, `${identity}.response.json`), bytes);
      const record = { id: identity, method: rpc.method, tool: rpc.params?.name ?? null, arguments: rpc.params?.arguments ?? null, sourceBytes: sourceBytes.length, sourceSha256: sha256(sourceBytes), responseBytes: bytes.length, responseSha256: sha256(bytes), isError: result?.isError === true || Boolean(error), finishedAt: null, deliveryCompleted: false };
      const delivered = response.destroyed ? Promise.resolve() : new Promise(accept => {
        response.once("finish", () => { record.finishedAt = new Date().toISOString(); record.deliveryCompleted = true; accept(); });
        response.once("close", accept);
      });
      records.push(record);
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(bytes);
      await delivered;
      await privateWrite(join(traces, `${identity}.receipt.json`), record);
    } catch {
      if (!response.headersSent) response.writeHead(400, { "Content-Type": "application/json" });
      response.end('{"error":"Malformed synthetic fixture request"}');
    } finally {
      finishRequest(); inFlight.delete(pending);
    }
  });
  // No fixture request/tool/output deadline or body-size cap is imposed.
  server.requestTimeout = 0; server.headersTimeout = 0; server.timeout = 0;
  await new Promise((accept, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", accept); });
  const address = server.address();
  return { url: `http://127.0.0.1:${address.port}/mcp`, records, sourceBytes: sourceBytes.length, sourceSha256: sha256(sourceBytes), close: async () => { await new Promise((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); }); await Promise.all(inFlight); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--fixture");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--fixture <controller-only-prepared-directory> is required");
  const tracesIndex = process.argv.indexOf("--traces");
  const server = await startLongMcpServer({ directory: process.argv[index + 1], ...(tracesIndex < 0 ? {} : { traces: process.argv[tracesIndex + 1] }) });
  console.log(JSON.stringify({ listening: server.url, sourceBytes: server.sourceBytes, sourceSha256: server.sourceSha256, inferenceCalls: 0 }));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await server.close(); });
}
