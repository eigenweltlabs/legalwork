import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { officeAddinCertToolAvailable, ensureLocalCert } from "./office-addin-cert.mjs";
import {
  certSha1ThumbprintFromPem,
  isStoreOfficeExecutable,
  parseRegSzValue,
} from "./office-addin-platform.mjs";

test("isStoreOfficeExecutable flags WindowsApps installs only", () => {
  assert.ok(
    isStoreOfficeExecutable("C:\\Program Files\\WindowsApps\\Microsoft.Office.Desktop_16051\\Office16\\WINWORD.EXE"),
  );
  assert.equal(
    isStoreOfficeExecutable("C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE"),
    false,
  );
  assert.equal(isStoreOfficeExecutable(null), false);
});

test("parseRegSzValue extracts REG_SZ data from reg.exe query output", () => {
  const output = [
    "",
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE",
    "    (Default)    REG_SZ    C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    "",
  ].join("\r\n");
  assert.equal(
    parseRegSzValue(output),
    "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
  );
});

test("parseRegSzValue expands REG_EXPAND_SZ environment references", () => {
  const output =
    "    Path    REG_EXPAND_SZ    %TESTPROGRAMFILES%\\Microsoft Office\\WINWORD.EXE";
  assert.equal(
    parseRegSzValue(output, { TESTPROGRAMFILES: "C:\\Program Files" }),
    "C:\\Program Files\\Microsoft Office\\WINWORD.EXE",
  );
  // Unknown references stay verbatim instead of corrupting the path.
  assert.equal(
    parseRegSzValue(output, {}),
    "%TESTPROGRAMFILES%\\Microsoft Office\\WINWORD.EXE",
  );
});

test("parseRegSzValue returns null when no string value is present", () => {
  assert.equal(parseRegSzValue(""), null);
  assert.equal(parseRegSzValue("ERROR: The system was unable to find the specified registry key or value."), null);
  assert.equal(parseRegSzValue(null), null);
});

test("certSha1ThumbprintFromPem rejects non-PEM input", () => {
  assert.equal(certSha1ThumbprintFromPem(""), null);
  assert.equal(certSha1ThumbprintFromPem("not a certificate"), null);
  assert.equal(certSha1ThumbprintFromPem(null), null);
});

test(
  "certSha1ThumbprintFromPem matches openssl's SHA-1 fingerprint",
  { skip: !officeAddinCertToolAvailable() },
  async () => {
    const { spawnSync } = await import("node:child_process");
    const { readFileSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "lw-thumbprint-"));
    try {
      const { caCertPath } = await ensureLocalCert(dir);
      const thumbprint = certSha1ThumbprintFromPem(readFileSync(caCertPath, "utf8"));
      assert.match(thumbprint, /^[0-9a-f]{40}$/);
      const openssl = spawnSync(
        process.env.LEGALWORK_OPENSSL_BIN?.trim() || "openssl",
        ["x509", "-in", caCertPath, "-noout", "-fingerprint", "-sha1"],
        { encoding: "utf8", timeout: 30_000 },
      );
      const expected = openssl.stdout.split("=")[1]?.trim().replaceAll(":", "").toLowerCase();
      assert.equal(thumbprint, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
