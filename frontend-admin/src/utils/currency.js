/**
 * Format a monetary value for display.
 * - Treats values extremely close to zero (including negative zero) as 0,
 *   so the UI never shows "¥-0.00" due to floating-point rounding.
 */
export function formatCurrency(value, digits = 2) {
  const n = Number(value) || 0;
  // Avoid displaying -0.00 when the raw value is a tiny negative residual.
  const normalized = Math.abs(n) < 0.5 * Math.pow(10, -digits) ? 0 : n;
  return normalized.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
