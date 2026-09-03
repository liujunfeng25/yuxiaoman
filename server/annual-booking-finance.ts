import type { AppDatabase } from "./database.js";

type Row = Record<string, unknown>;

export type AnnualBookingProblemFactory = (
  statusCode: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
) => Error;

export type AnnualBookingCompletionFinancials = {
  chargedFen: number;
  pendingAdjustmentFen: number;
  paidFen: number;
  amountDueFen: number;
};

/**
 * Reads the authoritative payment and ledger rows used by annual-inspection
 * completion. Keep this separate from the presentation DTO so every terminal
 * path (station, report publication and driver return) applies the same gate.
 */
export async function annualBookingCompletionFinancials(
  database: AppDatabase,
  bookingId: string,
): Promise<AnnualBookingCompletionFinancials> {
  const paymentRows = await database.prepare<Row>(`
    SELECT amount_fen FROM booking_payments
    WHERE booking_id = ? AND status = 'confirmed'
  `).all(bookingId);
  const ledgerRows = await database.prepare<Row>(`
    SELECT kind, amount_fen, confirmation_status
    FROM booking_ledger_entries WHERE booking_id = ?
  `).all(bookingId);
  const chargedFen = ledgerRows
    .filter((row) => String(row.kind) !== "refund" && String(row.confirmation_status ?? "confirmed") === "confirmed")
    .reduce((sum, row) => sum + Number(row.amount_fen), 0);
  const pendingAdjustmentFen = ledgerRows
    .filter((row) => String(row.kind) === "surcharge" && String(row.confirmation_status) === "pending_owner_confirmation")
    .reduce((sum, row) => sum + Number(row.amount_fen), 0);
  const paidFen = paymentRows.reduce((sum, row) => sum + Number(row.amount_fen), 0);
  return {
    chargedFen,
    pendingAdjustmentFen,
    paidFen,
    amountDueFen: Math.max(0, chargedFen - paidFen),
  };
}

export async function assertAnnualBookingFinancialClosureReady(
  database: AppDatabase,
  bookingId: string,
  problem: AnnualBookingProblemFactory,
): Promise<void> {
  const financials = await annualBookingCompletionFinancials(database, bookingId);
  if (financials.pendingAdjustmentFen > 0) {
    throw problem(
      409,
      "PENDING_SURCHARGE_CONFIRMATION",
      "仍有附加费等待车主确认，确认或作废后才能完成服务",
      { pendingAdjustmentFen: String(financials.pendingAdjustmentFen) },
    );
  }
  if (financials.amountDueFen > 0) {
    throw problem(
      409,
      "OUTSTANDING_PAYMENT",
      "仍有已确认但未支付的费用，完成支付后才能完成服务",
      { amountDueFen: String(financials.amountDueFen) },
    );
  }
  if (financials.paidFen <= 0) {
    throw problem(409, "PAYMENT_REQUIRED", "订单完成支付后才能完成服务");
  }
}
