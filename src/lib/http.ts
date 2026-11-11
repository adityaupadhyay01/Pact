import "server-only";
import { ZodError } from "zod";
import { PactError } from "./pact";

export async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (err) {
    if (err instanceof PactError) return Response.json({ error: err.message }, { status: err.status });
    if (err instanceof ZodError) return Response.json({ error: "Invalid input", issues: err.issues }, { status: 400 });
    console.error(err);
    return Response.json({ error: (err as Error).message ?? "Unexpected error" }, { status: 500 });
  }
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
