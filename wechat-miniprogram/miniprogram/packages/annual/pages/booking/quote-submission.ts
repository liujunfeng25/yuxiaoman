import type { BookingQuote } from "../../../../types";

type QuoteFailure = Error & { code?: string };

export type FreshQuoteBookingResult<T> = {
  booking: T;
  quote: BookingQuote;
};

export class QuoteRefreshError extends Error {
  code: "QUOTE_SNAPSHOT_MISSING" | "QUOTE_REFRESH_REUSED_SNAPSHOT";

  constructor(code: QuoteRefreshError["code"], message: string) {
    super(message);
    this.name = "QuoteRefreshError";
    this.code = code;
  }
}

export function isQuoteExpired(error: unknown): boolean {
  return error instanceof Error && (error as QuoteFailure).code === "QUOTE_EXPIRED";
}

export function bookingQuoteAmountChanged(before: BookingQuote, after: BookingQuote): boolean {
  return Number(before.inspectionFeeFen || 0) !== Number(after.inspectionFeeFen || 0)
    || Number(before.valetFeeFen || 0) !== Number(after.valetFeeFen || 0)
    || Number(before.serviceFeeFen || 0) !== Number(after.serviceFeeFen || 0);
}

function snapshotId(quote: BookingQuote): string {
  const id = String(quote.quoteSnapshotId || "");
  if (!id) throw new QuoteRefreshError("QUOTE_SNAPSHOT_MISSING", "报价刷新后仍缺少快照编号，请重新提交");
  return id;
}

/**
 * Submission always starts from a newly fetched server quote. If that snapshot
 * expires between quote and create, fetch exactly one more snapshot and retry.
 * Reusing the rejected id is treated as a refresh failure rather than looping.
 */
export async function createBookingWithFreshQuote<T>(
  refreshQuote: () => Promise<BookingQuote>,
  createBooking: (quote: BookingQuote) => Promise<T>,
): Promise<FreshQuoteBookingResult<T>> {
  let quote = await refreshQuote();
  let currentSnapshotId = snapshotId(quote);

  try {
    return { booking: await createBooking(quote), quote };
  } catch (error) {
    if (!isQuoteExpired(error)) throw error;
  }

  const rejectedSnapshotId = currentSnapshotId;
  quote = await refreshQuote();
  currentSnapshotId = snapshotId(quote);
  if (currentSnapshotId === rejectedSnapshotId) {
    throw new QuoteRefreshError("QUOTE_REFRESH_REUSED_SNAPSHOT", "报价刷新未生成新快照，请重新提交");
  }

  return { booking: await createBooking(quote), quote };
}
