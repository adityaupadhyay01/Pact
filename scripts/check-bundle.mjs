// Scans the built browser bundle (.next/static) for secrets.
// Run after `npm run build`:  node scripts/check-bundle.mjs
// Fails if any server-only variable NAME appears, or if any configured secret VALUE
// from the environment or .env.local appears in a file the browser can download.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dir = join(root, ".next", "static");
if (!existsSync(dir)) {
  console.error("check-bundle: .next/static not found. Run `npm run build` first.");
  process.exit(2);
}

const SECRET_NAMES = ["GEMINI_API_KEY", "CHANNEL3_API_KEY", "PAYPAL_CLIENT_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "EVIDENCE_SECRET"];

// Secret values: from the process environment and from .env.local (never printed).
const values = new Map();
for (const k of SECRET_NAMES) if (process.env[k]) values.set(k, process.env[k]);
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && SECRET_NAMES.includes(m[1]) && m[2].trim().length >= 8) values.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
  }
}

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|css|json|html|txt|map)$/.test(f)) files.push(p);
  }
};
walk(dir);

const problems = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const name of SECRET_NAMES) if (text.includes(name)) problems.push(`${f}: mentions ${name}`);
  for (const [name, value] of values) if (text.includes(value)) problems.push(`${f}: contains the value of ${name}`);
}

console.log(`check-bundle: scanned ${files.length} files, ${values.size} configured secret value(s) checked.`);
if (problems.length) {
  console.error(`check-bundle: FAIL\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log("check-bundle: PASS (no server secrets in the browser bundle)");
