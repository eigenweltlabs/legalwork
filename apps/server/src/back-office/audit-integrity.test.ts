import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BACK_OFFICE_AUDIT_GENESIS,
  canonicalBackOfficeAudit,
  type BackOfficeAuditHead,
  type BackOfficeAuditPayload,
} from "./schema.js";
import {
  newBackOfficeAuditKey,
  signBackOfficeAudit,
  verifyBackOfficeAuditChain,
  verifyBackOfficeAuditEntry,
  verifyBackOfficeAuditProof,
} from "./audit-integrity.js";

function fixture() {
  const keys = newBackOfficeAuditKey();
  const streamId = randomUUID();
  const root: BackOfficeAuditHead = {
    streamId,
    publicKey: keys.publicKey,
    sequence: 0,
    hash: BACK_OFFICE_AUDIT_GENESIS,
  };
  const payload = (sequence: number): BackOfficeAuditPayload => ({
    version: 1,
    streamId,
    sequence,
    eventId: randomUUID(),
    recordedAt: "2026-11-07T12:00:00.000Z",
    scope: "local",
    actor: {
      id: "lawyer-a",
      name: "Lawyer A",
      kind: "user",
      identitySource: "operating-system",
      deviceId: randomUUID(),
      agentId: null,
    },
    action: "record.update",
    entityType: "record",
    entityId: "matter-a",
    modelRevision: 2,
    before: { name: "Confidential client", status: "Open" },
    after: { name: "Confidential client", status: "Closed" },
  });
  const first = signBackOfficeAudit(payload(1), root.hash, keys);
  const second = signBackOfficeAudit(payload(2), first.proof.hash, keys);
  return { keys, root, payload, first, second };
}

test("canonical audit encoding is stable across nested object-key order and preserves array order", () => {
  expect(
    canonicalBackOfficeAudit({ z: [false, null, 1.5], a: { y: 2, x: "ä" } }),
  ).toBe(
    canonicalBackOfficeAudit({ a: { x: "ä", y: 2 }, z: [false, null, 1.5] }),
  );
  expect(canonicalBackOfficeAudit([1, 2])).not.toBe(
    canonicalBackOfficeAudit([2, 1]),
  );
});

test("a signed stream verifies and exposes content-free proofs for independent witnessing", () => {
  const { root, first, second } = fixture();
  expect(verifyBackOfficeAuditEntry(first)).toEqual(first);
  expect(verifyBackOfficeAuditProof(first.proof)).toEqual(first.proof);
  expect(verifyBackOfficeAuditChain([first, second], root)).toMatchObject({
    sequence: 2,
    hash: second.proof.hash,
  });
  expect(JSON.stringify(first.proof)).not.toContain("Confidential client");
  expect(JSON.stringify(first.proof)).not.toContain("lawyer-a");
});

test("changes to attribution, timestamps, model versions or record contents fail verification", () => {
  const { first } = fixture();
  const changed = [
    { ...first.payload, actor: { ...first.payload.actor, id: "other-lawyer" } },
    { ...first.payload, recordedAt: "2026-11-06T12:00:00.000Z" },
    { ...first.payload, modelRevision: 3 },
    { ...first.payload, after: { name: "Rewritten client" } },
    { ...first.payload, streamId: randomUUID() },
  ];
  for (const payload of changed)
    expect(() =>
      verifyBackOfficeAuditEntry({ payload, proof: first.proof }),
    ).toThrow();
  expect(() =>
    verifyBackOfficeAuditProof({ ...first.proof, hash: "a".repeat(64) }),
  ).toThrow();
});

test("deleting, reordering or duplicating journal entries fails verification", () => {
  const { first, second, root } = fixture();
  for (const entries of [
    [second],
    [second, first],
    [first, first],
    [first, second, second],
  ])
    expect(() => verifyBackOfficeAuditChain(entries, root)).toThrow();
});

test("an independently retained checkpoint detects restoring an older valid database", () => {
  const { first, second, root } = fixture();
  const checkpoint = verifyBackOfficeAuditChain([first, second], root);
  expect(() => verifyBackOfficeAuditChain([first], checkpoint)).toThrow(
    "truncated or replaced",
  );
  expect(() => verifyBackOfficeAuditChain([], checkpoint)).toThrow(
    "truncated or replaced",
  );
  expect(verifyBackOfficeAuditChain([first, second], checkpoint)).toEqual(
    checkpoint,
  );
});

test("a validly signed replacement stream cannot replace a history pinned to another key", () => {
  const { first, second, payload, root } = fixture();
  const otherKeys = newBackOfficeAuditKey();
  const replacement = signBackOfficeAudit(payload(1), root.hash, otherKeys);
  expect(verifyBackOfficeAuditEntry(replacement)).toEqual(replacement);
  expect(() => verifyBackOfficeAuditChain([replacement], root)).toThrow(
    "foreign entry",
  );
  const checkpoint = verifyBackOfficeAuditChain([first, second], root);
  const alteredFirst = signBackOfficeAudit(
    { ...first.payload, after: { status: "Altered" } },
    root.hash,
    otherKeys,
  );
  expect(() =>
    verifyBackOfficeAuditChain([alteredFirst], checkpoint),
  ).toThrow();
});

test("checkpoint verification permits only valid extensions of the retained history", () => {
  const { first, second, root } = fixture();
  const checkpoint = verifyBackOfficeAuditChain([first], root);
  expect(verifyBackOfficeAuditChain([first, second], checkpoint).sequence).toBe(
    2,
  );
  expect(() =>
    verifyBackOfficeAuditChain([first, second], {
      ...checkpoint,
      hash: "f".repeat(64),
    }),
  ).toThrow("truncated or replaced");
});

test("a replaced private key cannot produce an accepted entry under the pinned public identity", () => {
  const { keys, payload, root } = fixture();
  const replaced = newBackOfficeAuditKey();
  expect(() =>
    signBackOfficeAudit(payload(1), root.hash, {
      ...keys,
      privateKey: replaced.privateKey,
    }),
  ).toThrow("pinned identity");
  expect(() =>
    signBackOfficeAudit(payload(1), root.hash, {
      ...keys,
      publicKey: replaced.publicKey,
    }),
  ).toThrow("pinned identity");
});
