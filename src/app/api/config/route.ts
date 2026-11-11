import { aiEnabled } from "@/lib/ai";
import { paypalMode } from "@/lib/paypal";
import { storageMode } from "@/lib/store";

import { connection } from "next/server";

export async function GET() {
  // Read env at request time, not at build time.
  await connection();
  return Response.json({
    paypal: paypalMode(),
    // The client ID is public by design; the secret never leaves the server.
    paypalClientId: paypalMode() === "sandbox" ? process.env.PAYPAL_CLIENT_ID : null,
    ai: aiEnabled(),
    storage: storageMode(),
  });
}
