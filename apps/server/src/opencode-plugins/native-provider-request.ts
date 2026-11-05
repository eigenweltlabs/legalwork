/** Rewrites only a native model request draft, preserving credentials, cancellation
 * and saved provider-native history. Unchanged bodies retain their original bytes. */
export async function nativeProviderRequest(request:Request,rewrite:(body:string,request:Request)=>string|null):Promise<Request>{
  if(request.method!=="POST")return request;
  const body=rewrite(await request.clone().text(),request);if(body===null)return request;
  const headers=new Headers(request.headers);headers.delete("content-length");
  return new Request(request,{headers,body});
}
