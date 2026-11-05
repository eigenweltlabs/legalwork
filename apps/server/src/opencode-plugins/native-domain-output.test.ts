import { expect,test } from "bun:test";
import Calendar from "./legalwork-calendar-tools.js";
import Drafts from "./legalwork-draft-tools.js";
import Scheduling from "./legalwork-scheduled-task-tools.js";
import Project from "./legalwork-project-tools.js";
import Skills from "./legalwork-skill-tools.js";
import Reviews from "./legalwork-review-tools.js";
import Wiki from "./legalwork-wiki-tools.js";
import Storage from "./legalwork-storage-tools.js";
import Tasks from "./legalwork-task-tools.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

test("all domain tools advertise truthful JSON outputs and reuse authoritative result schemas",async()=>{
 const runtime=nativePluginTestRuntime();try{
   for(const plugin of[Calendar,Drafts,Scheduling,Project,Skills,Reviews,Wiki,Storage,Tasks])await runtime.start(plugin);
   for(const tool of runtime.tools.values())expect(tool.output,tool.name).toBeDefined();
   expect(runtime.tools.get("legalwork_calendar_create")?.output).toMatchObject({type:"object",properties:{ok:{type:"boolean"}}});
   expect(JSON.stringify(runtime.tools.get("legalwork_calendar_create")?.output)).toContain('"item"');
   expect(JSON.stringify(runtime.tools.get("legalwork_email_draft")?.output)).toContain('"revision"');
   expect(runtime.tools.get("legalwork_schedule_clock")?.output).toMatchObject({type:"object",properties:{currentTime:{type:"string"},timeZone:{type:"string"}}});
   expect(JSON.stringify(runtime.tools.get("view_create")?.output)).toContain('"datasets"');
   expect(JSON.stringify(runtime.tools.get("legalwork_review_get")?.output)).toContain('"cells"');
 }finally{await runtime.close();}
});
