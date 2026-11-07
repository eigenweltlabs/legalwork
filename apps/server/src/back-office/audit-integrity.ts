import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  BACK_OFFICE_AUDIT_GENESIS,
  BACK_OFFICE_AUDIT_EMPTY_STATE,
  BackOfficeAuditEntrySchema,
  BackOfficeAuditPayloadSchema,
  BackOfficeAuditProofSchema,
  canonicalBackOfficeAudit,
  type BackOfficeAuditEntry,
  type BackOfficeAuditHead,
  type BackOfficeAuditPayload,
  type BackOfficeAuditProof,
} from "./schema.js";

const domain = "LegalWork.BackOffice.Audit.v2";
export function newBackOfficeAuditKey() {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKey: keys.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64"),
    publicKey: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
  };
}
export const backOfficeAuditDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hash = backOfficeAuditDigest;
export const newBackOfficeAuditNonce = () => randomBytes(32).toString("hex");
export function backOfficeAuditStateHash(
  value: BackOfficeAuditPayload["after"],
  nonce: string | null,
) {
  if (value === null && nonce === null) return BACK_OFFICE_AUDIT_EMPTY_STATE;
  if (value === null || !nonce || !/^[a-f0-9]{64}$/.test(nonce))
    throw new Error("A nonempty audit state requires a private random nonce.");
  return hash(canonicalBackOfficeAudit({ domain: `${domain}.State`, nonce, value }));
}
const payloadHash = (payload: BackOfficeAuditPayload) =>
  hash(canonicalBackOfficeAudit({ domain: `${domain}.Payload`, payload }));
export const backOfficeAuditEntityKey = (
  scope: string,
  entityType: BackOfficeAuditPayload["entityType"],
  entityId: string,
) => hash(canonicalBackOfficeAudit({ scope, entityType, entityId }));
function proofBody(proof: BackOfficeAuditProof) {
  return {
    streamId: proof.streamId,
    sequence: proof.sequence,
    previousHash: proof.previousHash,
    payloadHash: proof.payloadHash,
    entityType: proof.entityType,
    entityKey: proof.entityKey,
    beforeHash: proof.beforeHash,
    afterHash: proof.afterHash,
  };
}
function proofHash(proof: ReturnType<typeof proofBody>) {
  return hash(canonicalBackOfficeAudit({ domain, ...proof }));
}
function signatureBody(proof: Omit<BackOfficeAuditProof, "signature">) {
  return Buffer.from(canonicalBackOfficeAudit({ domain, ...proof }));
}
export function signBackOfficeAudit(
  raw: BackOfficeAuditPayload,
  previousHash: string,
  keys: ReturnType<typeof newBackOfficeAuditKey>,
): BackOfficeAuditEntry {
  const privateKey = createPrivateKey({
    key: Buffer.from(keys.privateKey, "base64"),
    type: "pkcs8",
    format: "der",
  });
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64") !== keys.publicKey
  )
    throw new Error(
      "Back Office audit signing key does not match its pinned identity.",
    );
  const payload = BackOfficeAuditPayloadSchema.parse(raw);
  const chain = {
    streamId: payload.streamId,
    sequence: payload.sequence,
    previousHash,
    payloadHash: payloadHash(payload),
    entityType: payload.entityType,
    entityKey: backOfficeAuditEntityKey(
      payload.scope,
      payload.entityType,
      payload.entityId,
    ),
    beforeHash: backOfficeAuditStateHash(payload.before, payload.beforeNonce),
    afterHash: backOfficeAuditStateHash(payload.after, payload.afterNonce),
  };
  const proof = {
    version: payload.version,
    ...chain,
    hash: proofHash(chain),
    publicKey: keys.publicKey,
  };
  return BackOfficeAuditEntrySchema.parse({
    payload,
    proof: {
      ...proof,
      signature: sign(null, signatureBody(proof), privateKey).toString(
        "base64",
      ),
    },
  });
}

export function verifyBackOfficeAuditProof(raw: unknown): BackOfficeAuditProof {
  const proof = BackOfficeAuditProofSchema.parse(raw);
  const { signature, ...unsigned } = proof;
  const chain = proofBody(proof);
  if (
    proof.hash !== proofHash(chain) ||
    !verify(
      null,
      signatureBody(unsigned),
      createPublicKey({
        key: Buffer.from(proof.publicKey, "base64"),
        type: "spki",
        format: "der",
      }),
      Buffer.from(signature, "base64"),
    )
  )
    throw new Error(
      "Back Office audit proof has been altered or signed by an invalid key.",
    );
  return proof;
}

export function verifyBackOfficeAuditEntry(raw: unknown): BackOfficeAuditEntry {
  const entry = BackOfficeAuditEntrySchema.parse(raw);
  verifyBackOfficeAuditProof(entry.proof);
  if (
    entry.proof.streamId !== entry.payload.streamId ||
    entry.proof.sequence !== entry.payload.sequence ||
    entry.proof.payloadHash !== payloadHash(entry.payload) ||
    entry.proof.entityType !== entry.payload.entityType ||
    entry.proof.entityKey !==
      backOfficeAuditEntityKey(
        entry.payload.scope,
        entry.payload.entityType,
        entry.payload.entityId,
      ) ||
    entry.proof.beforeHash !== backOfficeAuditStateHash(entry.payload.before, entry.payload.beforeNonce) ||
    entry.proof.afterHash !== backOfficeAuditStateHash(entry.payload.after, entry.payload.afterNonce)
  )
    throw new Error("Back Office audit entry does not match its signed proof.");
  return entry;
}

/** The caller must obtain its trusted head/key independently of these entries. */
export function verifyBackOfficeAuditChain(
  raw: unknown[],
  trusted: BackOfficeAuditHead,
): BackOfficeAuditHead {
  const proofs = raw.map((entry) => verifyBackOfficeAuditEntry(entry).proof);
  return verifyBackOfficeAuditProofChain(proofs, trusted);
}

export function verifyBackOfficeAuditProofChain(
  raw: unknown[],
  trusted: BackOfficeAuditHead,
): BackOfficeAuditHead {
  let previousHash = BACK_OFFICE_AUDIT_GENESIS;
  const states = new Map<string, string>();
  let anchored = trusted.sequence === 0 && trusted.hash === previousHash;
  for (let index = 0; index < raw.length; index++) {
    const proof = verifyBackOfficeAuditProof(raw[index]);
    if (
      proof.sequence !== index + 1 ||
      proof.streamId !== trusted.streamId ||
      proof.publicKey !== trusted.publicKey ||
      proof.previousHash !== previousHash
    )
      throw new Error(
        "Back Office audit history has a missing, reordered or foreign entry.",
      );
    if (proof.sequence === trusted.sequence)
      anchored = proof.hash === trusted.hash;
    if (proof.beforeHash !== (states.get(proof.entityKey) ?? BACK_OFFICE_AUDIT_EMPTY_STATE))
      throw new Error("Back Office history contains an inconsistent state transition.");
    if (proof.afterHash === BACK_OFFICE_AUDIT_EMPTY_STATE) states.delete(proof.entityKey);
    else states.set(proof.entityKey, proof.afterHash);
    previousHash = proof.hash;
  }
  if (!anchored)
    throw new Error(
      "Back Office audit history was truncated or replaced after its checkpoint.",
    );
  return {
    streamId: trusted.streamId,
    publicKey: trusted.publicKey,
    sequence: raw.length,
    hash: previousHash,
  };
}
