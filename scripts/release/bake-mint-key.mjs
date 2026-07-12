// Injects the Eigenwelt free-mint token (EIGENWELT_FREE_MINT_KEY env, from
// the repo secret of the same name) into constants.json before the server
// builds. The checked-in value is EMPTY — this repo is public; the token
// ships only inside release binaries. It is a bot filter, not auth: the
// free-key mint endpoint 401s without it. See
// apps/server/src/eigenwelt-free.ts (eigenweltFreeMintKey).
import { readFileSync, writeFileSync } from "node:fs";

const key = process.env.EIGENWELT_FREE_MINT_KEY;
if (!key) {
  console.error("EIGENWELT_FREE_MINT_KEY is not set — the packaged app could not mint free keys");
  process.exit(1);
}
const path = new URL("../../constants.json", import.meta.url);
const constants = JSON.parse(readFileSync(path, "utf8"));
constants.eigenweltFreeMintKey = key;
writeFileSync(path, `${JSON.stringify(constants, null, 2)}\n`);
console.log("baked eigenweltFreeMintKey into constants.json");
