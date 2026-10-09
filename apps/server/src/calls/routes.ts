import { ApiError } from "../errors.js";
import { addRoute, type Route, type RequestContext } from "../routes/registry.js";
import { AssistantCalls, CallOffer, CallWork } from "./service.js";
export function registerCallRoutes(routes: Route[], calls: AssistantCalls, readBody: (request: Request, max: number) => Promise<Record<string, unknown>>, writable: (ctx: RequestContext) => void) {
  const owner = (ctx: RequestContext) => {
    writable(ctx);
    if (!ctx.actor?.tokenHash) throw new ApiError(401, "call_auth", "Sign in to call your assistant.");
    return ctx.actor.tokenHash;
  };
  addRoute(routes, "GET", "/assistant/calls/capability", "client", async ctx => { owner(ctx); return Response.json(await calls.capability()); });
  addRoute(routes, "POST", "/assistant/calls", "client", async ctx => {
    const identity = owner(ctx);
    const body = CallOffer.safeParse(await readBody(ctx.request, 110000));
    if (!body.success) throw new ApiError(400, "call_offer", "Invalid call request.");
    return Response.json(await calls.create(identity, body.data));
  });
  addRoute(routes, "GET", "/assistant/calls/:id", "client", async ctx => Response.json(await calls.state(ctx.params.id, owner(ctx))));
  addRoute(routes, "POST", "/assistant/calls/:id/work", "client", async ctx => {
    const identity = owner(ctx);
    const body = CallWork.safeParse(await readBody(ctx.request, 14000));
    if (!body.success) throw new ApiError(400, "call_work", "Invalid call request.");
    return Response.json(await calls.work(ctx.params.id, identity, body.data));
  });
  addRoute(routes, "DELETE", "/assistant/calls/:id", "client", async ctx => { calls.end(ctx.params.id, owner(ctx)); return Response.json({ ended: true }); });
}
