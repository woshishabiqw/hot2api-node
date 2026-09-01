/**
 * Web search tester — executes a single probe query against the configured
 * search provider so admins can verify keys / endpoints without waiting for
 * the chat pipeline.
 */

const axios = require('axios');
const { getConfig, PRESETS } = require('./webChatConfig');

/**
 * JSON.stringify that escapes non-ASCII characters as \uXXXX.
 * Some Chinese APIs (Bocha, UAPI) only accept ASCII request bodies.
 */
function jsonStringifyAscii(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uFFFF]/g, (ch) => {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

function parseJsonp(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const match = trimmed.match(/^\s*[^\({]*\((.*)\)\s*;?\s*$/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function pickPreview(data, provider) {
  if (!data || typeof data !== 'object') return String(data).slice(0, 500);

  if (provider === 'baidu_suggest' && Array.isArray(data.g)) {
    return data.g.slice(0, 10).map(x => x.q || x).filter(Boolean);
  }
  if (provider === 'sogou_suggest' && Array.isArray(data)) {
    const suggestions = data[1];
    return Array.isArray(suggestions) ? suggestions.slice(0, 10) : data;
  }
  if (Array.isArray(data.results)) {
    return data.results.slice(0, 5).map(r => ({
      title: r.title || r.name,
      url: r.url,
      snippet: r.snippet ? String(r.snippet).slice(0, 200) : undefined,
    }));
  }
  if (data.webPages?.value) {
    return data.webPages.value.slice(0, 5).map(r => ({
      title: r.name || r.title,
      url: r.url,
      snippet: r.snippet ? String(r.snippet).slice(0, 200) : undefined,
    }));
  }
  if (data.data?.webPages?.value) {
    return data.data.webPages.value.slice(0, 5).map(r => ({
      title: r.name || r.title,
      url: r.url,
      snippet: r.snippet ? String(r.snippet).slice(0, 200) : undefined,
    }));
  }
  return data;
}

async function testBochaLike({ endpoint, apiKey, queryParam, query }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = { [queryParam]: query, count: 5, summary: true };
  const { data } = await axios.post(endpoint, jsonStringifyAscii(body), { headers, timeout: 15000 });
  return data;
}

async function testMetaso({ endpoint, apiKey, query }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = { q: query, size: 5, includeSummary: true };
  const { data } = await axios.post(endpoint, jsonStringifyAscii(body), { headers, timeout: 30000 });
  return data;
}

async function testUapi({ endpoint, query }) {
  const body = { query, fetch_full: false };
  const { data } = await axios.post(endpoint, jsonStringifyAscii(body), {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  return data;
}

async function testBing({ endpoint, apiKey, query }) {
  const url = new URL(endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('mkt', 'zh-CN');
  url.searchParams.set('count', '5');
  const headers = {};
  if (apiKey) headers['Ocp-Apim-Subscription-Key'] = apiKey;
  const { data } = await axios.get(url.toString(), { headers, timeout: 15000 });
  return data;
}

async function testSearxng({ searxngUrl, query }) {
  const url = new URL('/search', searxngUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  const { data } = await axios.get(url.toString(), { timeout: 15000 });
  return data;
}

async function testBaiduSuggest({ endpoint, query }) {
  const url = new URL(endpoint);
  url.searchParams.set('wd', query);
  const { data } = await axios.get(url.toString(), { timeout: 10000 });
  return data;
}

async function testSogouSuggest({ endpoint, query }) {
  const url = new URL(endpoint);
  url.searchParams.set('key', query);
  const { data } = await axios.get(url.toString(), { timeout: 10000 });
  const parsed = parseJsonp(data);
  return parsed || data;
}

async function testCustom({ endpoint, method, queryParam, apiKey, query }) {
  const preset = PRESETS.custom;
  const headers = {};
  if (apiKey && preset.keyHeader) headers[preset.keyHeader] = `${preset.keyPrefix || ''}${apiKey}`;

  if (method === 'GET') {
    const url = new URL(endpoint);
    url.searchParams.set(queryParam, query);
    const { data } = await axios.get(url.toString(), { headers, timeout: 15000 });
    return data;
  }

  headers['Content-Type'] = 'application/json';
  const body = { [queryParam]: query };
  const { data } = await axios.post(endpoint, jsonStringifyAscii(body), { headers, timeout: 15000 });
  return data;
}

async function testSearch(overrides = {}) {
  const cfg = await getConfig();
  const provider = overrides.search_provider || cfg.search_provider;
  const query = overrides.query || '人工智能';

  if (provider === 'none') {
    throw new Error('当前未启用搜索提供商');
  }

  const start = Date.now();
  let raw;

  try {
    switch (provider) {
      case 'bocha':
        raw = await testBochaLike({
          endpoint: cfg.search_endpoint,
          apiKey: cfg.search_api_key,
          queryParam: cfg.search_query_param,
          query,
        });
        break;
      case 'metaso':
        raw = await testMetaso({
          endpoint: cfg.search_endpoint,
          apiKey: cfg.search_api_key,
          query,
        });
        break;
      case 'uapi':
        raw = await testUapi({ endpoint: cfg.search_endpoint, query });
        break;
      case 'bing':
        raw = await testBing({
          endpoint: cfg.bing_endpoint || cfg.search_endpoint,
          apiKey: cfg.bing_api_key || cfg.search_api_key,
          query,
        });
        break;
      case 'searxng':
        raw = await testSearxng({ searxngUrl: cfg.searxng_url, query });
        break;
      case 'baidu_suggest':
        raw = await testBaiduSuggest({ endpoint: cfg.search_endpoint, query });
        break;
      case 'sogou_suggest':
        raw = await testSogouSuggest({ endpoint: cfg.search_endpoint, query });
        break;
      case 'custom':
        raw = await testCustom({
          endpoint: cfg.search_endpoint,
          method: cfg.search_method,
          queryParam: cfg.search_query_param,
          apiKey: cfg.search_api_key,
          query,
        });
        break;
      default:
        throw new Error(`不支持的搜索提供商: ${provider}`);
    }
  } catch (err) {
    const status = err.response?.status;
    const responseData = err.response?.data;
    const message = err.message || '请求失败';
    return {
      ok: false,
      provider,
      query,
      latency_ms: Date.now() - start,
      status,
      error: message,
      response: responseData
        ? (typeof responseData === 'object' ? responseData : String(responseData).slice(0, 1000))
        : undefined,
    };
  }

  return {
    ok: true,
    provider,
    query,
    latency_ms: Date.now() - start,
    preview: pickPreview(raw, provider),
    raw,
  };
}

module.exports = { testSearch, jsonStringifyAscii };
