/**
 * Certificate material for the Office add-in HTTPS listener.
 *
 * Unlike the dev flow (office-addin-dev-certs, an unconstrained CA), the
 * production desktop app generates its OWN CA that is cryptographically
 * constrained to localhost/loopback via X.509 Name Constraints (RFC 5280).
 * Even if the CA private key is stolen from the user's machine, it cannot
 * mint certificates for real domains — modern macOS/Windows enforce the
 * constraint — so trusting it in the OS store is a bounded decision.
 *
 * On macOS generation shells out to the system OpenSSL (LibreSSL). Windows
 * has no system OpenSSL, so there — and only there — generation and
 * validation run in pure JS (office-addin-cert-web.mjs, loaded lazily so
 * macOS never touches it). Both generators produce the same certificate
 * shape; office-addin-cert-web.test.mjs proves the JS output against the
 * OpenSSL verifier.
 */
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

const CA_SUBJECT = "/CN=LegalWork Local CA/O=LegalWork";
const LEAF_SUBJECT = "/CN=localhost/O=LegalWork";
export const CA_COMMON_NAME = "LegalWork Local CA";
const CA_VALID_DAYS = 825; // Apple caps leaf validity at 825d; keep the CA modest too.
const LEAF_VALID_DAYS = 397;

function opensslBin() {
  return process.env.LEGALWORK_OPENSSL_BIN?.trim() || "openssl";
}

function runOpenssl(args, input) {
  const result = spawnSync(opensslBin(), args, {
    input,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`openssl ${args[0]} failed: ${detail || `exit ${result.status}`}`);
  }
  return result;
}

/**
 * True when certificate generation can work here: always on Windows (pure
 * JS), otherwise when the OpenSSL binary is callable.
 */
export function officeAddinCertToolAvailable() {
  if (platform() === "win32") return true;
  try {
    const result = spawnSync(opensslBin(), ["version"], { encoding: "utf8", timeout: 10_000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

// LibreSSL (macOS system /usr/bin/openssl) requires a [req] section with a
// distinguished_name entry in any -config file, even when -subj is passed.
// An empty DN section satisfies it; OpenSSL 3 ignores the shim.
const REQ_SHIM = [
  "[req]",
  "distinguished_name = req_dn",
  "[req_dn]",
  "",
].join("\n");

const CA_EXTENSIONS = [
  "[ca]",
  "basicConstraints = critical, CA:TRUE, pathlen:0",
  "keyUsage = critical, keyCertSign, cRLSign",
  // Bound the CA to loopback names only. A permitted-subtree violation makes
  // any cert for a non-localhost name fail chain validation.
  "nameConstraints = critical, permitted;DNS:localhost, permitted;IP:127.0.0.1/255.255.255.255, permitted;IP:0:0:0:0:0:0:0:1/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF",
  "",
].join("\n");

function leafExtensions(altNames) {
  return [
    "[leaf]",
    "basicConstraints = critical, CA:FALSE",
    "keyUsage = critical, digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    `subjectAltName = ${altNames}`,
    "",
  ].join("\n");
}

const LOCALHOST_ALT_NAMES = "DNS:localhost, IP:127.0.0.1, IP:::1";

/**
 * Generate (or reuse) a name-constrained CA and a localhost leaf certificate
 * in `dir`. Idempotent: existing valid material is kept. Returns absolute
 * paths for the CA, leaf cert, and leaf key.
 */
export async function ensureLocalCert(dir, { force = false } = {}) {
  mkdirSync(dir, { recursive: true });
  const caKeyPath = join(dir, "legalwork-local-ca.key");
  const caCertPath = join(dir, "legalwork-local-ca.crt");
  const leafKeyPath = join(dir, "localhost.key");
  const leafCertPath = join(dir, "localhost.crt");
  const caSerialPath = join(dir, "legalwork-local-ca.srl");
  const extPath = join(dir, "openssl-ext.cnf");

  const complete =
    existsSync(caKeyPath) && existsSync(caCertPath) && existsSync(leafKeyPath) && existsSync(leafCertPath);
  if (complete && !force && leafCertValid(leafCertPath, caCertPath)) {
    return { caCertPath, caKeyPath, leafCertPath, leafKeyPath };
  }

  if (platform() === "win32") {
    const { generateLocalCertWeb } = await import("./office-addin-cert-web.mjs");
    return generateLocalCertWeb({ caCertPath, caKeyPath, leafCertPath, leafKeyPath });
  }

  writeFileSync(extPath, `${REQ_SHIM}\n${CA_EXTENSIONS}\n${leafExtensions(LOCALHOST_ALT_NAMES)}\n`, "utf8");
  try {
    // CA: self-signed, name-constrained.
    runOpenssl(["genrsa", "-out", caKeyPath, "2048"]);
    runOpenssl([
      "req", "-x509", "-new", "-nodes",
      "-key", caKeyPath,
      "-sha256", "-days", String(CA_VALID_DAYS),
      "-subj", CA_SUBJECT,
      "-extensions", "ca", "-config", extPath,
      "-out", caCertPath,
    ]);

    // Leaf: localhost, signed by the CA. Pass -config here too so the CSR
    // step never depends on the system openssl.cnf being present/compatible.
    // Pass -CAserial explicitly because macOS LibreSSL otherwise truncates
    // dotted paths such as /Users/user.name to /Users/user.srl.
    runOpenssl(["genrsa", "-out", leafKeyPath, "2048"]);
    const csr = runOpenssl(["req", "-new", "-key", leafKeyPath, "-subj", LEAF_SUBJECT, "-config", extPath]).stdout;
    runOpenssl([
      "x509", "-req",
      "-CA", caCertPath, "-CAkey", caKeyPath,
      "-CAserial", caSerialPath, "-CAcreateserial",
      "-sha256", "-days", String(LEAF_VALID_DAYS),
      "-extensions", "leaf", "-extfile", extPath,
      "-out", leafCertPath,
    ], csr);
  } finally {
    rmSync(extPath, { force: true });
    rmSync(caSerialPath, { force: true });
  }

  return { caCertPath, caKeyPath, leafCertPath, leafKeyPath };
}

/**
 * Signature/expiry validation of the local pair via node:crypto — used on
 * Windows where OpenSSL is unavailable. This gates regeneration; the name
 * constraint itself is enforced by the OS chain validator at connect time
 * (and proven cross-generator in office-addin-cert-web.test.mjs).
 */
export function leafCertValidNode(leafCertPath, caCertPath) {
  try {
    const leaf = new X509Certificate(readFileSync(leafCertPath));
    const ca = new X509Certificate(readFileSync(caCertPath));
    const now = Date.now();
    for (const cert of [leaf, ca]) {
      if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) return false;
    }
    return leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
  } catch {
    return false;
  }
}

/** Verify a leaf certificate chains to the CA (enforces name constraints). */
export function leafCertValid(leafCertPath, caCertPath) {
  if (!existsSync(leafCertPath) || !existsSync(caCertPath)) return false;
  if (platform() === "win32") return leafCertValidNode(leafCertPath, caCertPath);
  const result = spawnSync(opensslBin(), ["verify", "-CAfile", caCertPath, leafCertPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.status === 0;
}

/** SHA-256 fingerprint of the CA cert, for status display / dedup. */
export function caFingerprint(caCertPath) {
  if (!existsSync(caCertPath)) return null;
  if (platform() === "win32") {
    try {
      return new X509Certificate(readFileSync(caCertPath)).fingerprint256;
    } catch {
      return null;
    }
  }
  try {
    const out = runOpenssl(["x509", "-in", caCertPath, "-noout", "-fingerprint", "-sha256"]).stdout;
    return out.split("=")[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * Sign an arbitrary-SAN leaf with the CA. Test/diagnostic helper: proves the
 * name constraint by attempting a non-localhost cert (which must fail
 * verification even though the signature is valid).
 */
export function signLeafForTest(dir, altNames, subject = "/CN=test") {
  const caKeyPath = join(dir, "legalwork-local-ca.key");
  const caCertPath = join(dir, "legalwork-local-ca.crt");
  const keyPath = join(dir, "test-leaf.key");
  const certPath = join(dir, "test-leaf.crt");
  const caSerialPath = join(dir, "legalwork-local-ca.srl");
  const extPath = join(dir, "test-ext.cnf");
  writeFileSync(extPath, `${REQ_SHIM}\n${leafExtensions(altNames)}`, "utf8");
  try {
    runOpenssl(["genrsa", "-out", keyPath, "2048"]);
    const csr = runOpenssl(["req", "-new", "-key", keyPath, "-subj", subject, "-config", extPath]).stdout;
    runOpenssl([
      "x509", "-req",
      "-CA", caCertPath, "-CAkey", caKeyPath,
      "-CAserial", caSerialPath, "-CAcreateserial",
      "-sha256", "-days", "30",
      "-extensions", "leaf", "-extfile", extPath,
      "-out", certPath,
    ], csr);
  } finally {
    rmSync(extPath, { force: true });
    rmSync(caSerialPath, { force: true });
  }
  return certPath;
}

export function readPem(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}
