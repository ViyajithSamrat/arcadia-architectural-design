/**
 * Money is handled as integer minor units (hundredths of the currency unit) so that
 * no floating-point rounding can change a total. This matches the numeric(12,2)
 * columns in the database. Currencies with a different exponent are out of scope
 * until the business confirms a currency (11_DECISIONS_AND_OPEN_QUESTIONS.md).
 */

/** Converts a decimal amount (number or numeric string from the database) to minor units. */
export function toMinor(amount: number | string): number {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) throw new RangeError("amount is not a finite number");
  return Math.round(n * 100);
}

/** Formats minor units for a numeric(12,2) column, for example 123456 -> "1234.56". */
export function minorToDecimal(minor: number): string {
  if (!Number.isInteger(minor)) throw new RangeError("minor units must be an integer");
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Display only. Never used to calculate. */
export function formatMoney(minor: number, currency: string): string {
  const locale = currency === "INR" ? "en-IN" : "en";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${currency} ${minorToDecimal(minor)}`;
  }
}
