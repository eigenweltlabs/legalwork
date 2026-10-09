import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AssistantPush, RegistrationSchema } from "./service.js";
import { providerToken, pushPayload, type PushEvent, type PushResult, type PushTransport } from "./apns.js";

const registration = RegistrationSchema.parse({ token: "a".repeat(64), environment: "sandbox", replies: true, approvals: true, sounds: true, previews: true, visibleTab: -1 });
const reply = (id: string, at: number): PushEvent => ({ id, at, title: "Assistant", body: "Your work is ready.", tab: 0, kind: "reply" });
async function fixture(run: (ctx: {
  push: AssistantPush; sent: PushEvent[]; setEvents: (events: PushEvent[]) => void;
  advance: (ms: number) => void; setResult: (result: PushResult) => void; revoke: () => void;
  reopen: () => Promise<AssistantPush>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-push-"));
  let now = 1_000_000; let events: PushEvent[] = []; let result = { status: 200 }; let active = true;
  const sent: PushEvent[] = [];
  const provider: PushTransport = { environment: "sandbox", send: async (_token, event) => { sent.push(event); return result; }, close: () => {} };
  const open = () => AssistantPush.open(join(directory, "runtime.sqlite"), async () => events, async () => active, { provider, now: () => now });
  try { await run({ push: await open(), sent, setEvents: value => { events = value; }, advance: ms => { now += ms; }, setResult: value => { result = value; }, revoke: () => { active = false; }, reopen: open }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

describe("Apple Push delivery", () => {
  test("ES256 token has Apple claims and a verifiable 64-byte JOSE signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwt = providerToken({ teamId: "ABCDEFGHIJ", keyId: "1234567890" }, privateKey, 1234567890000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "ES256", kid: "1234567890" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "ABCDEFGHIJ", iat: 1234567890 });
    expect(Buffer.from(signature, "base64url").length).toBe(64);
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))).toBe(true);
  });
  test("redacts previews, respects sound, and stays below Apple's payload size", () => {
    const event = { ...reply("id", 1), title: "Client secret", body: "🔒".repeat(2000) };
    const hidden = pushPayload(event, { ...registration, previews: false, sounds: false });
    expect(hidden.aps.alert).toEqual({ title: "LegalWork", body: "You have a new reply." });
    expect(hidden.aps).not.toHaveProperty("sound");
    expect(Buffer.byteLength(JSON.stringify(pushPayload(event, registration)))).toBeLessThan(4096);
  });
  test("baselines history and deduplicates delivery across a server restart", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", registration);
    ctx.setEvents([reply("old", 900_000), reply("new", 1_000_001)]);
    await ctx.push.tick(); await ctx.push.tick();
    await (await ctx.reopen()).tick();
    expect(ctx.sent.map(item => item.id)).toEqual(["new"]);
  }));
  test("foreground receipts don't replay after backgrounding; expired presence permits push", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", { ...registration, visibleTab: 0 });
    ctx.setEvents([reply("seen", 1_000_001)]); await ctx.push.tick();
    ctx.advance(50_000); ctx.setEvents([reply("seen", 1_000_001), reply("away", 1_050_000)]);
    await ctx.push.tick(); expect(ctx.sent.map(item => item.id)).toEqual(["away"]);
  }));
  test("disabled categories are consumed and do not replay when enabled", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", { ...registration, replies: false });
    ctx.setEvents([reply("muted", 1_000_001)]); await ctx.push.tick();
    ctx.push.register("phone", "owner", registration); await ctx.push.tick();
    expect(ctx.sent).toHaveLength(0);
  }));
  test("rejects cross-account mutations and wrong APNs environment", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", registration);
    expect(() => ctx.push.register("phone", "intruder", registration)).toThrow();
    expect(() => ctx.push.remove("phone", "intruder")).toThrow();
    expect(() => ctx.push.test("phone", "intruder", 45)).toThrow();
    expect(() => ctx.push.register("other", "owner", { ...registration, environment: "production" })).toThrow();
  }));
  test("revocation and logout stop delivery", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", registration); ctx.revoke();
    ctx.setEvents([reply("new", 1_000_001)]); await ctx.push.tick();
    expect(ctx.sent).toHaveLength(0);
    expect(() => ctx.push.test("phone", "owner", 45)).toThrow();
  }));
  test("retry survives restart, honors backoff, and expires after an hour", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", registration); ctx.setResult({ status: 503 });
    ctx.setEvents([reply("new", 1_000_001)]); await ctx.push.tick(); await ctx.push.tick();
    expect(ctx.sent).toHaveLength(1);
    ctx.advance(31_000); const restarted = await ctx.reopen(); await restarted.tick();
    expect(ctx.sent).toHaveLength(2);
    ctx.advance(3600_000); await restarted.tick(); expect(ctx.sent).toHaveLength(2);
  }));
  test("Apple's invalid-token response removes the device instead of retrying forever", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", registration); ctx.setResult({ status: 410, reason: "Unregistered" });
    ctx.setEvents([reply("new", 1_000_001)]); await ctx.push.tick();
    expect(() => ctx.push.test("phone", "owner", 45)).toThrow();
    ctx.advance(60_000); await ctx.push.tick(); expect(ctx.sent).toHaveLength(1);
  }));
  test("test pushes are delayed past the app background window and rate limited", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", registration); ctx.push.test("phone", "owner", 45);
    expect(() => ctx.push.test("phone", "owner", 45)).toThrow();
    await ctx.push.tick(); ctx.advance(44_000); await ctx.push.tick(); expect(ctx.sent).toHaveLength(0);
    ctx.advance(2_000); await ctx.push.tick(); expect(ctx.sent[0]?.kind).toBe("test");
  }));
  test("answered approvals are not delivered later by the retry queue", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", registration); ctx.setResult({ status: 503 });
    ctx.setEvents([{ ...reply("approval", 1_000_001), tab: 1, kind: "approval" }]);
    await ctx.push.tick(); expect(ctx.sent).toHaveLength(1);
    ctx.setEvents([]); ctx.setResult({ status: 200 }); ctx.advance(31_000);
    await ctx.push.tick(); expect(ctx.sent).toHaveLength(1);
  }));
  test("rotating the device token does not duplicate already delivered replies", () => fixture(async ctx => {
    ctx.push.register("phone", "owner", registration); ctx.setEvents([reply("new", 1_000_001)]); await ctx.push.tick();
    ctx.push.register("phone", "owner", { ...registration, token: "b".repeat(64) }); await ctx.push.tick();
    expect(ctx.sent).toHaveLength(1);
  }));
});
