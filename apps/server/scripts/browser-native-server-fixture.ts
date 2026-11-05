import { readFile } from "node:fs/promises";
import { startServer } from "../src/server.js";
import type { ServerConfig } from "../src/types.js";
import { TokenService } from "../src/tokens.js";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// A separate, real LegalWork server process for the zero-inference Electron contract fixture.
const config: ServerConfig = JSON.parse(await readFile(process.argv[2], "utf8"));
const tokens = new TokenService(config);
await writeFile(join(dirname(config.configPath), "browser-test-actors.json"), JSON.stringify({ viewer: (await tokens.create("viewer")).token, other: (await tokens.create("collaborator")).token }), { mode: 0o600 });
const server = await startServer(config);
console.log(`BROWSER_FIXTURE_SERVER=http://127.0.0.1:${server.port}`);
let closing = false;
async function close() { if (closing) return; closing = true; await server.stop(); process.exit(0); }
process.on("SIGTERM", () => void close()); process.on("SIGINT", () => void close());
