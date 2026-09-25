import { z } from "zod";

const content = z.union([
  z.string(),
  z.record(z.string(), z.json()),
  z.array(z.json()),
]);
const description = content.nullable();
const probability = z.number().finite().min(0).max(1);
export const SystemOneQuestionTypeSchema = z.enum(["noul", "choice", "score"]);
export const SystemOneQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: content,
    criteria: z
      .object({ true: description.optional(), false: description.optional() })
      .optional(),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: content,
    criteria: z
      .record(z.string().min(1), description)
      .refine(
        (v) => Object.keys(v).length > 0 && Object.keys(v).length <= 255,
        "Supply 1–255 choices",
      ),
  }),
  z.object({
    type: z.literal("score"),
    instructions: content,
    criteria: z.array(content).min(2).max(10),
  }),
]);
export const SystemOneRequestSchema = z.object({
  model: z.string().trim().min(1).max(200).optional(),
  state: content,
  questions: z
    .record(z.string().min(1), SystemOneQuestionSchema)
    .refine((v) => Object.keys(v).length > 0, "Supply at least one question"),
});
export const SystemOneAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: z.record(z.string(), probability),
    confidence: probability.optional(),
  }),
  z.object({
    type: z.literal("score"),
    score: z.number().finite(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), probability),
    confidence: probability.optional(),
  }),
]);
export const SystemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), SystemOneAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .optional(),
  deployment_revision: z.string().optional(),
});
export const SystemOneEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "Use an HTTP(S) endpoint without credentials, query or fragment");
export const SystemOneConfigurationSchema = z.object({
  enabled: z.boolean(),
  available: z.boolean(),
  baseURL: SystemOneEndpointSchema,
  model: z.literal("EigenJev"),
  questionTypes: z.array(SystemOneQuestionTypeSchema),
  region: z.literal("EU"),
  deploymentRevision: z.string().optional(),
});
export const SystemOneModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  description: z.string().optional(),
  releaseDate: z.string().optional(),
  questionTypes: z.array(SystemOneQuestionTypeSchema).min(1),
});
export const SystemOneProviderInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).refine(
    (id) => id !== "eigenwelt", "Eigenwelt is managed by your subscription",
  ),
  name: z.string().trim().min(1).max(100),
  endpoint: SystemOneEndpointSchema,
  apiKey: z.string().trim().min(1).optional(),
  enabled: z.boolean(),
  // Explicit pins supplement the provider's live catalog (version IDs may be unlisted).
  models: z.array(SystemOneModelSchema).max(200).refine(
    (models) => new Set(models.map((model) => model.id)).size === models.length,
    "Model IDs must be unique within a provider",
  ),
});
export const SystemOneSelectionSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});
export type SystemOneConfiguration = z.infer<
  typeof SystemOneConfigurationSchema
>;
export type SystemOneQuestion = z.infer<typeof SystemOneQuestionSchema>;
export type SystemOneQuestions = Record<string, SystemOneQuestion>;
export type SystemOneRequest = z.infer<typeof SystemOneRequestSchema>;
export type SystemOneAnswer = z.infer<typeof SystemOneAnswerSchema>;
export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;
export type SystemOneProviderInput = z.infer<
  typeof SystemOneProviderInputSchema
>;
export type SystemOneSelection = z.infer<typeof SystemOneSelectionSchema>;
export type SystemOneOptions = { providerId?: string; signal?: AbortSignal };
export type SystemOneResult<Q extends SystemOneQuestions = SystemOneQuestions> =
  Omit<SystemOneResponse, "answers"> & {
    answers: {
      [K in keyof Q]: Extract<SystemOneAnswer, { type: Q[K]["type"] }>;
    };
    providerId: string;
    requestedModel: string;
  };
export type SystemOneModel = z.infer<typeof SystemOneModelSchema>;
export const SystemOneProviderSchema = SystemOneProviderInputSchema.omit({ apiKey: true, id: true, models: true }).extend({
  id: z.string(),
  models: z.array(SystemOneModelSchema.extend({ source: z.enum(["discovered", "configured"]) })),
  managed: z.boolean(),
  status: z.enum(["ready", "disabled", "disconnected", "unavailable"]),
  region: z.string().optional(),
  modelsError: z.string().optional(),
});
export type SystemOneProvider = z.infer<typeof SystemOneProviderSchema>;
export type SystemOneSettings = {
  providers: SystemOneProvider[];
  selection: SystemOneSelection;
};

/** Validate correspondence without repairing or inventing an answer. */
export function validateSystemOneResponse(
  request: SystemOneRequest,
  value: unknown,
): SystemOneResponse {
  const result = SystemOneResponseSchema.parse(value);
  const expected = Object.keys(request.questions).sort();
  if (
    JSON.stringify(expected) !==
    JSON.stringify(Object.keys(result.answers).sort())
  )
    throw new Error("Answer IDs do not match the questions");
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = result.answers[id];
    if (answer.type !== question.type)
      throw new Error(`Answer type does not match question ${id}`);
    if (answer.type === "choice" && question.type === "choice") {
      if (!Object.hasOwn(question.criteria, answer.choice))
        throw new Error(`Unknown choice for ${id}`);
      if (
        JSON.stringify(Object.keys(question.criteria).sort()) !==
        JSON.stringify(Object.keys(answer.probabilities).sort())
      )
        throw new Error(`Choice probabilities do not match ${id}`);
    }
    if (answer.type === "score" && question.type === "score") {
      const indices = question.criteria.map((_, i) => String(i)).sort();
      if (
        answer.score < 0 ||
        answer.score > question.criteria.length - 1 ||
        JSON.stringify(Object.keys(answer.probabilities).sort()) !==
          JSON.stringify(indices) ||
        JSON.stringify(Object.keys(answer.legend).sort()) !==
          JSON.stringify(indices)
      )
        throw new Error(`Score levels do not match ${id}`);
    }
    if (
      answer.type !== "noul" &&
      Math.abs(
        Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1,
      ) > 0.01
    )
      throw new Error(`Probabilities do not sum to one for ${id}`);
  }
  return result;
}
