import assert from "node:assert/strict";
import test from "node:test";
import { externalDirectoryDecision, permissionReplyEvent, exactRejectedReply, visibleDenyTarget } from "./permission-policy.mjs";
const source={messageID:"message",id:"call"};
const scope={ownedSessionIDs:["root","child"],taskDirectory:"/project/task"};
test("declared denial handles actual V1/native outside scopes without granting inside or unrelated permissions",()=>{
  const native={id:"ask",sessionID:"child",action:"external_directory",resources:["/project/*"],source};
  assert.equal(externalDirectoryDecision(native,scope).decision,"reject");
  assert.equal(externalDirectoryDecision({id:"v1",sessionID:"root",permission:"external_directory",patterns:["/parent/*"],tool:{messageID:"message",callID:"call"}},scope).decision,"reject");
  for(const change of [{sessionID:"unrelated"},{action:"file.read"},{resources:["/project/task/subdir/*"]},{resources:["/project/task2/../task/*"]},{resources:["/private/**"]},{resources:["relative/*"]},{source:undefined}])assert.equal(externalDirectoryDecision({...native,...change},scope).decision,"hold");
});
test("normal UI rejection proof cannot borrow another request/session or infer rejection from disappearance",()=>{
  const request={id:"ask",sessionID:"root"};
  const reply=permissionReplyEvent({type:"permission.replied",data:{sessionID:"root",requestID:"ask",reply:"reject"}});
  assert.equal(exactRejectedReply([reply],request),reply);
  assert.equal(exactRejectedReply([{...reply,sessionID:"child"}],request),null);
  assert.equal(exactRejectedReply([{...reply,requestID:"other"}],request),null);
  assert.throws(()=>exactRejectedReply([{...reply,reply:"once"}],request),/exact UI rejection/);
  assert.throws(()=>exactRejectedReply([reply,reply],request),/exact UI rejection/);
  const legacy=permissionReplyEvent({directory:"/project",payload:{type:"permission.replied",properties:{sessionID:"root",requestID:"ask",reply:"reject"}}});
  assert.equal(legacy.reply,"reject");
  assert.equal(permissionReplyEvent({type:"permission.asked"}),null);
});
test("OCR targets only one confident visible Deny label and never substitutes Allow or ambiguous text",()=>{
  const header="level\tleft\ttop\twidth\theight\tconf\ttext\n";
  const deny="5\t100\t200\t40\t20\t96\tDeny\n";
  const settings={minimumConfidence:80,width:1600,height:1000};
  assert.deepEqual({x:visibleDenyTarget(header+deny,settings).x,y:visibleDenyTarget(header+deny,settings).y},{x:120,y:210});
  for(const text of [header+deny+deny,header+deny.replace("96","12"),header+deny.replace("Deny","Allow"),header+deny.replace("200","2000")])assert.throws(()=>visibleDenyTarget(text,settings));
  const scaled=header+"5\t3812\t1661\t136\t51\t96\tDeny\n";
  assert.deepEqual({x:visibleDenyTarget(scaled,{...settings,scale:4}).x,y:visibleDenyTarget(scaled,{...settings,scale:4}).y},{x:970,y:421.625});
  assert.throws(()=>visibleDenyTarget(scaled,settings),/Uncertain/);
});
