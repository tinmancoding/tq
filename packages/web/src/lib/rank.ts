// Fractional indexing for board ordering. Compact midpoint-string algorithm
// (keys are base-62 fractions in (0,1)); generates a key strictly between two
// neighbours, or before/after when an endpoint is null. Adapted from the
// well-known `fractional-indexing` midpoint approach (MIT).

const DIGITS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = DIGITS[0];

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new Error(`rankBetween: a (${a}) must be < b (${b})`);
  }
  if (a.slice(-1) === ZERO || (b && b.slice(-1) === ZERO)) {
    throw new Error("rankBetween: keys must not end in the zero digit");
  }
  if (b !== null) {
    // Carry the longest common prefix, then subdivide the remainder.
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) {
    const mid = Math.round(0.5 * (digitA + digitB));
    return DIGITS[mid]!;
  }
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

/** A board_rank strictly ordered between `a` and `b` (either may be null). */
export function rankBetween(a: string | null, b: string | null): string {
  return midpoint(a ?? "", b);
}
