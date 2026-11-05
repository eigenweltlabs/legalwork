// Benchmark-only UI focus. Prompt submission still uses the application's
// actual composer actions; this clicks the same chat tab a user would click.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import { privateWrite } from "./private-write.mjs";

export async function startBenchmarkFocus({ app, BrowserWindow, root, rendererOrigin }) {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, {"content-type":"application/json"}); response.end(JSON.stringify(value)); };
    const supplied = Buffer.from(String(request.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401,{error:"Unauthorized"});
    if (request.method !== "POST" || !["/focus-chat", "/install-skill-files"].includes(request.url)) return send(404,{error:"Unknown benchmark focus action"});
    try {
      const chunks=[];for await(const chunk of request)chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const {sessionID}=body;
      if(request.url==="/focus-chat" && (typeof sessionID!=="string" || !sessionID)) return send(400,{error:"Exact sessionID is required"});
      if(request.url==="/install-skill-files") {
        const args=body.args;
        const allowed=["SKILL.md","resources/renewal-archive.md"];
        if(!Array.isArray(args) || args.length!==4 || args[0]!=="" || args[1]!=="benchmark-portable-renewal-review" || args[3]?.overwrite!==false || !Array.isArray(args[2]) || args[2].length!==2 || new Set(args[2].map(file=>file.path)).size!==2 || args[2].some(file=>!allowed.includes(file.path) || file.executable!==false || typeof file.contentBase64!=="string" || Buffer.from(file.contentBase64,"base64").toString("base64")!==file.contentBase64)) return send(400,{error:"Only the two frozen regular global fixture files with overwrite:false are permitted"});
      }
      const window=BrowserWindow.getAllWindows().find(window=> {
        if(window.isDestroyed())return false;
        try{return new URL(window.webContents.getURL()).origin===rendererOrigin;}catch{return false;}
      });
      if(!window)return send(409,{error:"Owned benchmark renderer is not ready"});
      if(request.url==="/install-skill-files") {
        const result=await window.webContents.executeJavaScript(`window.__LEGALWORK_ELECTRON__.invokeDesktop("installSkillFiles", ...${JSON.stringify(body.args)})`);
        return send(200,{result,mechanism:"ordinary-desktop-installSkillFiles-ipc",inferenceCalls:0});
      }
      const focused=await window.webContents.executeJavaScript(`(() => {
        const id = ${JSON.stringify(`chat:${sessionID}`)};
        const tab = [...document.querySelectorAll("[data-panel-tab-id]")].filter(tab => tab.dataset.panelTabId === id)
          .map(tab => tab.querySelector("button[aria-pressed]"))
          .find(tab => { if(!tab) return false; const rect=tab.getBoundingClientRect(); return rect.width>0 && rect.height>0 && rect.right>0 && rect.bottom>0 && rect.left<innerWidth && rect.top<innerHeight; });
        if (!tab) return false;
        tab.click();
        return true;
      })()`);
      send(200,{focused,mechanism:"actual-chat-tab-dom-click",inferenceCalls:0});
    } catch { send(500,{error:"Benchmark chat focus failed; no model dispatch was made"}); }
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  await privateWrite(join(root,"electron/legalwork-benchmark-ui-control.json"),{baseUrl:`http://127.0.0.1:${server.address().port}`,token});
  app.once("will-quit",()=>{server.closeAllConnections();server.close();});
}
