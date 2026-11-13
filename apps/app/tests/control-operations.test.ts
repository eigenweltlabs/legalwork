import assert from "node:assert/strict";
import { test } from "node:test";
import { createControlOperations } from "../src/react-app/shell/control/control-operations";
import { createDocumentTaskQueue } from "../src/react-app/domains/session/artifacts/document-task-queue";

test("Stop propagates to queued document work and prevents a late mutation",async()=>{
  const operations=createControlOperations(),queue=createDocumentTaskQueue(),gate=Promise.withResolvers<void>();
  const first=queue("doc",()=>gate.promise);let writes=0;
  const pending=operations.run({requestId:"word",deadline:Date.now()+10000},context=>queue("doc",async()=>{writes++;},context));
  operations.cancel("word");await assert.rejects(pending,{name:"AbortError"});
  gate.resolve();await first;await queue("doc",async()=>{});assert.equal(writes,0);
});
test("expired renderer requests never enter the action",async()=>{
  const operations=createControlOperations();let invoked=false;
  await assert.rejects(operations.run({requestId:"expired",deadline:Date.now()-1},async()=>{invoked=true;}),{name:"TimeoutError"});
  assert.equal(invoked,false);
});
