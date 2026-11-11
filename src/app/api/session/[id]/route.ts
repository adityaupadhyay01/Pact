import type { NextRequest } from "next/server";
import { handle } from "@/lib/http";
import { getView } from "@/lib/pact";

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/session/[id]">) {
  const { id } = await ctx.params;
  return handle(() => getView(id));
}
