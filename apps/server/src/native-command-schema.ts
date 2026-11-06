import { ConfigCommand } from "@opencode/schema/config/command";
import { Schema } from "effect";

export const commandDefinitionsSchema = Schema.Struct({
  commands: Schema.Record(Schema.String, ConfigCommand.Info),
});
export type CommandDefinitions = typeof commandDefinitionsSchema.Type;
export type EncodedCommandDefinitions = typeof commandDefinitionsSchema.Encoded;

export function encodeCommandDefinitions(definitions: CommandDefinitions): EncodedCommandDefinitions {
  return Schema.encodeSync(commandDefinitionsSchema)(definitions);
}
