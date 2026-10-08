import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { MailProvider } from "@legalwork/types/mail-plugins";

const bundled = new URL("./registration.json", import.meta.url);
const registration = z.object({ gmail: z.object({ clientId: z.string().endsWith(".apps.googleusercontent.com"), clientSecret: z.string().min(1) }).optional() });
export const OUTLOOK_MAIL_CLIENT_ID = "f7ae407e-0e9f-442d-a7e5-60cf8740992a";
export type MailRegistration = { clientId: string; clientSecret?: string };

/** Release packaging supplies an installed-app client, never a confidential web client. */
export async function mailRegistration(provider: MailProvider): Promise<MailRegistration | null> {
  if (provider === "outlook") return { clientId: process.env.LEGALWORK_OUTLOOK_PLUGIN_CLIENT_ID?.trim() || OUTLOOK_MAIL_CLIENT_ID };
  const clientId = process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_ID?.trim();
  const clientSecret = process.env.LEGALWORK_GMAIL_PLUGIN_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  try { return registration.parse(JSON.parse(await readFile(bundled, "utf8"))).gmail ?? null; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new Error("The bundled Google sign-in registration is invalid.");
  }
}
