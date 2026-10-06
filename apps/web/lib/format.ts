/** Amounts are integer minor units (paise); format only at the edge, never compute with the result. */
export function formatMoney(minor: number, currency = "INR"): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minor / 100);
}

export const TERMINAL_STATUSES = ["CONFIRMED", "CANCELLED"] as const;
export const isTerminal = (status: string) => (TERMINAL_STATUSES as readonly string[]).includes(status);

export const STATUS_LABEL: Record<string, string> = {
  PENDING: "Reserving your items",
  PAYMENT_PENDING: "Waiting for payment",
  CONFIRMED: "Confirmed",
  CANCELLED: "Cancelled"
};
