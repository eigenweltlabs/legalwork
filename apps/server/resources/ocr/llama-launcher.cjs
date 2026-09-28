// Runs llama-server for as long as the host keeps stdin open. When the host exits, even abruptly,
// stdin closes and the server stops with it, so the model never stays loaded without its owner.
const { spawn } = require("node:child_process");

const [server, ...args] = process.argv.slice(2);
const child = spawn(server, args, { stdio: "ignore" });
const stop = () => { child.kill("SIGKILL"); process.exit(0); };
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.on("SIGTERM", stop);
process.stdin.resume();
child.on("exit", code => process.exit(code ?? 1));
child.on("error", () => process.exit(3));
