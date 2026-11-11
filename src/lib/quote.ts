import { z } from "zod";
import { fromCents, toCents } from "./money";

/** The full financial commitment shown at checkout. */
export const CheckoutQuoteSchema = z.object({
  currency: z.string().length(3),
  itemPrice: z.number().nonnegative(),
  shipping: z.number().nonnegative(),
  tax: z.number().nonnegative(),
  fees: z.array(z.object({ label: z.string(), amount: z.number().nonnegative() })),
  /** e.g. "monthly protection plan $9.99" — any recurring commitment. */
  recurring: z.string().nullable(),
});
export type CheckoutQuote = z.infer<typeof CheckoutQuoteSchema>;

export function quoteTotalCents(q: CheckoutQuote): number {
  return (
    toCents(q.itemPrice) +
    toCents(q.shipping) +
    toCents(q.tax) +
    q.fees.reduce((s, f) => s + toCents(f.amount), 0)
  );
}

export const quoteTotal = (q: CheckoutQuote) => fromCents(quoteTotalCents(q));
export const feesTotal = (q: CheckoutQuote) =>
  fromCents(q.fees.reduce((s, f) => s + toCents(f.amount), 0));
