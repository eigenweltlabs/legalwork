import { verifyOpencodeCandidate, registerOpencodeCandidateForValidation } from "../candidate.mjs";

// This module is never imported by ordinary production startup. Test/acceptance
// commands must explicitly preload it and supply the inspected build receipt.
const directory = process.env.LEGALWORK_TEST_CANDIDATE_DIRECTORY;
const provenanceSha256 = process.env.LEGALWORK_TEST_CANDIDATE_PROVENANCE_SHA256;
if (!directory || !provenanceSha256) throw new Error("Candidate validation requires an explicit artifact directory and independently reviewed provenance SHA256.");
await registerOpencodeCandidateForValidation(await verifyOpencodeCandidate({ directory, provenanceSha256 }));
