/** All money is integer minor units (e.g. paise); floats never touch an amount. */
export const MAX_ORDER_TOTAL_MINOR = 2_000_000_000; // fits a Postgres INTEGER

export function lineTotalMinor(unitMinor: number, quantity: number): number {
  const total = unitMinor * quantity;
  if (!Number.isSafeInteger(total)) throw new RangeError("Amount overflow");
  return total;
}

export function sumMinor(values: number[]): number {
  let sum = 0;
  for (const v of values) {
    sum += v;
    if (!Number.isSafeInteger(sum)) throw new RangeError("Amount overflow");
  }
  return sum;
}
