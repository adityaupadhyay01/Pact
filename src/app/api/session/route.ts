import { body, handle } from "@/lib/http";
import { startSession } from "@/lib/pact";

export async function POST(req: Request) {
  return handle(async () => {
    const { text } = await body<{ text?: string }>(req);
    return startSession(String(text ?? ""));
  });
}
