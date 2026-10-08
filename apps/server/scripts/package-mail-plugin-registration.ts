import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { z } from "zod";

const native = z.object({ installed: z.object({ client_id: z.string().endsWith(".apps.googleusercontent.com"), client_secret: z.string().min(1) }) });
const target = new URL("../dist/mail-plugins/registration.json", import.meta.url);
const path = process.env.LEGALWORK_GMAIL_PLUGIN_DESKTOP_CONFIG;
let clientId = process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_ID?.trim();
let clientSecret = process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_SECRET?.trim();
if (path) {
  const value = native.parse(JSON.parse(await readFile(path, "utf8")));
  clientId = value.installed.client_id; clientSecret = value.installed.client_secret;
}
if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error("The Gmail release registration requires both installed-app client fields.");
if (clientId && clientSecret) {
  if (!clientId.endsWith(".apps.googleusercontent.com")) throw new Error("Invalid installed-app Gmail client ID.");
  await mkdir(new URL("../dist/mail-plugins/", import.meta.url), { recursive: true });
  // Google's installed-app client secret is non-confidential. Never supply a web
  // client secret, user access token or refresh token to this packaging step.
  await writeFile(target, JSON.stringify({ gmail: { clientId, clientSecret } }), { mode: 0o600 });
  console.log("Bundled the installed-app Gmail sign-in registration.");
} else {
  await rm(target, { force: true });
  console.log("Gmail release registration is absent; Gmail sign-in stays unavailable.");
}
