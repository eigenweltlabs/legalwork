import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import release from "./release.json" with { type: "json" };
import recipe from "./build/recipe.json" with { type: "json" };
import { writeFixtureReleaseLibrary } from "./test-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), "legalwork-verified-candidate-"));
  const binary = path.join(directory, "opencode"), bytes = Buffer.from("non-executable candidate test bytes");
  const document = {
    ...recipe, buildStatus: "tested-source-lock", target: "darwin-arm64", officialBase: release.packages["darwin-arm64"],
    testEvidence: { receiptSha256: recipe.inputs.testReceipt.sha256, patchSha256: recipe.inputs.patch.sha256, lockfileSha256: recipe.inputs.lockfile.sha256, bun: recipe.toolchain.bun },
    compiler: { version: recipe.toolchain.bun, sha256: recipe.toolchain.executables["darwin-arm64"].sha256 },
    binary: { filename: "opencode", sha256: hash(bytes) },
  };
  const provenance = `${JSON.stringify(document)}\n`, provenanceSha256 = hash(provenance);
  await writeFile(binary, bytes); await writeFile(path.join(directory, "provenance.json"), provenance);
  const library = await writeFixtureReleaseLibrary(path.join(directory, "official-host"));
  const candidate = await import(pathToFileURL(path.join(library, "candidate.mjs")));
  try { await run({ candidate, directory, binary, document, provenance, provenanceSha256 }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("an explicit official selector remains exact; a verified host capability selects only its distinct build", async () => {
  await fixture(async ({ candidate, directory, binary, provenanceSha256 }) => {
    assert.equal(await candidate.expectedOpencodeVersion(binary), release.version);
    assert.equal(await candidate.expectedOpencodeServiceFilename(binary), "service.json");
    const descriptor = await candidate.verifyOpencodeCandidate({ directory, provenanceSha256 });
    assert.equal(Object.isFrozen(descriptor), true);
    assert.equal(descriptor.baseVersion, release.version);
    assert.equal(descriptor.version, recipe.version);
    assert.equal(await candidate.expectedOpencodeVersion(binary, descriptor), recipe.version);
    assert.equal(await candidate.expectedOpencodeServiceFilename(binary, descriptor), "service-legalwork.json");
    assert.equal(await candidate.expectedOpencodeVersion(binary), release.version);
    await assert.rejects(candidate.expectedOpencodeVersion(binary, { ...descriptor }), /unknown or mutable/);
    await assert.rejects(candidate.expectedOpencodeVersion(binary, Object.freeze({ ...descriptor })), /unknown or mutable/);
    const other = path.join(directory, "other-engine"); await writeFile(other, await readFile(binary));
    await assert.rejects(candidate.expectedOpencodeVersion(other, descriptor), /requested engine path/);
  });
});

test("candidate validation requires the independently reviewed receipt and registered source graph", async () => {
  await fixture(async ({ candidate, directory, document, provenanceSha256 }) => {
    await assert.rejects(candidate.verifyOpencodeCandidate({ directory, provenanceSha256: "" }), /independently reviewed/);
    await assert.rejects(candidate.verifyOpencodeCandidate({ directory, provenanceSha256: "0".repeat(64) }), /reviewed receipt/);
    for (const invalid of [
      { ...document, version: release.version },
      { ...document, channel: "latest" },
      { ...document, buildStatus: "unreviewed" },
      { ...document, testEvidence: { ...document.testEvidence, lockfileSha256: "unreviewed" } },
      { ...document, testEvidence: { ...document.testEvidence, receiptSha256: "unreviewed" } },
      { ...document, compiler: { ...document.compiler, sha256: "0".repeat(64) } },
      { ...document, target: "__proto__" },
      { ...document, officialBase: { ...document.officialBase, integrity: "unreviewed" } },
    ]) {
      const bytes = JSON.stringify(invalid); await writeFile(path.join(directory, "provenance.json"), bytes);
      await assert.rejects(candidate.verifyOpencodeCandidate({ directory, provenanceSha256: hash(bytes) }), /not registered|pinned release/);
    }
  });
});

test("each spawn check rejects binary and manifest changes after initial verification", async () => {
  await fixture(async ({ candidate, directory, binary, provenance, provenanceSha256 }) => {
    const descriptor = await candidate.verifyOpencodeCandidate({ directory, provenanceSha256 });
    await writeFile(binary, "tampered binary");
    await assert.rejects(candidate.expectedOpencodeVersion(binary, descriptor), /binary changed/);
    await writeFile(binary, "non-executable candidate test bytes");
    await writeFile(path.join(directory, "provenance.json"), `${provenance} `);
    await assert.rejects(candidate.expectedOpencodeVersion(binary, descriptor), /reviewed receipt/);
  });
});

test("an artifact binary symlink cannot escape to an identical unreviewed path", async () => {
  await fixture(async ({ candidate, directory, binary, provenanceSha256 }) => {
    const outside = `${directory}-outside`; await writeFile(outside, await readFile(binary));
    try {
      await rm(binary); await symlink(outside, binary);
      await assert.rejects(candidate.verifyOpencodeCandidate({ directory, provenanceSha256 }), /escapes its reviewed artifact/);
    } finally { await rm(outside, { force: true }); }
  });
});

test("explicit validation registration authorizes exactly one canonical binary and rechecks bytes", async () => {
  await fixture(async ({ candidate, directory, binary, provenanceSha256 }) => {
    const descriptor = await candidate.verifyOpencodeCandidate({ directory, provenanceSha256 });
    await candidate.registerOpencodeCandidateForValidation(descriptor);
    assert.equal(await candidate.expectedOpencodeVersion(binary), recipe.version);
    const unrelated = path.join(directory, "official"); await writeFile(unrelated, "official fixture");
    assert.equal(await candidate.expectedOpencodeVersion(unrelated), release.version);
    await writeFile(binary, "tampered registered binary");
    await assert.rejects(candidate.expectedOpencodeVersion(binary), /binary changed/);
  });
});
