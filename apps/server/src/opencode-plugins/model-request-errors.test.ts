import { expect, test } from "bun:test";
import { checkModelResponse } from "./model-request-errors.js";

test("transport rejection records byte counts without copying provider content",async()=>{
  const response=Response.json({error:{code:"request_too_large",max_request_bytes:31457280,message:"private provider content"}},{status:413});
  await expect(checkModelResponse(response,32000000)).rejects.toThrow("HTTP 413; request_bytes=32000000; max_request_bytes=31457280");
});
test("HTML gateway errors stop as transport failures",async()=>{
  await expect(checkModelResponse(new Response("<html>too large</html>",{status:413}))).rejects.toThrow("request_too_large");
});
test("token overflow remains eligible for compaction, and successful SSE stays streaming",async()=>{
  const overflow=await checkModelResponse(Response.json({error:{code:"context_length_exceeded"}},{status:413}));
  expect(overflow.status).toBe(413);expect(await overflow.json()).toEqual({error:{code:"context_length_exceeded"}});
  const response=new Response("data: fixture\n\n",{headers:{"content-type":"text/event-stream"}});
  expect(await checkModelResponse(response)).toBe(response);expect(await response.text()).toBe("data: fixture\n\n");
});
