import { z } from "zod";

export function generateModelJson<T>(
  prompt: string, schema: z.ZodType<T>, generate: (prompt: string) => Promise<string>, invalid: () => Error,
): Promise<T> {
  return generateCheckedModelJson(prompt, schema, generate, invalid, value => ({ ok: true, value }));
}

/** One repair budget covers JSON, schema, and any caller-supplied evidence check. */
export async function generateCheckedModelJson<T, R>(
  prompt: string, schema: z.ZodType<T>, generate: (prompt: string) => Promise<string>, invalid: () => Error,
  check: (parsed: T) => { ok: true; value: R } | { ok: false; repair: string },
): Promise<R> {
  const contract = "Return exactly one JSON object matching this schema, without Markdown or any explanation before or after it:\n" +
    JSON.stringify(z.toJSONSchema(schema));
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Transport, cancellation, permission and unexpected application errors propagate.
    const text = await generate([contract, ...(feedback ? [feedback] : []), prompt].join("\n\n"));
    let parsed: T;
    try {
      parsed = schema.parse(JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")));
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
      feedback = "Your previous response did not match the JSON contract. Correct the format and field types and return the whole JSON object.";
      continue;
    }
    const checked = check(parsed);
    if (checked.ok) return checked.value;
    // Only the check's application-authored instruction may be sent back to the model.
    feedback = checked.repair;
  }
  throw invalid();
}
