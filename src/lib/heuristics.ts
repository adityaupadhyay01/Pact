import type { Requirements } from "./contract";
import { emptyFacts, type Condition, type ListingFacts } from "./facts";

/**
 * Deterministic fallback parsers. Used when no Gemini key is configured or the
 * model call fails, so the app always runs. Quotes are exact substrings.
 */

const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const num = (s: string) => WORD_NUM[s.toLowerCase()] ?? Number(s);

function storageGb(n: string, unit: string) {
  const v = Number(n);
  return unit.toUpperCase() === "TB" ? Math.round(v * 1000) : Math.round(v);
}

const RAM_RE = /(\d+)\s*GB\s*(?:of\s+)?(?:DDR\d\w*\s+|LPDDR\d\w*\s+|unified\s+)?(?:RAM|memory)\b/i;
const STORAGE_RE = /(\d+(?:\.\d+)?)\s*(TB|GB)\s*(?:of\s+)?(?:NVMe\s+|PCIe\s+|M\.2\s+)?(?:SSD|storage)\b/i;
const WARRANTY_RES = [
  /(\d+|one|two|three|four|five)[-\s](year|month)s?\s+(?:limited\s+|manufacturer\s+|manufacturer's\s+|seller\s+|full\s+)*warranty/i,
  /warranty\s*:\s*(\d+|one|two|three|four|five)[-\s]?(year|month)s?/i,
];
const NO_WARRANTY_RE = /\b(no warranty|sold as[- ]is|without warranty)\b/i;

export function parseRequestHeuristic(text: string): Requirements {
  const ram = RAM_RE.exec(text);
  const storage = STORAGE_RE.exec(text);
  let warrantyMonths: number | null = null;
  for (const re of WARRANTY_RES) {
    const m = re.exec(text);
    if (m) {
      warrantyMonths = num(m[1]) * (m[2].toLowerCase() === "year" ? 12 : 1);
      break;
    }
  }
  const budget =
    /(?:max(?:imum)?(?:\s+price)?|under|budget(?:\s+of)?|up to|no more than|below|at most|within)\s*(?:is|of|:)?\s*(?:US)?[$€₹]?\s?(\d[\d,]*(?:\.\d+)?)/i.exec(text) ??
    /[$€₹]\s?(\d[\d,]*(?:\.\d+)?)/.exec(text);
  const currency = /€|\beur\b/i.test(text) ? "EUR" : /₹|\binr\b|\brs\.?\b/i.test(text) ? "INR" : "USD";
  const condition = /\b(refurbished|renewed|used|pre-owned|any condition)\b/i.test(text) ? "any" : "new";

  return {
    category: "laptop",
    ramGbMin: ram ? Number(ram[1]) : null,
    storageGbMin: storage ? storageGb(storage[1], storage[2]) : null,
    warrantyMonthsMin: warrantyMonths,
    condition,
    maxTotal: budget ? Number(budget[1].replace(/,/g, "")) : 1000,
    currency,
    preferences: [],
  };
}

export function extractFactsHeuristic(visible: string): ListingFacts {
  const facts = emptyFacts();

  const ram = RAM_RE.exec(visible);
  if (ram) facts.ramGb = { value: Number(ram[1]), quote: ram[0] };

  const storage = STORAGE_RE.exec(visible);
  if (storage) facts.storageGb = { value: storageGb(storage[1], storage[2]), quote: storage[0] };

  const none = NO_WARRANTY_RE.exec(visible);
  if (none) {
    facts.warrantyMonths = { value: 0, quote: none[0] };
  } else {
    for (const re of WARRANTY_RES) {
      const m = re.exec(visible);
      // Skip optional add-on warranties ("add a 2-year warranty for +$129").
      const before = m ? visible.slice(Math.max(0, m.index - 25), m.index).toLowerCase() : "";
      if (m && !/(add|optional|upgrade|extend)/.test(before)) {
        facts.warrantyMonths = {
          value: num(m[1]) * (m[2].toLowerCase() === "year" ? 12 : 1),
          quote: m[0],
        };
        break;
      }
    }
  }

  const used = /\b(certified\s+)?(refurbished|renewed|open[- ]box|pre-owned|used)\b/i.exec(visible);
  if (used) {
    const w = used[2].toLowerCase();
    const value: Condition =
      w === "open-box" || w === "open box" ? "open-box" : w === "used" || w === "pre-owned" ? "used" : "refurbished";
    facts.condition = { value, quote: used[0] };
  } else {
    const fresh = /\b(brand[- ]new|condition\s*:\s*new|factory[- ]sealed|new in box|sealed new)\b/i.exec(visible);
    if (fresh) facts.condition = { value: "new", quote: fresh[0] };
  }

  return facts;
}
