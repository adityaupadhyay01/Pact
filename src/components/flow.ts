import { formatMoney } from "@/lib/money";
import { getListing, type Listing } from "@/lib/marketplace";
import { quoteTotal } from "@/lib/quote";
import type { Requirements } from "@/lib/contract";
import type { Evaluation } from "@/lib/rules";
import type { ListingResult } from "@/lib/store";
import type { SessionView } from "./api";

export interface Pick {
  listing: Listing;
  result: ListingResult;
  evaluation: Evaluation;
  /** All-in price at checkout. */
  total: number;
}

export interface Analysis {
  /** The product the user's shopping agent chose, and what it told the user. */
  agent: (Pick & { claim: string; reasoning: string[] }) | null;
  /** PACT's best verified match, when it is a different product from the agent's pick. */
  alternative: Pick | null;
  /** The product PACT verifies in step 3: the agent's pick, or PACT's match if the agent found nothing. */
  subject: Pick | null;
  listingCount: number;
}

/** Turns the raw search result into the story the UI tells: agent picks, PACT checks, user decides. */
export function analyse(session: SessionView): Analysis | null {
  const s = session.search;
  if (!s) return null;

  const pick = (listingId: string, evaluation?: Evaluation): Pick | null => {
    const listing = getListing(listingId);
    const result = s.results.find((r) => r.listingId === listingId);
    if (!listing || !result) return null;
    return { listing, result, evaluation: evaluation ?? result.evaluation, total: quoteTotal(listing.checkout) };
  };

  const naive = s.unprotected;
  const agentPick = naive ? pick(naive.listingId, naive.evaluation) : null;
  const agent = naive && agentPick ? { ...agentPick, claim: naive.claimSummary, reasoning: naive.reasoning } : null;
  const rec = s.recommendedId ? pick(s.recommendedId) : null;
  const subject = agent ?? rec;
  const alternative = rec && rec.listing.id !== subject?.listing.id ? rec : null;
  return { agent, alternative, subject, listingCount: s.results.length };
}

const fmtStorage = (gb: number) => (gb >= 1000 ? `${gb / 1000}TB` : `${gb}GB`);
const fmtWarranty = (m: number) => (m % 12 === 0 ? `${m / 12}-year` : `${m}-month`);

/** The buyer's must-haves as short phrases, e.g. ["16GB+ RAM", "up to $900.00"]. */
export function requirementTerms(r: Requirements): string[] {
  return [
    r.condition === "new" ? "new" : "any condition",
    r.ramGbMin !== null ? `${r.ramGbMin}GB+ RAM` : null,
    r.storageGbMin !== null ? `${fmtStorage(r.storageGbMin)}+ storage` : null,
    r.warrantyMonthsMin !== null ? `${fmtWarranty(r.warrantyMonthsMin)} warranty` : null,
    `up to ${formatMoney(r.maxTotal, r.currency)} all-in`,
  ].filter((x): x is string => Boolean(x));
}

/** "Hidden instructions and Total price" */
export function joinLabels(labels: string[]): string {
  const l = labels.map((x) => x.toLowerCase());
  if (l.length <= 1) return l.join("");
  return `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}
