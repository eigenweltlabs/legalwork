import type { Plugin } from "@opencode/plugin";
import type { OpenCodeEvent } from "@opencode/client";

/** Native streams are live-only. Reconnect without retaining a foreign SDK runtime. */
export function nativeEvents(ctx: Plugin.Context, receive: (event: OpenCodeEvent) => Promise<void> | void, reconnect?: () => void): () => void {
  const controller = new AbortController();
  void (async()=>{
    let delay=100;
    while(!controller.signal.aborted){
      try{
        for await(const event of ctx.event.subscribe({signal:controller.signal})){
          delay=100;
          await receive(event);
        }
      }catch{ if(controller.signal.aborted)break; }
      if(controller.signal.aborted)break;
      reconnect?.();
      await new Promise<void>(resolve=>{
        const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener("abort",finish);resolve();};
        const timer=setTimeout(finish,delay);controller.signal.addEventListener("abort",finish,{once:true});
      });
      delay=Math.min(2000,delay*2);
    }
  })();
  return ()=>controller.abort();
}
