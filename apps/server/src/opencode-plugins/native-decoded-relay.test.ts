import { expect, test } from "bun:test";
import { brotliCompressSync } from "node:zlib";
import { nativeDecodedRelayResponse } from "./native-decoded-relay.test-support.js";
test("decoded relay preserves all decompressed bytes while removing stale wire encoding/framing", async()=>{
  const body=Buffer.concat([Buffer.from("complete-relay-boundary"),Buffer.alloc(128*1024+7,0x91)]), compressed=brotliCompressSync(body);
  const upstream=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response(compressed,{headers:{"content-encoding":"br","content-length":String(compressed.length),"content-type":"application/octet-stream"}})});
  try{const response=await fetch(upstream.url),bytes=await response.bytes();expect(Buffer.from(bytes)).toEqual(body);const forwarded=nativeDecodedRelayResponse(response,bytes);expect(forwarded.headers.get("content-encoding")).toBeNull();expect(forwarded.headers.get("content-length")).toBeNull();expect(Buffer.from(await forwarded.bytes())).toEqual(body);}
  finally{upstream.stop(true);}
});
test("decoded relay supports bodyless native statuses and drops hop-only headers",async()=>{
  for(const status of [204,205,304]){const response=nativeDecodedRelayResponse(new Response(null,{status,headers:{connection:"keep-alive","transfer-encoding":"chunked"}}),new Uint8Array());expect(response.status).toBe(status);expect(response.body).toBeNull();expect(response.headers.get("connection")).toBeNull();expect(response.headers.get("transfer-encoding")).toBeNull();}
});
