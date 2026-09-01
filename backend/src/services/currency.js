/**
 * Currency utilities
 *
 * Model prices (input_price / output_price) are stored and computed in USD per 1M tokens.
 * User/Workspace balance, recharge and billing are kept in the user's own currency (CNY by default).
 * This module converts USD cost into the target currency using the configured exchange rate.
 */

const db = require('../config/database');
const cacheService = require('./cache');
const cacheManager = require('./cache-manager');

const DEFAULT_RATE = 7.25;
const CACHE_TTL_SECONDS = 60;

let memoryRate = null;
let memoryRateAt = 0;

async function getExchangeRate() {
  const now = Date.now();
  if (memoryRate != null && now - memoryRateAt < CACHE_TTL_SECONDS * 1000) {
    return memoryRate;
  }
  try {
    const cached = await cacheService.get('exchange_rate');
    if (cached != null) {
      const parsed = parseFloat(cached);
      if (isFinite(parsed) && parsed > 0) {
        memoryRate = parsed;
        memoryRateAt = now;
        return memoryRate;
      }
    }
  } catch (e) {}

  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'exchange_rate'");
    const parsed = parseFloat(row?.value);
    if (isFinite(parsed) && parsed > 0) {
      try { await cacheManager.set('exchange_rate', parsed, CACHE_TTL_SECONDS, { tags: ['currency'] }); } catch (e) {}
      memoryRate = parsed;
      memoryRateAt = now;
      return memoryRate;
    }
  } catch (e) {
    console.error('[Currency] Failed to load exchange_rate:', e?.message);
  }

  return DEFAULT_RATE;
}

async function invalidateExchangeRate() {
  memoryRate = null;
  memoryRateAt = 0;
  try { await cacheManager.invalidateTags(['currency']); } catch (e) {}
}

/**
 * Convert a USD cost into the target currency.
 * @param {number} costUSD
 * @param {string} targetCurrency - 'CNY' | 'USD' | other; defaults to CNY
 * @param {number} [rate]
 * @returns {number}
 */
function convertFromUSD(costUSD, targetCurrency, rate) {
  const currency = (targetCurrency || 'CNY').toUpperCase();
  if (currency === 'USD') return costUSD || 0;
  const r = rate && isFinite(rate) && rate > 0 ? rate : (memoryRate || DEFAULT_RATE);
  return (costUSD || 0) * r;
}

/**
 * Convert a cost from target currency back to USD.
 * @param {number} costLocal
 * @param {string} sourceCurrency
 * @param {number} [rate]
 * @returns {number}
 */
function convertToUSD(costLocal, sourceCurrency, rate) {
  const currency = (sourceCurrency || 'CNY').toUpperCase();
  if (currency === 'USD') return costLocal || 0;
  const r = rate && isFinite(rate) && rate > 0 ? rate : (memoryRate || DEFAULT_RATE);
  if (!r) return costLocal || 0;
  return (costLocal || 0) / r;
}

/**
 * Format a numeric value to a fixed number of decimals without trailing zeros.
 * @param {number} value
 * @param {number} maxDecimals
 * @returns {string}
 */
function trimDecimals(value, maxDecimals = 4) {
  if (value == null || isNaN(value)) return '0';
  const fixed = Number(value).toFixed(maxDecimals);
  return fixed.replace(/\.?0+$/, '');
}

module.exports = {
  getExchangeRate,
  invalidateExchangeRate,
  convertFromUSD,
  convertToUSD,
  trimDecimals,
  DEFAULT_RATE
};
