import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

/**
 * Format a monetary amount for display.
 * - Always shows exactly `digits` decimal places so trailing zeros are preserved
 *   (e.g. 1.00 stays "1.00", 1.50 stays "1.50").
 */
export function fmtMoney(v, digits = 2) {
  const n = Number(v);
  if (!isFinite(n)) return `0.${'0'.repeat(digits)}`;
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

export function currencySymbol(currency) {
  return currency === 'USD' ? '$' : '¥';
}

export function formatAmountInput(value) {
  // 仅保留数字与最多两位小数
  const match = String(value).match(/^\d*(\.\d{0,2})?/);
  return match ? match[0] : '';
}
