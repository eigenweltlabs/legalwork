import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consume, corpus, fixture } from "./corpus.js";
import type { SyntheticMessage } from "./corpus.js";
import { FaultInjector, InjectedFault } from "./faults.js";
import type { CheckpointEvent, FaultCode } from "./faults.js";
import expected from "./expected-manifest.json" with { type: "json" };

const text = (message: SyntheticMessage) => Buffer.concat([...message.chunks()]).toString("utf8");

describe("synthetic corpus", () => {
  test("default bytes and hashes match pinned manifest, including repeat reads", async () => {
    let index = 0;
    for (const message of corpus()) {
      expect(expected[index]).toEqual(await consume(message));
      expect(expected[index++]).toEqual(await consume(message));
    }
    expect(index).toBe(10);
  });
  test("preserves duplicate/missing RFC IDs, account namespaces and memberships", () => {
    const messages = [...corpus()];
    expect(messages[0]!.messageId).toBe(messages[1]!.messageId);
    expect(messages[0]!.messageId).toBe(messages[3]!.messageId);
    expect(messages[0]!.sourceId).toBe(messages[3]!.sourceId);
    expect(messages[0]!.accountId).not.toBe(messages[3]!.accountId);
    expect(new Set(messages.map(message => `${message.accountId}/${message.sourceId}`)).size).toBe(10);
    expect(messages[2]!.messageId).toBeNull();
    expect(text(messages[2]!)).not.toContain("Message-ID:");
    expect(messages[4]!.memberships).toEqual(["INBOX", "Label_Contracts", "Label_Urgent"]);
    expect(messages[5]!.memberships).toEqual(["Archive/2001/Mandate/Verträge"]);
    expect(text(messages[5]!)).toContain("Mon, 1 Jan 2001");
    expect(text(messages[6]!)).toContain("=?UTF-8?B?UHLDvGZ1bmcgZGVyIFZlcnRyw6RnZQ==?=");
    expect(text(messages[6]!)).toContain("Prüfung: Größe");
  });
  test("contains inline, embedded and attachment parts and deliberately malformed input", () => {
    const mime = text(fixture(7));
    expect(mime).toContain("Content-ID: <pixel@example.invalid>");
    expect(mime).toContain("Content-Type: message/rfc822");
    expect(mime).toContain("filename*=UTF-8''Pr%C3%BCfung.txt");
    const malformed = text(fixture(8));
    expect(malformed).toContain("!!! invalid base64 !!!");
    expect(malformed).not.toContain("--synthetic-boundary-8--");
  });
  test("100k descriptors are lazy and unique without accumulating raw messages", () => {
    let count = 0;
    for (const message of corpus(100_000, 1024)) {
      expect(message.sourceId).toBe(`message-${message.kind === "other-account" ? count - 3 : count}`);
      count++;
    }
    expect(count).toBe(100_000);
  });
  test("large attachment streams bounded chunks and decodes to the specified byte pattern", () => {
    const attachmentBytes = 64 * 1024 * 1024 + 13;
    const hash = createHash("sha256");
    let decodedBytes = 0;
    let wireBytes = 0;
    for (const chunk of fixture(9, attachmentBytes).chunks()) {
      expect(chunk.byteLength).toBeLessThanOrEqual(40 * 1024);
      wireBytes += chunk.byteLength;
      const value = Buffer.from(chunk).toString("ascii");
      if (value.includes(":") || value.startsWith("--")) continue;
      const decoded = Buffer.from(value, "base64");
      for (let index = 0; index < decoded.length; index++) {
        if (decoded[index] !== (decodedBytes + index) % 251) throw new Error("Generated attachment byte mismatch");
      }
      decodedBytes += decoded.length;
      hash.update(decoded);
    }
    expect(decodedBytes).toBe(attachmentBytes);
    expect(wireBytes).toBeGreaterThan(attachmentBytes);
    expect(hash.digest("hex")).toHaveLength(64);
  });
  test("consume awaits sink before advancing generator and propagates sink failure", async () => {
    let produced = 0;
    let writes = 0;
    const message = { ...fixture(0), *chunks() {
      for (let index = 0; index < 3; index++) {
        expect(writes).toBe(index);
        produced++;
        yield new Uint8Array([index]);
      }
    } };
    await expect(consume(message, async () => {
      await Promise.resolve();
      if (++writes === 2) throw new Error("disk full");
    })).rejects.toThrow("disk full");
    expect(produced).toBe(2);
  });
  test("CLI emits original MIME and matching JSONL into an external directory, refuses overwrite", async () => {
    const output = await mkdtemp(join(tmpdir(), "legalwork-mail-corpus-"));
    try {
      const command = [process.execPath, join(import.meta.dir, "generate.ts"), output, "10", "1024"];
      expect(await Bun.spawn(command, { stdout: "ignore", stderr: "pipe" }).exited).toBe(0);
      const lines = (await readFile(join(output, "manifest.jsonl"), "utf8")).trim().split("\n");
      expect(lines).toHaveLength(10);
      let index = 0;
      for (const message of corpus(10, 1024)) {
        const filename = `${message.accountId}-${message.sourceId}.eml`;
        const raw = await readFile(join(output, filename));
        expect(JSON.parse(lines[index++]!)).toEqual({ ...await consume(message), filename });
        expect(raw.equals(Buffer.concat([...message.chunks()]))).toBe(true);
      }
      const retry = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
      expect(await retry.exited).not.toBe(0);
      expect((await readFile(join(output, "manifest.jsonl"), "utf8")).trim().split("\n")).toHaveLength(10);
    } finally { await rm(output, { recursive: true, force: true }); }
  });
  test("rejects invalid sizes and counts", () => {
    expect(() => fixture(-1)).toThrow();
    expect(() => fixture(0, Infinity)).toThrow();
    expect(() => [...corpus(0.5)]).toThrow();
  });
});

describe("checkpoint fault harness (simulation, not provider certification)", () => {
  test("interrupted backfill replays durable content before checkpoint advancement", async () => {
    const events: CheckpointEvent[] = [];
    const faults = new FaultInjector([{ checkpoint: "cursor:before", occurrence: 1, code: "restart" }], event => events.push(event));
    const stored = new Map<string, string>();
    let cursor = 0;
    async function page() {
      faults.hit("page:before");
      for (let index = cursor; index < 3; index++) {
        const message = fixture(index);
        faults.hit("message:before");
        const manifest = await consume(message, async () => { faults.hit("chunk:before"); });
        stored.set(`${message.accountId}/${message.sourceId}`, manifest.sha256);
        faults.hit("content:durable");
        faults.hit("cursor:before");
        cursor = index + 1;
        faults.hit("cursor:durable");
      }
    }
    await expect(page()).rejects.toThrow(InjectedFault);
    expect(cursor).toBe(0);
    expect(stored.size).toBe(1);
    expect(events.at(-1)?.fault).toBe("restart");
    await page();
    expect(cursor).toBe(3);
    expect(stored.size).toBe(3); // Distinct duplicates and absent RFC ID survive.
    expect(events.filter(event => event.checkpoint === "content:durable")).toHaveLength(4);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });
  test("disk-full halts before durable content or cursor and retry succeeds", async () => {
    const events: CheckpointEvent[] = [];
    const faults = new FaultInjector([{ checkpoint: "chunk:before", occurrence: 2, code: "disk-full" }], event => events.push(event));
    async function attempt() {
      await consume(fixture(9, 1024), async () => { faults.hit("chunk:before"); });
      faults.hit("content:durable");
      faults.hit("cursor:durable");
    }
    await expect(attempt()).rejects.toThrow("disk-full");
    expect(events.every(event => event.checkpoint === "chunk:before")).toBe(true);
    await attempt();
    expect(events.at(-2)?.checkpoint).toBe("content:durable");
    expect(events.at(-1)?.checkpoint).toBe("cursor:durable");
  });
  test("uncertain submission exposes the accepted-before-recorded failure window", () => {
    const faults = new FaultInjector([{ checkpoint: "submit:accepted", occurrence: 1, code: "uncertain-submission" }]);
    let accepted = 0;
    let recorded = false;
    expect(() => {
      faults.hit("submit:before");
      accepted++;
      faults.hit("submit:accepted");
      recorded = true;
      faults.hit("submit:recorded");
    }).toThrow("uncertain-submission");
    expect(accepted).toBe(1);
    expect(recorded).toBe(false);
  });
  test("remote edit can deterministically change simulated state before a cursor commit", () => {
    let remoteRevision = 1;
    let persistedRevision = 0;
    const faults = new FaultInjector([{ checkpoint: "cursor:before", occurrence: 1, code: "remote-edit" }], event => {
      if (event.fault === "remote-edit") remoteRevision++;
    });
    function synchronize() {
      const fetchedRevision = remoteRevision;
      faults.hit("content:durable");
      faults.hit("cursor:before");
      persistedRevision = fetchedRevision;
      faults.hit("cursor:durable");
    }
    expect(synchronize).toThrow("remote-edit");
    expect(remoteRevision).toBe(2);
    expect(persistedRevision).toBe(0);
    synchronize();
    expect(persistedRevision).toBe(2);
  });
  test("network, throttle, cursor expiry and remote-edit faults replay in exact order", () => {
    const codes: FaultCode[] = ["network-loss", "throttled", "cursor-expired", "remote-edit"];
    const rules = codes.map((code, index) => ({ checkpoint: "page:before", occurrence: index + 1, code, retryAfterMs: 500 } satisfies import("./faults.js").FaultRule));
    const run = () => {
      const events: CheckpointEvent[] = [];
      const faults = new FaultInjector(rules, event => events.push(event));
      for (const code of codes) {
        try { faults.hit("page:before"); throw new Error("Missing fault"); }
        catch (error) {
          expect(error).toBeInstanceOf(InjectedFault);
          if (!(error instanceof InjectedFault)) throw error;
          expect(error.rule.code).toBe(code);
          expect(error.rule.retryAfterMs).toBe(500);
        }
      }
      faults.hit("page:before");
      return events;
    };
    expect(run()).toEqual(run());
    expect(() => new FaultInjector([rules[0]!, rules[0]!])).toThrow("Ambiguous");
    expect(() => new FaultInjector([{ checkpoint: "page:before", occurrence: 0, code: "restart" }])).toThrow();
  });
});
