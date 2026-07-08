/**
 * Pure-JS certificate generation for the Office add-in — the Windows path.
 *
 * Windows has no system OpenSSL, so the localhost-constrained CA and leaf
 * are generated with @peculiar/x509 on top of Node's native webcrypto (key
 * generation and signing run in BoringSSL, not JS). macOS does NOT use this
 * module — office-addin-cert.mjs keeps shelling out to the system LibreSSL
 * there and only imports this file on win32.
 *
 * The output must stay semantically identical to the OpenSSL path in
 * office-addin-cert.mjs (same file names, subjects, validity windows, and
 * the critical localhost/loopback name constraint). The cross-generator
 * guarantees live in office-addin-cert-web.test.mjs, which verifies these
 * certificates — including the name-constraint rejection of a non-localhost
 * leaf — with the system OpenSSL verifier.
 */
import { randomBytes, webcrypto } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Must precede @peculiar/x509: its DI container (tsyringe) needs the
// Reflect.metadata polyfill at load time.
import "reflect-metadata";

import { AsnConvert } from "@peculiar/asn1-schema";
import {
  GeneralName,
  GeneralSubtree,
  GeneralSubtrees,
  NameConstraints,
  id_ce_nameConstraints,
} from "@peculiar/asn1-x509";
import * as x509 from "@peculiar/x509";

// Node's webcrypto implements the WebCrypto API, but its TS type lags the
// DOM lib's (Ed25519 overloads); the runtime object is compatible.
x509.cryptoProvider.set(/** @type {Crypto} */ (/** @type {unknown} */ (webcrypto)));

// Keep in sync with the OpenSSL constants in office-addin-cert.mjs.
const CA_SUBJECT = "CN=LegalWork Local CA, O=LegalWork";
const LEAF_SUBJECT = "CN=localhost, O=LegalWork";
const CA_VALID_DAYS = 825;
const LEAF_VALID_DAYS = 397;

/** Tolerate clocks that are slightly ahead of this machine. */
const CLOCK_SKEW_MS = 5 * 60_000;

const RSA_ALG = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};

const LOCALHOST_ALT_NAMES = [
  { type: "dns", value: "localhost" },
  { type: "ip", value: "127.0.0.1" },
  { type: "ip", value: "::1" },
];

function validityWindow(days) {
  const now = Date.now();
  return {
    notBefore: new Date(now - CLOCK_SKEW_MS),
    notAfter: new Date(now + days * 24 * 60 * 60 * 1000),
  };
}

/** Random positive serial (DER INTEGER must not be negative or zero). */
function randomSerialNumber() {
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  bytes[0] |= 0x01;
  return bytes.toString("hex");
}

/**
 * The critical name constraint that bounds the CA to loopback names — the
 * JS equivalent of the OpenSSL config in office-addin-cert.mjs
 * (`permitted;DNS:localhost, permitted;IP:127.0.0.1/…, permitted;IP:::1/…`).
 * CIDR strings serialize to the address+mask octets RFC 5280 requires.
 */
function localhostNameConstraintsExtension() {
  const constraints = new NameConstraints({
    permittedSubtrees: new GeneralSubtrees([
      new GeneralSubtree({ base: new GeneralName({ dNSName: "localhost" }) }),
      new GeneralSubtree({ base: new GeneralName({ iPAddress: "127.0.0.1/32" }) }),
      new GeneralSubtree({ base: new GeneralName({ iPAddress: "::1/128" }) }),
    ]),
  });
  return new x509.Extension(id_ce_nameConstraints, true, AsnConvert.serialize(constraints));
}

function generateRsaKeyPair() {
  return webcrypto.subtle.generateKey(RSA_ALG, true, ["sign", "verify"]);
}

async function exportPrivateKeyPem(privateKey) {
  const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", privateKey);
  return x509.PemConverter.encode(pkcs8, "PRIVATE KEY");
}

async function issueLeaf({ caCert, caPrivateKey, subject, altNames, validDays }) {
  const keys = await generateRsaKeyPair();
  const { notBefore, notAfter } = validityWindow(validDays);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerialNumber(),
    subject,
    issuer: caCert.subject,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALG,
    publicKey: keys.publicKey,
    signingKey: caPrivateKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension(altNames, false),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { cert, keys };
}

/**
 * Generate the name-constrained CA plus the localhost leaf and write all
 * four PEM files. Not idempotent by itself — office-addin-cert.mjs decides
 * when regeneration is needed (same contract as the OpenSSL path).
 */
export async function generateLocalCertWeb({ caCertPath, caKeyPath, leafCertPath, leafKeyPath }) {
  const caKeys = await generateRsaKeyPair();
  const { notBefore, notAfter } = validityWindow(CA_VALID_DAYS);
  const caCert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerialNumber(),
    subject: CA_SUBJECT,
    issuer: CA_SUBJECT,
    notBefore,
    notAfter,
    signingAlgorithm: RSA_ALG,
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      localhostNameConstraintsExtension(),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey),
    ],
  });

  const leaf = await issueLeaf({
    caCert,
    caPrivateKey: caKeys.privateKey,
    subject: LEAF_SUBJECT,
    altNames: LOCALHOST_ALT_NAMES,
    validDays: LEAF_VALID_DAYS,
  });

  writeFileSync(caCertPath, caCert.toString("pem"), "utf8");
  writeFileSync(caKeyPath, await exportPrivateKeyPem(caKeys.privateKey), "utf8");
  writeFileSync(leafCertPath, leaf.cert.toString("pem"), "utf8");
  writeFileSync(leafKeyPath, await exportPrivateKeyPem(leaf.keys.privateKey), "utf8");

  return { caCertPath, caKeyPath, leafCertPath, leafKeyPath };
}

/**
 * Sign an arbitrary-SAN leaf with an existing JS-generated CA.
 * Test/diagnostic helper mirroring signLeafForTest in office-addin-cert.mjs:
 * proves the name constraint by attempting a non-localhost cert (which must
 * fail chain verification even though the signature is valid).
 */
export async function signLeafForTestWeb(dir, altNames, subjectCommonName = "test") {
  const caCertPem = readFileSync(join(dir, "legalwork-local-ca.crt"), "utf8");
  const caKeyPem = readFileSync(join(dir, "legalwork-local-ca.key"), "utf8");
  const caCert = new x509.X509Certificate(caCertPem);
  const [caKeyDer] = x509.PemConverter.decode(caKeyPem);
  const caPrivateKey = await webcrypto.subtle.importKey("pkcs8", caKeyDer, RSA_ALG, false, ["sign"]);

  const leaf = await issueLeaf({
    caCert,
    caPrivateKey,
    subject: `CN=${subjectCommonName}`,
    altNames,
    validDays: 30,
  });
  const certPath = join(dir, "test-leaf.crt");
  writeFileSync(certPath, leaf.cert.toString("pem"), "utf8");
  return certPath;
}
