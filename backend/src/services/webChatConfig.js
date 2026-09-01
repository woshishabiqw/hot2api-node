/**
 * WebChat configuration service.
 *
 * Stores user-portal chat defaults and optional search integration settings
 * in the generic settings table.  Admin users can read/write the full set;
 * the public chat endpoint only exposes non-sensitive fields.
 */

const db = require('../config/database');

const KEYS = {
  searchProvider: 'webchat_search_provider',
  searxngUrl: 'webchat_searxng_url',
  bingApiKey: 'webchat_bing_api_key',
  bingEndpoint: 'webchat_bing_endpoint',
  searchApiKey: 'webchat_search_api_key',
  searchEndpoint: 'webchat_search_endpoint',
  searchMethod: 'webchat_search_method',
  searchQueryParam: 'webchat_search_query_param',
  defaultModel: 'webchat_default_model',
  reasoningDefault: 'webchat_reasoning_default',
  searchMaxSteps: 'webchat_search_max_steps',
  searchEnabled: 'webchat_search_enabled',
};

const DEFAULTS = {
  search_provider: 'none',
  searxng_url: '',
  bing_api_key: '',
  bing_endpoint: 'https://api.bing.microsoft.com/v7.0/search',
  search_api_key: '',
  search_endpoint: '',
  search_method: 'POST',
  search_query_param: 'query',
  default_model: '',
  reasoning_default: false,
  search_max_steps: 3,
  search_enabled: true,
};

const VALID_PROVIDERS = [
  'none',
  'searxng',
  'bing',
  'bocha',
  'metaso',
  'uapi',
  'baidu_suggest',
  'sogou_suggest',
  'custom',
];

const PRESETS = {
  bocha: {
    endpoint: 'https://api.bocha.cn/v1/web-search',
    method: 'POST',
    queryParam: 'query',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
  },
  metaso: {
    endpoint: 'https://metaso.cn/api/v1/search',
    method: 'POST',
    queryParam: 'q',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
  },
  uapi: {
    endpoint: 'https://uapis.cn/api/v1/search/aggregate',
    method: 'POST',
    queryParam: 'query',
    keyHeader: null,
  },
  baidu_suggest: {
    endpoint: 'https://www.baidu.com/sugrec?ie=utf-8&json=1&prod=pc',
    method: 'GET',
    queryParam: 'wd',
    keyHeader: null,
  },
  sogou_suggest: {
    endpoint: 'https://www.sogou.com/suggnew/ajajjson?type=web',
    method: 'GET',
    queryParam: 'key',
    keyHeader: null,
  },
  custom: {
    endpoint: '',
    method: 'POST',
    queryParam: 'query',
    keyHeader: 'Authorization',
    keyPrefix: 'Bearer ',
  },
};

async function getConfig() {
  const rows = await db.all(`SELECT key, value FROM settings WHERE key LIKE 'webchat_%'`);
  const map = new Map(rows.map(r => [r.key, r.value]));

  const get = (key, fallback) => (map.has(key) ? map.get(key) : fallback);

  const provider = get(KEYS.searchProvider, DEFAULTS.search_provider);
  const preset = PRESETS[provider];

  // Generic search fields: fall back to legacy Bing fields when appropriate.
  let searchApiKey = get(KEYS.searchApiKey, DEFAULTS.search_api_key);
  let searchEndpoint = get(KEYS.searchEndpoint, DEFAULTS.search_endpoint);
  let searchMethod = get(KEYS.searchMethod, DEFAULTS.search_method);
  let searchQueryParam = get(KEYS.searchQueryParam, DEFAULTS.search_query_param);

  if (provider === 'bing') {
    if (!searchApiKey) searchApiKey = get(KEYS.bingApiKey, DEFAULTS.bing_api_key);
    if (!searchEndpoint) searchEndpoint = get(KEYS.bingEndpoint, DEFAULTS.bing_endpoint);
    if (!searchMethod) searchMethod = 'GET';
    if (!searchQueryParam) searchQueryParam = 'q';
  } else if (preset) {
    if (!searchEndpoint) searchEndpoint = preset.endpoint;
    if (!searchMethod) searchMethod = preset.method;
    if (!searchQueryParam) searchQueryParam = preset.queryParam;
  }

  return {
    search_provider: provider,
    searxng_url: get(KEYS.searxngUrl, DEFAULTS.searxng_url),
    bing_api_key: get(KEYS.bingApiKey, DEFAULTS.bing_api_key),
    bing_endpoint: get(KEYS.bingEndpoint, DEFAULTS.bing_endpoint),
    search_api_key: searchApiKey,
    search_endpoint: searchEndpoint,
    search_method: searchMethod,
    search_query_param: searchQueryParam,
    default_model: get(KEYS.defaultModel, DEFAULTS.default_model),
    reasoning_default: String(get(KEYS.reasoningDefault, DEFAULTS.reasoning_default)).toLowerCase() === 'true',
    search_max_steps: Math.max(1, Math.min(10, parseInt(get(KEYS.searchMaxSteps, DEFAULTS.search_max_steps), 10) || DEFAULTS.search_max_steps)),
    search_enabled: String(get(KEYS.searchEnabled, DEFAULTS.search_enabled)).toLowerCase() === 'true',
  };
}

function normalizeUrl(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('URL 必须以 http:// 或 https:// 开头');
  }
  return trimmed.replace(/\/$/, '');
}

async function setConfig(values) {
  const upsert = async (key, value) => {
    await db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, String(value)]
    );
  };

  if (values.search_provider !== undefined) {
    const provider = String(values.search_provider).trim().toLowerCase();
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new Error(`无效的搜索提供商: ${provider}`);
    }
    await upsert(KEYS.searchProvider, provider);
  }

  if (values.searxng_url !== undefined) {
    await upsert(KEYS.searxngUrl, normalizeUrl(values.searxng_url));
  }

  if (values.bing_api_key !== undefined) {
    await upsert(KEYS.bingApiKey, String(values.bing_api_key).trim());
  }

  if (values.bing_endpoint !== undefined) {
    await upsert(KEYS.bingEndpoint, normalizeUrl(values.bing_endpoint) || DEFAULTS.bing_endpoint);
  }

  if (values.search_api_key !== undefined) {
    await upsert(KEYS.searchApiKey, String(values.search_api_key).trim());
  }

  if (values.search_endpoint !== undefined) {
    await upsert(KEYS.searchEndpoint, normalizeUrl(values.search_endpoint));
  }

  if (values.search_method !== undefined) {
    const method = String(values.search_method).toUpperCase();
    if (!['GET', 'POST'].includes(method)) {
      throw new Error('请求方式必须是 GET 或 POST');
    }
    await upsert(KEYS.searchMethod, method);
  }

  if (values.search_query_param !== undefined) {
    const param = String(values.search_query_param).trim();
    if (!param) throw new Error('查询参数名不能为空');
    await upsert(KEYS.searchQueryParam, param);
  }

  if (values.default_model !== undefined) {
    await upsert(KEYS.defaultModel, String(values.default_model).trim());
  }

  if (values.reasoning_default !== undefined) {
    await upsert(KEYS.reasoningDefault, String(!!values.reasoning_default));
  }

  if (values.search_max_steps !== undefined) {
    const n = parseInt(values.search_max_steps, 10);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      throw new Error('搜索最大步数必须在 1-10 之间');
    }
    await upsert(KEYS.searchMaxSteps, String(n));
  }

  if (values.search_enabled !== undefined) {
    await upsert(KEYS.searchEnabled, String(!!values.search_enabled));
  }
}

module.exports = {
  KEYS,
  DEFAULTS,
  PRESETS,
  VALID_PROVIDERS,
  getConfig,
  setConfig,
};
