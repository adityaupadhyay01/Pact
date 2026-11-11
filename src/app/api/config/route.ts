import { connection } from "next/server";
import { geminiConfigured, geminiModel } from "@/lib/ai";
import { channel3Configured } from "@/lib/catalog/channel3";
import { paypalMode } from "@/lib/paypal";
import { storageMode } from "@/lib/store";

/**
 * What this server is configured to use. "Configured" is not "working":
 * a service is shown as live in a session only after a real call succeeded.
 */
export async function GET() {
  // Read env at request time, not at build time.
  await connection();
  return Response.json({
    paypal: paypalMode(),
    // The client ID is public by design; the secret never leaves the server.
    paypalClientId: paypalMode() === "sandbox" ? process.env.PAYPAL_CLIENT_ID : null,
    ai: geminiConfigured(),
    aiModel: geminiConfigured() ? geminiModel() : null,
    catalog: channel3Configured(),
    storage: storageMode(),
  });
}
