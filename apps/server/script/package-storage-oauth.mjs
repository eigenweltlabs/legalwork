import { writeFile } from "node:fs/promises";
// Google installed-app credentials are distributed with native clients. PKCE and
// user consent protect the grant. Never put a confidential web-client secret here.
const clientId = "136608658095-d8i26ibhugktcuo1f9i9qrckva2cbi10.apps.googleusercontent.com";
const clientSecret = process.env.LEGALWORK_STORAGE_GOOGLE_CLIENT_SECRET ?? "";
await writeFile(new URL("../dist/file-storage/oauth/google-client.js", import.meta.url),
  `export const googleDesktopClientId = ${JSON.stringify(clientId)};\nexport const googleDesktopClientSecret = ${JSON.stringify(clientSecret)};\n`);
