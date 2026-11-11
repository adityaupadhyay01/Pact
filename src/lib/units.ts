/**
 * Small unit table so requirements and listing facts in different units can be
 * compared deterministically ("1 TB" vs "1000 GB", "2 years" vs "24 months").
 * Anything not in the table is compared only when the units match exactly.
 */

const TABLE: Record<string, { dim: string; factor: number }> = {
  "%": { dim: "percent", factor: 1 },
  percent: { dim: "percent", factor: 1 },
  pct: { dim: "percent", factor: 1 },

  mg: { dim: "mass", factor: 0.001 },
  g: { dim: "mass", factor: 1 },
  gram: { dim: "mass", factor: 1 },
  kg: { dim: "mass", factor: 1000 },
  oz: { dim: "mass", factor: 28.349523125 },
  ounce: { dim: "mass", factor: 28.349523125 },
  lb: { dim: "mass", factor: 453.59237 },
  pound: { dim: "mass", factor: 453.59237 },

  ml: { dim: "volume", factor: 1 },
  l: { dim: "volume", factor: 1000 },
  liter: { dim: "volume", factor: 1000 },
  litre: { dim: "volume", factor: 1000 },
  "fl oz": { dim: "volume", factor: 29.5735295625 },

  mm: { dim: "length", factor: 1 },
  cm: { dim: "length", factor: 10 },
  m: { dim: "length", factor: 1000 },
  in: { dim: "length", factor: 25.4 },
  inch: { dim: "length", factor: 25.4 },
  '"': { dim: "length", factor: 25.4 },
  ft: { dim: "length", factor: 304.8 },

  mb: { dim: "data", factor: 1 },
  gb: { dim: "data", factor: 1000 },
  tb: { dim: "data", factor: 1_000_000 },

  mah: { dim: "charge", factor: 1 },
  wh: { dim: "energy", factor: 1 },
  w: { dim: "power", factor: 1 },
  watt: { dim: "power", factor: 1 },
  v: { dim: "voltage", factor: 1 },
  hz: { dim: "frequency", factor: 1 },
  khz: { dim: "frequency", factor: 1e3 },
  mhz: { dim: "frequency", factor: 1e6 },
  ghz: { dim: "frequency", factor: 1e9 },

  hour: { dim: "time", factor: 1 / 24 },
  hr: { dim: "time", factor: 1 / 24 },
  day: { dim: "time", factor: 1 },
  week: { dim: "time", factor: 7 },
  month: { dim: "time", factor: 30.4375 },
  year: { dim: "time", factor: 365.25 },
  yr: { dim: "time", factor: 365.25 },
};

export function normalizeUnit(u: string | null | undefined): string | null {
  if (!u) return null;
  let s = u.trim().toLowerCase().replace(/\.$/, "");
  if (!s) return null;
  if (s === "percentage") s = "percent";
  if (TABLE[s]) return s;
  // plural forms: "years", "inches", "grams"
  const singular = s.replace(/(es|s)$/, "");
  if (TABLE[singular]) return singular;
  const singular2 = s.replace(/s$/, "");
  if (TABLE[singular2]) return singular2;
  return s;
}

/** Convert `value` in `from` to `to`. Null when the units aren't comparable. */
export function convert(value: number, from: string | null, to: string | null): number | null {
  const f = normalizeUnit(from);
  const t = normalizeUnit(to);
  if (f === t) return value;
  if (!f || !t) return null;
  const a = TABLE[f];
  const b = TABLE[t];
  if (!a || !b || a.dim !== b.dim) return null;
  return (value * a.factor) / b.factor;
}

const NUM = /(-?\d+(?:[.,]\d+)?)\s*(%|fl oz|"|[a-zA-Z]+)?/;
const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, twelve: 12 };

/** Pull the first number (and a trailing unit, if any) out of free text like "70% cocoa" or "2-year". */
export function parseNumber(text: string | null | undefined): { value: number; unit: string | null } | null {
  if (!text) return null;
  const t = text.replace(/(\d),(\d{3})\b/g, "$1$2");
  const m = NUM.exec(t);
  if (m) {
    const unit = m[2] ? normalizeUnit(m[2]) : null;
    return { value: Number(m[1].replace(",", ".")), unit: unit && TABLE[unit] ? unit : null };
  }
  const w = /\b(one|two|three|four|five|six|ten|twelve)[\s-]+([a-z]+)/i.exec(t);
  if (w) {
    const unit = normalizeUnit(w[2]);
    return { value: WORD_NUM[w[1].toLowerCase()], unit: unit && TABLE[unit] ? unit : null };
  }
  return null;
}
