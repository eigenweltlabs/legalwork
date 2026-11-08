import { Config } from "@opencode/schema/config";
import { Schema } from "effect";

export const agentDefinitionsSchema = Schema.Struct({ documents: Schema.Array(Config.Info), watchRoots: Schema.Array(Schema.String) });
