import { createToolJournal } from "./tool-journal.mjs";
// The private profile sets only its trace directory. No tools or context added.
export default async ({directory})=>{
  const journal=await createToolJournal({directory:process.env.LEGALWORK_BENCH_TOOL_TRACE_DIR,location:directory,runtimeKind:"legacy-v1"});
  return {
    "tool.execute.before":async(input,output)=>journal.before({...input,input:output.args,id:input.callID}),
    "tool.execute.after":async(input,output)=>journal.after({...input,input:input.args,id:input.callID,status:output===undefined?"unavailable":"completed",result:output,resultAvailability:output===undefined?"v1-after-hook-provided-no-value":"complete-v1-hook-value"}),
  };
};
