import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import {
  caFingerprint,
  ensureLocalCert,
  leafCertValid,
  officeAddinCertToolAvailable,
  signLeafForTest,
} from "./office-addin-cert.mjs";

const opensslAvailable = officeAddinCertToolAvailable();

test("generates a localhost leaf that validates against the CA", { skip: !opensslAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-cert-ok-"));
  try {
    const { caCertPath, leafCertPath, leafKeyPath } = await ensureLocalCert(dir);
    assert.ok(leafCertValid(leafCertPath, caCertPath), "localhost leaf should chain to the CA");
    assert.ok(caFingerprint(caCertPath), "CA fingerprint should be readable");
    assert.ok(leafKeyPath.endsWith("localhost.key"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "macOS LibreSSL keeps its serial file inside a dotted certificate path",
  { skip: platform() !== "darwin" || !existsSync("/usr/bin/openssl") },
  async () => {
    const previousOpenssl = process.env.LEGALWORK_OPENSSL_BIN;
    const root = mkdtempSync("/tmp/lw-cert-root-");
    const dir = join(root, "user.name", "office-addin-certs");
    mkdirSync(dir, { recursive: true });
    process.env.LEGALWORK_OPENSSL_BIN = "/usr/bin/openssl";
    try {
      const { caCertPath, leafCertPath } = await ensureLocalCert(dir);
      assert.ok(leafCertValid(leafCertPath, caCertPath));
      assert.equal(existsSync(join(root, "user.srl")), false);
    } finally {
      if (previousOpenssl === undefined) delete process.env.LEGALWORK_OPENSSL_BIN;
      else process.env.LEGALWORK_OPENSSL_BIN = previousOpenssl;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("name constraint rejects a non-localhost certificate", { skip: !opensslAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-cert-evil-"));
  try {
    await ensureLocalCert(dir);

    // A well-formed, CA-signed cert for a real domain — the signature is
    // valid, but the name constraint must make chain verification fail.
    const evilCert = signLeafForTest(dir, "DNS:evil.example.com", "/CN=evil.example.com");
    assert.equal(
      leafCertValid(evilCert, join(dir, "legalwork-local-ca.crt")),
      false,
      "a cert for evil.example.com must NOT validate against a localhost-constrained CA",
    );

    // Sanity: a second localhost cert from the same CA still validates.
    const okCert = signLeafForTest(dir, "DNS:localhost, IP:127.0.0.1", "/CN=localhost");
    assert.ok(
      leafCertValid(okCert, join(dir, "legalwork-local-ca.crt")),
      "a localhost cert must still validate",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureLocalCert is idempotent (reuses valid material)", { skip: !opensslAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-cert-idem-"));
  try {
    const first = await ensureLocalCert(dir);
    const firstFp = caFingerprint(first.caCertPath);
    const second = await ensureLocalCert(dir);
    assert.equal(caFingerprint(second.caCertPath), firstFp, "CA should not be regenerated when valid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
