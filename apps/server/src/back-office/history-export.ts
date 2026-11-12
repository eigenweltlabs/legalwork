import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  BackOfficeHistoryExportBodySchema,
  BackOfficeHistoryExportSchema,
  BackOfficeStoredRecordSchema,
  backOfficeHistoryDisplayMatchesPayload,
  canonicalBackOfficeAudit,
  type BackOfficeAuditHead,
  type BackOfficeHistoryExportBody,
} from "./schema.js";
import {
  verifyBackOfficeAuditEntry,
  verifyBackOfficeAuditProofChain,
  backOfficeAuditScopeKey,
} from "./audit-integrity.js";

const bytes = (body: BackOfficeHistoryExportBody) =>
  Buffer.from(
    canonicalBackOfficeAudit({
      domain: "LegalWork.BackOffice.HistoryExport.v2",
      body,
    }),
  );

export function signBackOfficeHistoryExport(
  raw: BackOfficeHistoryExportBody,
  identity: { privateKey: string; publicKey: string },
) {
  const body = BackOfficeHistoryExportBodySchema.parse(raw);
  const key = createPrivateKey({
    key: Buffer.from(identity.privateKey, "base64"),
    type: "pkcs8",
    format: "der",
  });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    createPublicKey(key)
      .export({ type: "spki", format: "der" })
      .toString("base64") !== identity.publicKey
  )
    throw new Error(
      "History export signing identity does not match its pinned key.",
    );
  return BackOfficeHistoryExportSchema.parse({
    body,
    publicKey: identity.publicKey,
    signature: sign(null, bytes(body), key).toString("base64"),
  });
}

/** Without externally retained trusted heads this proves self-consistency,
 * not independent acknowledgement or protection against whole-state rollback. */
export function verifyBackOfficeHistoryExport(
  raw: unknown,
  trustedHeads: readonly BackOfficeAuditHead[] = [],
) {
  const exported = BackOfficeHistoryExportSchema.parse(raw),
    { body } = exported;
  if (body.proofs.some(proof => proof.scopeKey !== backOfficeAuditScopeKey(body.scope)))
    throw new Error("History export contains proofs from a different directory.");
  const key = createPublicKey({
    key: Buffer.from(exported.publicKey, "base64"),
    type: "spki",
    format: "der",
  });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !verify(null, bytes(body), key, Buffer.from(exported.signature, "base64"))
  )
    throw new Error("History export signature is invalid.");
  if (
    new Set(body.heads.map((head) => head.streamId)).size !== body.heads.length
  )
    throw new Error("History export repeats a stream identity.");
  if (
    trustedHeads.some(
      (trusted) =>
        !body.heads.some((head) => head.streamId === trusted.streamId),
    )
  )
    throw new Error("History export omits a trusted stream.");
  const refs = new Map<string, BackOfficeHistoryExportBody["proofs"][number]>();
  const coverage = [];
  for (const head of body.heads) {
    if (head.publicKey !== exported.publicKey)
      throw new Error(
        "History export uses a different signing identity from its history.",
      );
    const trusted = trustedHeads.find(
      (item) => item.streamId === head.streamId,
    );
    const proofs = body.proofs.filter(
      (proof) => proof.streamId === head.streamId,
    );
    const actual = verifyBackOfficeAuditProofChain(
      proofs,
      trusted ?? { ...head, sequence: 0, hash: "0".repeat(64) },
    );
    if (canonicalBackOfficeAudit(actual) !== canonicalBackOfficeAudit(head))
      throw new Error("History export head differs from its proof chain.");
    for (const proof of proofs)
      refs.set(`${proof.streamId}:${proof.sequence}`, proof);
    coverage.push({
      streamId: head.streamId,
      trustedThrough: trusted?.sequence ?? 0,
      exportedThrough: head.sequence,
    });
  }
  if (
    body.proofs.some(
      (proof) => !body.heads.some((head) => head.streamId === proof.streamId),
    )
  )
    throw new Error("History export contains an unlisted stream.");
  const disclosed = new Set<string>();
  for (const item of body.items) {
    const ref = `${item.proof.streamId}:${item.proof.sequence}`;
    const proof = refs.get(ref);
    if (
      !proof ||
      canonicalBackOfficeAudit(proof) !==
        canonicalBackOfficeAudit(item.proof) ||
      disclosed.has(ref)
    )
      throw new Error("History export contains a duplicate or unrelated item.");
    if (item.entityType !== body.target.type)
      throw new Error(
        "History export contains an item of a different target type.",
      );
    if (item.entityId !== body.target.id) {
      const related = [item.before, item.after].some((value) => {
        const record = BackOfficeStoredRecordSchema.safeParse(value);
        return (
          record.success &&
          record.data.objectId === "projectLinks" &&
          record.data.values.matter === body.target.id
        );
      });
      if (body.target.type !== "record" || !related)
        throw new Error(
          "History export contains an item for a different target.",
        );
    }
    disclosed.add(ref);
    if (item.payload) {
      if (
        item.payload.scope !== body.scope ||
        !backOfficeHistoryDisplayMatchesPayload(item)
      )
        throw new Error(
          "History export display differs from its disclosed signed payload.",
        );
      verifyBackOfficeAuditEntry({ proof: item.proof, payload: item.payload });
    } else if (!item.redacted)
      throw new Error("A withheld payload must be marked as redacted.");
  }
  const payloadsVerified = body.items.filter(
    (item) => item.payload !== null,
  ).length;
  if (body.withheldPayloads !== body.proofs.length - payloadsVerified)
    throw new Error("History export disclosure count is inconsistent.");
  return {
    signatureValid: true,
    chainsValid: true,
    payloadsVerified,
    payloadsWithheld: body.withheldPayloads,
    fullyAnchored:
      coverage.length > 0 &&
      coverage.every((item) => item.trustedThrough === item.exportedThrough),
    coverage,
  };
}
