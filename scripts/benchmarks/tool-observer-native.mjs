import { createToolJournal } from "./tool-journal.mjs";
export default {
  id:"legalwork-benchmark-tool-trace",
  async setup(ctx) {
    const journal=await createToolJournal({directory:ctx.options.directory,location:ctx.location.directory,runtimeKind:"native-v2"});
    const registrations=[await ctx.tool.hook("execute.before",event=>journal.before(event)),await ctx.tool.hook("execute.after",event=>journal.after(event))];
    return async()=>{for(const registration of registrations.reverse())await registration.dispose();await journal.close();};
  },
};
