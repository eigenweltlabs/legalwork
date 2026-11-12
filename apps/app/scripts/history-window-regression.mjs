// Run against the isolated Electron profile with the synthetic 10,000-message chat open:
// LEGALWORK_ELECTRON_CDP_URL=http://127.0.0.1:9941 node apps/app/scripts/history-window-regression.mjs
import assert from "node:assert/strict";

const endpoint = process.env.LEGALWORK_ELECTRON_CDP_URL || "http://127.0.0.1:9823";
const expectedLatest = process.env.LEGALWORK_HISTORY_LAST_MESSAGE || "msg_history_10000";
const tabs = await fetch(`${endpoint}/json/list`).then(response => response.json());
const tab = tabs.find(tab => tab.type === "page" && /^http:\/\/(localhost|127\.0\.0\.1)/.test(tab.url));
assert.ok(tab, "Open the synthetic chat in the Electron dev app first.");
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0;
const pending = new Map();
socket.onmessage = event => {
  const response = JSON.parse(event.data);
  const request = pending.get(response.id);
  if (!request) return;
  pending.delete(response.id); clearTimeout(request.timer);
  if (response.error) request.reject(new Error(response.error.message));
  else request.resolve(response.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = () => evaluate(`(() => {
  const container = document.querySelector('.lw-session-transcript');
  const rows = [...container.querySelectorAll('[data-message-id]')];
  const bounds = container.getBoundingClientRect();
  return { first:rows[0]?.dataset.messageId, last:rows.at(-1)?.dataset.messageId, count:rows.length,
    gap:container.scrollHeight-container.clientHeight-container.scrollTop, x:bounds.left+12, y:bounds.top+bounds.height/2 };
})()`);
const jump = async () => {
  const button = await evaluate(`(() => {const button=Array.from(document.querySelectorAll('button')).find(button=>button.innerText.trim()==='Jump to latest');if(!button)return null;const rect=button.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2};})()`);
  if (button) {
    await call("Input.dispatchMouseEvent", { type: "mousePressed", ...button, button: "left", clickCount: 1 });
    await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...button, button: "left", clickCount: 1 });
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    await pause(100); const current = await state();
    if (current.last === expectedLatest && current.gap <= 1) return;
  }
  assert.fail("Jump to latest did not restore the newest message at the bottom.");
};

try {
  await call("Page.bringToFront"); await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await jump();
  await evaluate(`window.__historyBottomLoading=[];window.__historyBottomObserver?.disconnect();window.__historyBottomObserver=new MutationObserver(()=>{for(const element of document.querySelectorAll('.lw-session-transcript [role=status]'))if(element.innerText)window.__historyBottomLoading.push(element.innerText)});window.__historyBottomObserver.observe(document.querySelector('.lw-session-transcript'),{childList:true,subtree:true,characterData:true})`);
  const bottom = await state();
  for (let attempt=0;attempt<3;attempt++) {
    await call("Input.dispatchMouseEvent", {type:"mouseWheel",x:bottom.x,y:bottom.y,deltaX:0,deltaY:-600});
    await pause(150);
    await call("Input.dispatchMouseEvent", {type:"mouseWheel",x:bottom.x,y:bottom.y,deltaX:0,deltaY:2000});
    await pause(300);
  }
  const bottomLoading = await evaluate("window.__historyBottomObserver.disconnect();window.__historyBottomLoading");
  assert.deepEqual(bottomLoading,[],"Returning to the actual bottom must not load another batch");
  assert.equal((await state()).last,expectedLatest);
  assert.ok((await state()).gap<=1);
  for (const direction of ["older", "older", "older", "older", "newer"]) {
    const position = await state();
    await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: position.x, y: position.y, deltaX: 0, deltaY: direction === "older" ? -40 : 40 });
    await pause(100);
    const before = await evaluate(`(() => {
      const container=document.querySelector('.lw-session-transcript');
      container.scrollTop=${direction === "older" ? "180" : "container.scrollHeight-container.clientHeight-180"};
      const bounds=container.getBoundingClientRect(), rows=[...container.querySelectorAll('[data-message-id]')];
      const anchor=rows.find(row=>row.getBoundingClientRect().bottom>bounds.top && row.getBoundingClientRect().top<bounds.bottom);
      return { id:anchor?.dataset.messageId, offset:anchor?.getBoundingClientRect().top-bounds.top, first:rows[0]?.dataset.messageId, last:rows.at(-1)?.dataset.messageId };
    })()`);
    let after;
    for (let attempt=0;attempt<150;attempt++) {
      await pause(100); after=await state();
      if (after.first!==before.first || after.last!==before.last) break;
    }
    assert.ok(after.first!==before.first || after.last!==before.last, `No ${direction} history loaded`);
    assert.ok(after.count<=420, "The history window exceeded three batches");
    const offset=await evaluate(`(() => {const c=document.querySelector('.lw-session-transcript');const anchor=[...c.querySelectorAll('[data-message-id]')].find(row=>row.dataset.messageId===${JSON.stringify(before.id)});return anchor?anchor.getBoundingClientRect().top-c.getBoundingClientRect().top:null;})()`);
    assert.notEqual(offset,null,"The visible message was evicted");
    assert.ok(Math.abs(offset-before.offset)<=1,"Loading a batch moved the visible message");
    console.log(JSON.stringify({ direction, count:after.count, drift:Math.abs(offset-before.offset) }));
  }
  assert.notEqual((await state()).last,expectedLatest,"The jump test must start with the latest batch unloaded");
  await jump();
  const caches=await evaluate(`window.__owReactQueryClient.getQueryCache().getAll().filter(query=>query.queryKey[0]==='react-session-transcript').map(query=>query.state.data?.length||0)`);
  assert.ok(caches.every(count=>count<=140),"The live cache kept unloaded history");
  console.log("PASS: bounded history, stable scroll anchors, Jump to latest, and no loading at the actual bottom");
} finally { socket.close(); }
