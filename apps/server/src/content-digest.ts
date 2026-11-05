import { createHash } from "node:crypto";
import { z } from "zod";

const algorithm = z.enum(["sha256", "sha384", "sha512"]);
const encoding = z.enum(["utf8", "base64"]);
export const contentDigestInput = z.object({
  data: z.string().describe("Exact text or canonical base64 for bytes already available to you. No normalization is applied."),
  encoding: encoding.default("utf8").describe("utf8 hashes the text's UTF-8 bytes; base64 hashes the decoded binary bytes."),
  algorithm: algorithm.default("sha256"),
}).strict();
export const contentDigestOutput = z.object({
  algorithm,
  encoding,
  bytes: z.number().int().nonnegative(),
  hex: z.string(),
}).strict();

/** Pure computation over supplied bytes; never reads a file or contacts a service. */
export function digestContent(input: z.output<typeof contentDigestInput>): z.output<typeof contentDigestOutput> {
  const bytes = Buffer.from(input.data, input.encoding);
  if (input.encoding === "base64" && bytes.toString("base64") !== input.data) {
    throw new Error("Provide canonical base64, including its required padding, for the exact binary bytes.");
  }
  return {
    algorithm: input.algorithm,
    encoding: input.encoding,
    bytes: bytes.length,
    hex: createHash(input.algorithm).update(bytes).digest("hex"),
  };
}
