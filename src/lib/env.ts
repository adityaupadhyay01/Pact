/**
 * Server configuration checks. Values are never logged or returned: only the
 * names of variables that are missing or inconsistent.
 */

/** Required configuration is missing; the operation is refused with a clear message. */
export class ConfigError extends Error {}

const has = (k: string) => Boolean(process.env[k]?.trim());
export const isProduction = () => process.env.NODE_ENV === "production";

export interface ConfigReport {
  ok: boolean;
  problems: string[];
}

export function configReport(): ConfigReport {
  const problems: string[] = [];
  const prod = isProduction();

  if (prod && !has("EVIDENCE_SECRET")) problems.push("EVIDENCE_SECRET is required in production (receipt signing key).");
  if (has("EVIDENCE_SECRET") && (process.env.EVIDENCE_SECRET ?? "").length < 32) {
    problems.push("EVIDENCE_SECRET should be at least 32 characters.");
  }
  if (has("SUPABASE_URL") !== has("SUPABASE_SERVICE_ROLE_KEY")) problems.push("Set both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  if (prod && !has("SUPABASE_URL") && process.env.PACT_ALLOW_MEMORY_STORAGE !== "true") {
    problems.push("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production (sessions must persist).");
  }
  if (has("PAYPAL_CLIENT_ID") !== has("PAYPAL_CLIENT_SECRET")) problems.push("Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.");
  if (has("PAYPAL_API_BASE") && !/^https:\/\/api(-m)?\.sandbox\.paypal\.com\/?$/.test(process.env.PAYPAL_API_BASE ?? "")) {
    problems.push("PAYPAL_API_BASE must be the PayPal Sandbox API.");
  }
  // Anything NEXT_PUBLIC_ is shipped to every browser.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("NEXT_PUBLIC_") && /SECRET|SERVICE_ROLE|API_KEY|TOKEN|PASSWORD|PRIVATE/i.test(k)) {
      problems.push(`${k} looks like a secret but is exposed to the browser (NEXT_PUBLIC_).`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Throws ConfigError when production configuration is unsafe. */
export function requireSafeConfig() {
  const r = configReport();
  if (!r.ok && isProduction()) {
    throw new ConfigError(`PACT isn't fully configured on this server: ${r.problems.join(" ")}`);
  }
}
