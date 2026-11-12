import { connection } from "next/server";
import { geminiConfigured, geminiModel } from "@/lib/ai";
import { channel3Configured } from "@/lib/catalog/channel3";
import { configReport } from "@/lib/env";
import { paypalMode } from "@/lib/paypal";
import { storageMode } from "@/lib/store";

/**
 * What this server is configured to use. "Configured" is not "working":
 * a service is shown as live in a session only after a real call succeeded.
 * Returns no secret values; `problems` names missing variables only.
 */
export async function GET() {
  // Read env at request time, not at build time.
  await connection();
  const report = configReport();
  return Response.json(
    {
      paypal: paypalMode(),
      // The client ID is public by design; the secret never leaves the server.
      paypalClientId: paypalMode() === "sandbox" ? process.env.PAYPAL_CLIENT_ID : null,
      ai: geminiConfigured(),
      aiModel: geminiConfigured() ? geminiModel() : null,
      catalog: channel3Configured(),
      catalogRegion: "US merchants, USD",
      storage: storageMode(),
      configOk: report.ok,
      problems: report.problems,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
