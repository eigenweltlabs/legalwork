import { z } from "zod";
import { ApiError } from "../errors.js";
import { addRoute, type Route, type RequestContext } from "../routes/registry.js";
import { AssistantPush, RegistrationSchema } from "./service.js";

export function registerPushRoutes(routes: Route[], push: AssistantPush,
  readBody: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>) {
  const identity = (ctx: RequestContext) => {
    if (!ctx.actor?.tokenHash) throw new ApiError(401, "push_auth", "Sign in to register notifications.");
    const id = z.uuid().safeParse(ctx.params.id);
    if (!id.success) throw new ApiError(400, "push_id", "Invalid notification registration.");
    return { id: id.data, owner: ctx.actor.tokenHash };
  };
  addRoute(routes, "GET", "/assistant/push", "client", async () => Response.json(push.status()));
  addRoute(routes, "PUT", "/assistant/push/devices/:id", "client", async ctx => {
    const { id, owner } = identity(ctx);
    const parsed = RegistrationSchema.safeParse(await readBody(ctx.request, 4096));
    if (!parsed.success) throw new ApiError(400, "push_registration", "Invalid notification registration.");
    return Response.json(push.register(id, owner, parsed.data));
  });
  addRoute(routes, "DELETE", "/assistant/push/devices/:id", "client", async ctx => {
    const { id, owner } = identity(ctx); push.remove(id, owner); return Response.json({ removed: true });
  });
  addRoute(routes, "POST", "/assistant/push/devices/:id/test", "client", async ctx => {
    const { id, owner } = identity(ctx);
    const input = z.object({ delaySeconds: z.number().int().min(5).max(120).default(45) }).safeParse(await readBody(ctx.request, 1000));
    if (!input.success) throw new ApiError(400, "push_delay", "Choose a test delay from 5 to 120 seconds.");
    return Response.json(push.test(id, owner, input.data.delaySeconds));
  });
}
