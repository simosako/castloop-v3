import { DurableObject } from "cloudflare:workers";
import { initializeSchema } from "./storage";

/** Per-show storage host; management routes are added with their acceptance checks. */
export class ShowDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => initializeSchema(ctx.storage));
  }
}

export default {
  fetch(): Response {
    return Response.json({ error: "Management API is not implemented" }, { status: 503 });
  },
};
