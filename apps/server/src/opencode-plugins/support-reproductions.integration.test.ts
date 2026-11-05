import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
const binary=process.env.LEGALWORK_TEST_OPENCODE_BIN;
const report=z.object({invalidCalls:z.number(),requests:z.array(z.object({recoveryWarning:z.boolean().optional(),finalRecoveryWarning:z.boolean().optional()})),sessions:z.array(z.object({
  metadata:z.record(z.string(),z.unknown()).optional(),
  history:z.array(z.object({type:z.string(),outcome:z.string().optional(),metadata:z.record(z.string(),z.unknown()).optional()})),
  messages:z.array(z.object({info:z.object({role:z.string(),error:z.object({message:z.string()}).optional()}),parts:z.array(z.object({type:z.string(),text:z.string().optional()}))}))
}))});
for (const [mode, toolCase, codemode] of [["fixed", "saved-output", "0"], ["recover", "saved-output", "0"], ["transport-fixed", "saved-output", "0"], ["fixed", "native", "0"], ["recover", "native", "0"], ["fixed", "mcp", "0"], ["recover", "mcp", "0"], ["fixed", "word", "0"], ["recover", "word", "0"], ["fixed", "saved-output", "1"], ["recover", "saved-output", "1"]]) test.skipIf(!binary)(`pinned engine: ${mode} / ${toolCase} / Code Mode ${codemode}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),"legalwork-support-engine-"));
  try {
    const process=Bun.spawn(["bun",join(import.meta.dir,"../../scripts/support-tool-agent-repro.ts")],{env:{...Bun.env,SUPPORT_AGENT_MODE:mode,SUPPORT_AGENT_CODEMODE:codemode,SUPPORT_AGENT_CASE:toolCase,SUPPORT_REPRO_DIR:root,LEGALWORK_TEST_OPENCODE_BIN:binary},stdout:"pipe",stderr:"pipe"});
    const output=Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text()]);
    expect(await process.exited,(await output).join("\n")).toBe(0);
    const result=report.parse(JSON.parse(await readFile(join(root,`agent-${mode}`,"report.json"),"utf8")));
    if(mode==="fixed"){
      expect(result.sessions).toHaveLength(2);
      expect(result.requests.some(request=>request.recoveryWarning)).toBe(true);
      expect(result.requests.some(request=>request.finalRecoveryWarning)).toBe(true);
      expect(result.invalidCalls).toBeGreaterThanOrEqual(6);expect(result.invalidCalls).toBeLessThanOrEqual(8);
      expect(result.sessions[1].history.some(message=>message.type==="idle" && message.outcome==="interrupted")).toBe(true);
      expect(result.sessions[1].metadata?.legalworkToolStops).toBeDefined();
    } else if(mode==="recover") {
      expect(result.requests.some(request=>request.recoveryWarning)).toBe(true);
      expect(result.invalidCalls).toBe(3);
      expect(result.sessions[1].history.some(message=>message.type==="idle" && message.outcome==="interrupted")).toBe(false);
      expect(result.sessions[1].messages.some(message=>message.parts.some(part=>part.text?.includes("accepted correction guidance")))).toBe(true);
    } else {
      expect(result.sessions[0].messages.some(message=>message.parts.some(part=>part.type==="compaction"))).toBe(false);
      expect(result.sessions[0].messages.find(message=>message.info.role==="assistant")?.info.error?.message).toContain("HTTP 413; request_bytes=");
    }
  } finally {await rm(root,{recursive:true,force:true});}
},60000);
