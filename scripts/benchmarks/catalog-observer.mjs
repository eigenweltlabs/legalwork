// Isolated benchmark instrumentation only. No model tools, transforms, prompts,
// model hooks, permission changes or execution interception are registered.
import { Schema } from "effect";
import * as zod from "zod/v4/core";

function jsonSchema(value, io) {
  if (Schema.isSchema(value)) {
    const document = Schema.toJsonSchemaDocument(value, {
      onExcessProperty: "error",
    });
    return {
      ...document.schema,
      ...(Object.keys(document.definitions).length
        ? { $defs: { ...document.schema.$defs, ...document.definitions } }
        : {}),
    };
  }
  const standard = value?.["~standard"];
  if (standard?.jsonSchema?.[io])
    return standard.jsonSchema[io]({ target: "draft-2020-12" });
  if (value?._zod) return zod.toJSONSchema(value, { io });
  if (
    typeof value === "boolean" ||
    (value && typeof value === "object" && !standard)
  )
    return JSON.parse(JSON.stringify(value));
  throw new Error(
    `Cannot export a complete ${io} schema; benchmark catalog coverage refused`,
  );
}
export default {
  id: "legalwork-benchmark-observer",
  async setup(ctx) {
    const registration = await ctx.rpc.register(
      {
        id: "legalwork-benchmark-observer",
        methods: {
          catalog: {
            input: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            output: { type: "object", additionalProperties: true },
          },
        },
        events: {},
      },
      {
        catalog: async () => ({
          observer: {
            id: "legalwork-benchmark-observer",
            version: 1,
            mutatesEngine: false,
          },
          schemaCoverage: "complete",
          scope: {
            location: ctx.location.directory,
            sessionAgentSelectionSupported: false,
          },
          schemaConversion: {
            dialect: "draft-2020-12",
            effect:
              "Schema.toJsonSchemaDocument; onExcessProperty:error; all definitions retained",
            standard: "~standard.jsonSchema[io]",
            zod: "zod/v4/core.toJSONSchema",
            simplification:
              "none; provider-visible wire schemas are captured separately",
          },
          tools: (await ctx.tool.list()).map((tool) => ({
            id: tool.id,
            name: tool.name,
            description: tool.description,
            options: tool.options,
            input: jsonSchema(tool.input, "input"),
            ...(tool.output !== undefined
              ? { output: jsonSchema(tool.output, "output") }
              : {}),
          })),
        }),
      },
    );
    return registration.dispose;
  },
};
