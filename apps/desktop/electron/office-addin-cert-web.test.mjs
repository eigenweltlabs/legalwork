/**
 * Cross-generator guarantees for the pure-JS (Windows) certificate path:
 * everything the OpenSSL-generated certificates must satisfy is asserted
 * here against the JS-generated ones, using the system OpenSSL as the
 * independent verifier — including the localhost name-constraint proof.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext } from "node:tls";

import { leafCertValidNode } from "./office-addin-cert.mjs";
import { generateLocalCertWeb, signLeafForTestWeb } from "./office-addin-cert-web.mjs";

const OPENSSL = process.env.LEGALWORK_OPENSSL_BIN?.trim() || "openssl";
const opensslAvailable = (() => {
  try {
    return spawnSync(OPENSSL, ["version"], { encoding: "utf8", timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

function certPaths(dir) {
  return {
    caCertPath: join(dir, "legalwork-local-ca.crt"),
    caKeyPath: join(dir, "legalwork-local-ca.key"),
    leafCertPath: join(dir, "localhost.crt"),
    leafKeyPath: join(dir, "localhost.key"),
  };
}

function opensslVerify(caCertPath, leafCertPath) {
  return (
    spawnSync(OPENSSL, ["verify", "-CAfile", caCertPath, leafCertPath], {
      encoding: "utf8",
      timeout: 30_000,
    }).status === 0
  );
}

test("JS-generated localhost leaf chains to the CA (openssl cross-check)", { skip: !opensslAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-certweb-ok-"));
  try {
    const paths = certPaths(dir);
    await generateLocalCertWeb(paths);
    assert.ok(
      opensslVerify(paths.caCertPath, paths.leafCertPath),
      "openssl must accept the JS-generated localhost chain",
    );
    // SAN must cover the names the manifest points Office at.
    const text = spawnSync(OPENSSL, ["x509", "-in", paths.leafCertPath, "-noout", "-text"], {
      encoding: "utf8",
      timeout: 30_000,
    }).stdout;
    assert.match(text, /DNS:localhost/);
    assert.match(text, /IP Address:127\.0\.0\.1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JS CA name constraint rejects a non-localhost certificate (openssl)", { skip: !opensslAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-certweb-evil-"));
  try {
    const paths = certPaths(dir);
    await generateLocalCertWeb(paths);

    // A well-formed, CA-signed cert for a real domain — the signature is
    // valid, but the name constraint must make chain verification fail.
    const evilCert = await signLeafForTestWeb(
      dir,
      [{ type: "dns", value: "evil.example.com" }],
      "evil.example.com",
    );
    assert.equal(
      opensslVerify(paths.caCertPath, evilCert),
      false,
      "a cert for evil.example.com must NOT validate against a localhost-constrained CA",
    );

    // Sanity: a second localhost cert from the same CA still validates.
    const okCert = await signLeafForTestWeb(
      dir,
      [
        { type: "dns", value: "localhost" },
        { type: "ip", value: "127.0.0.1" },
      ],
      "localhost",
    );
    assert.ok(opensslVerify(paths.caCertPath, okCert), "a localhost cert must still validate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("leafCertValidNode validates the JS pair and rejects a foreign CA", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "lw-certweb-node-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "lw-certweb-node-b-"));
  try {
    const a = certPaths(dirA);
    const b = certPaths(dirB);
    await generateLocalCertWeb(a);
    await generateLocalCertWeb(b);
    assert.ok(leafCertValidNode(a.leafCertPath, a.caCertPath), "own chain must validate");
    assert.equal(
      leafCertValidNode(a.leafCertPath, b.caCertPath),
      false,
      "a leaf must not validate against another install's CA",
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("the HTTPS listener can consume the JS-generated key pair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lw-certweb-tls-"));
  try {
    const paths = certPaths(dir);
    await generateLocalCertWeb(paths);
    // Throws on a cert/key mismatch or unparsable PEM.
    createSecureContext({
      cert: readFileSync(paths.leafCertPath, "utf8"),
      key: readFileSync(paths.leafKeyPath, "utf8"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
