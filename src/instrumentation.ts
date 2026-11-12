/**
 * Runs once when a server instance starts. Reports unsafe or missing
 * configuration by variable name (never by value), so a misconfigured
 * deployment is obvious in the logs. Requests that need the missing pieces
 * are refused with a clear error (see src/lib/env.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { configReport, isProduction } = await import("./lib/env");
  const r = configReport();
  if (!r.ok) {
    const log = isProduction() ? console.error : console.warn;
    log(`[pact] configuration problems:\n- ${r.problems.join("\n- ")}`);
  }
}
