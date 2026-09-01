/**
 * Normalize a monetary balance value.
 * - Rounds to the currency precision used by the DB (4 decimals).
 * - Treats values extremely close to zero (including -0) as exactly 0,
 *   so the frontend never displays "-0.00" due to floating point rounding.
 */
function normalizeBalance(value) {
  const n = Number(value) || 0;
  const rounded = Math.round(n * 10000) / 10000;
  // Object.is catches the signed zero case (-0 === 0 is true, but Object.is(-0, 0) is false)
  if (Object.is(rounded, -0) || Math.abs(rounded) < 0.0000001) {
    return 0;
  }
  return rounded;
}

module.exports = { normalizeBalance };
