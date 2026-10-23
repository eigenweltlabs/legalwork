import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, type ClientHttp2Session } from "node:http2";
import { z } from "zod";

export const APNsConfigSchema = z.object({
  teamId: z.string().regex(/^[A-Z0-9]{10}$/), keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  privateKeyPath: z.string().min(1), bundleId: z.string().min(1),
  environment: z.enum(["sandbox", "production"]),
});
export type APNsConfig = z.infer<typeof APNsConfigSchema>;
export type PushEvent = { id: string; at: number; title: string; body: string; tab: 0 | 1; kind: "reply" | "approval" | "test" };
export type PushPreferences = { replies: boolean; approvals: boolean; sounds: boolean; previews: boolean };
export type PushResult = { status: number; reason?: string };
export interface PushTransport {
  environment: "sandbox" | "production";
  send(token: string, event: PushEvent, preferences: PushPreferences): Promise<PushResult>;
  close(): void;
}

export function providerToken(config: Pick<APNsConfig, "teamId" | "keyId">, key: KeyObject, now: number) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({ iss: config.teamId, iat: Math.floor(now / 1000) })}`;
  return `${unsigned}.${sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}
export function pushPayload(event: PushEvent, preferences: PushPreferences) {
  return { aps: { alert: {
    title: event.kind === "test" || preferences.previews ? event.title.slice(0, 80) : "LegalWork",
    body: event.kind === "test" || preferences.previews ? event.body.slice(0, 240)
      : event.kind === "reply" ? "You have a new reply." : "Your review is needed.",
  }, "thread-id": event.tab === 1 ? "approvals" : "assistant", ...(preferences.sounds ? { sound: "default" } : {}) },
  tab: event.tab, eventId: event.id, kind: event.kind };
}

/** One HTTP/2 connection and one cached ES256 JWT per provider environment. */
export class APNsProvider implements PushTransport {
  readonly environment;
  private session?: ClientHttp2Session;
  private jwt = "";
  private signedAt = 0;
  constructor(private config: APNsConfig, private key: KeyObject) { this.environment = config.environment; }
  static async open(config: APNsConfig) {
    const key = createPrivateKey(await readFile(config.privateKeyPath));
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("APNs requires an ES256 private key.");
    return new APNsProvider(config, key);
  }
  async send(token: string, event: PushEvent, preferences: PushPreferences): Promise<PushResult> {
    if (!/^[a-f0-9]{32,512}$/.test(token)) throw new Error("Invalid APNs device token.");
    if (!this.session || this.session.closed || this.session.destroyed) {
      this.session = connect(this.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
      this.session.on("error", () => {}); // Each request receives its own failure below.
      const session = this.session;
      session.on("goaway", () => { session.close(); });
    }
    const now = Date.now();
    if (!this.jwt || now - this.signedAt > 50 * 60_000) {
      this.jwt = providerToken(this.config, this.key, now); this.signedAt = now;
    }
    const payload = JSON.stringify(pushPayload(event, preferences));
    if (Buffer.byteLength(payload) > 4096) throw new Error("APNs payload is too large.");
    return new Promise((resolve, reject) => {
      const request = this.session!.request({ ":method": "POST", ":path": `/3/device/${token}`,
        authorization: `bearer ${this.jwt}`, "apns-topic": this.config.bundleId, "apns-push-type": "alert",
        "apns-priority": "10", "apns-expiration": String(Math.floor(now / 1000) + 3600),
        "apns-collapse-id": createHash("sha256").update(event.id).digest("hex"), "content-type": "application/json" });
      let status = 0; let body = "";
      request.setEncoding("utf8");
      request.setTimeout(10_000, () => request.destroy(new Error("APNs request timed out.")));
      request.on("response", headers => { status = Number(headers[":status"]); });
      request.on("data", chunk => { if (body.length < 4096) body += chunk; });
      request.on("error", reject);
      request.on("end", () => {
        let reason: string | undefined;
        try { reason = z.object({ reason: z.string() }).parse(JSON.parse(body)).reason; } catch { /* Success has no response body. */ }
        if (reason === "ExpiredProviderToken") this.jwt = "";
        resolve({ status, reason });
      });
      request.end(payload);
    });
  }
  close() { this.session?.destroy(); this.session = undefined; }
}
