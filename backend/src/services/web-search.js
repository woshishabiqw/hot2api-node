/**
 * Web search service for the chat web search chain.
 *
 * Supports SearXNG and Bing Web Search.
 * The search chain itself (multi-step) lives in the chat route; this module
 * only provides the raw search adapter and a helper to format results.
 */
const fetch = require('node-fetch');

function normalizeUrl(url) {
  if (!url) return '';
  return url.replace(/\/$/, '');
}

async function searchSearxng(query, config) {
  const baseUrl = normalizeUrl(config.searxngUrl);
  if (!baseUrl) {
    throw new Error('SearXNG URL is not configured');
  }
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    timeout: 15000,
  });
  if (!res.ok) {
    throw new Error(`SearXNG request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const results = (data.results || []).slice(0, config.searchMaxResults).map(r => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || r.snippet || '',
  }));
  return results;
}

async function searchBing(query, config) {
  const apiKey = config.bingApiKey;
  if (!apiKey) {
    throw new Error('Bing Search API key is not configured');
  }
  const endpoint = process.env.BING_SEARCH_ENDPOINT || 'https://api.bing.microsoft.com/v7.0/search';
  const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${config.searchMaxResults}`;
  const res = await fetch(url, {
    headers: { 'Ocp-Apim-Subscription-Key': apiKey },
    timeout: 15000,
  });
  if (!res.ok) {
    throw new Error(`Bing request failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const results = (data.webPages?.value || []).map(r => ({
    title: r.name || '',
    url: r.url || '',
    snippet: r.snippet || '',
  }));
  return results;
}

async function searchWeb(query, config) {
  const provider = (config.searchProvider || '').toLowerCase();
  switch (provider) {
    case 'searxng':
      return searchSearxng(query, config);
    case 'bing':
      return searchBing(query, config);
    case 'none':
    default:
      return [];
  }
}

function formatSearchResults(results) {
  if (!results || results.length === 0) return '';
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n摘要：${r.snippet}`)
    .join('\n\n');
}

function buildSearchContext(userQuestion, results) {
  const formatted = formatSearchResults(results);
  if (!formatted) return '';
  return [
    '以下是针对用户问题的联网搜索结果，请结合这些信息作答，并在回答中引用来源编号 [1]、[2] 等。',
    `用户问题：${userQuestion}`,
    '搜索结果：',
    formatted,
  ].join('\n');
}

module.exports = {
  searchWeb,
  formatSearchResults,
  buildSearchContext,
};
