import { z } from 'zod';
import { Plugin } from '@opencode/plugin';
import { nativeTool } from './native-tool.js';
import { createMailTools } from '../mail/agent-tools.js';
export { createMailTools } from '../mail/agent-tools.js';

export default Plugin.define({
 id: "legalwork.mail",
 async setup(ctx) {
  const definitions = await createMailTools();
  await ctx.tool.transform(editor => {
   for (const [name, definition] of Object.entries(definitions.tool)) editor.add(nativeTool(ctx, {
    name, description: definition.description,
    schema: name === "mail_accounts" ? z.object({}) : z.object(definition.args),
    permission: "domain",
    execute: async (value, context) => {
     const tools = await createMailTools({directory: context.directory});
     const selected = Object.entries(tools.tool).find(([key]) => key === name)?.[1];
     if (!selected) throw new Error("Mail tool unavailable.");
     return selected.execute(value, context);
    },
   }));
  });
 },
});
