/**
 * Web chat configuration service.
 * Reads/writes chat settings from the database settings table,
 * falling back to environment variables when not configured.
 */
const db = require('../config/database');

const KEYS = {
  chatEnabled: 'chat_enabled',
  webSearchDefault: 'chat_web_search_default',
  searchProvider: 'chat_search_provider',
  searxngUrl: 'chat_searxng_url',
  bingApiKey: 'chat_bing_api_key',
  searchMaxSteps: 'chat_search_max_steps',
  searchMaxResults: 'chat_search_max_results',
};

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function normalizeInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

async function getSetting(key) {
  try {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : undefined;
  } catch (err) {
    console.error('[ChatConfig] Failed to read setting:', key, err.message);
    return undefined;
  }
}

async function getChatConfig() {
  const [
    enabledDb,
    webSearchDefaultDb,
    providerDb,
    searxngUrlDb,
    bingApiKeyDb,
    maxStepsDb,
    maxResultsDb,
  ] = await Promise.all([
    getSetting(KEYS.chatEnabled),
    getSetting(KEYS.webSearchDefault),
    getSetting(KEYS.searchProvider),
    getSetting(KEYS.searxngUrl),
    getSetting(KEYS.bingApiKey),
    getSetting(KEYS.searchMaxSteps),
    getSetting(KEYS.searchMaxResults),
  ]);

  return {
    chatEnabled: normalizeBoolean(enabledDb, true),
    webSearchDefault: normalizeBoolean(webSearchDefaultDb, false),
    searchProvider: providerDb || process.env.CHAT_SEARCH_PROVIDER || 'none',
    searxngUrl: searxngUrlDb || process.env.SEARXNG_URL || '',
    bingApiKey: bingApiKeyDb || process.env.BING_SEARCH_API_KEY || '',
    searchMaxSteps: normalizeInt(maxStepsDb || process.env.CHAT_SEARCH_MAX_STEPS, 3, 1, 10),
    searchMaxResults: normalizeInt(maxResultsDb || process.env.CHAT_SEARCH_MAX_RESULTS, 5, 1, 20),
  };
}

async function setChatConfig(values) {
  const entries = [];
  if (values.chatEnabled !== undefined) entries.push([KEYS.chatEnabled, String(values.chatEnabled)]);
  if (values.webSearchDefault !== undefined) entries.push([KEYS.webSearchDefault, String(values.webSearchDefault)]);
  if (values.searchProvider !== undefined) entries.push([KEYS.searchProvider, String(values.searchProvider)]);
  if (values.searxngUrl !== undefined) entries.push([KEYS.searxngUrl, String(values.searxngUrl)]);
  if (values.bingApiKey !== undefined) entries.push([KEYS.bingApiKey, String(values.bingApiKey)]);
  if (values.searchMaxSteps !== undefined) entries.push([KEYS.searchMaxSteps, String(values.searchMaxSteps)]);
  if (values.searchMaxResults !== undefined) entries.push([KEYS.searchMaxResults, String(values.searchMaxResults)]);

  for (const [key, value] of entries) {
    await db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }
}

module.exports = {
  getChatConfig,
  setChatConfig,
  KEYS,
};
