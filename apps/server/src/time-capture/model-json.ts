import { z } from "zod";

/** Validate private model output, allowing one format repair within the caller's deadline. */
export async function generateModelJson<T>(
  prompt: string,
  schema: z.ZodType<T>,
  generate: (prompt: string) => Promise<string>,
  invalid: () => Error,
): Promise<T> {
  const contract = "Return exactly one JSON object matching this schema, without Markdown or any explanation before or after it:\n" +
    JSON.stringify(z.toJSONSchema(schema));
  for (let attempt = 0; attempt < 2; attempt++) {
    // Provider, cancellation and permission failures are not format errors or retryable here.
    const text = await generate([
      contract,
      ...(attempt ? ["Your previous response did not match the JSON contract. Correct the format and field types; do not add commentary."] : []),
      prompt,
    ].join("\n\n"));
    try {
      return schema.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")));
    } catch {
      if (attempt === 1) throw invalid();
    }
  }
  throw invalid();
}
