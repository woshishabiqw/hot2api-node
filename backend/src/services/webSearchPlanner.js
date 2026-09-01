/**
 * Web search planner — Kimi-style iterative search.
 *
 * When a user turns on web search, we do a first search on their query,
 * then ask the model whether more searches are needed.  The model can emit
 * SEARCH: <query> lines to request additional searches.  We repeat up to
 * webchat_search_max_steps times, then hand all gathered results to the
 * final chat completion.
 */

const axios = require('axios');
const db = require('../config/database');
const dispatcher = require('./dispatcher');
const proxyOpenAI = require('./proxy-openai');
const { getConfig } = require('./webChatConfig');
const { testSearch } = require('./webSearchTester');

const SEARCH_COMMAND_REGEX = /(?:^|\n)\s*(?:SEARCH|搜索)\s*[:：]\s*(.+?)(?=\n|$)/gi;

function normalizeMessages(messages) {
  return messages.filter(m => m && typeof m.content === 'string').map(m => ({ role: m.role, content: m.content }));
}

function extractLastUserQuery(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

function formatResult(result, startIndex = 1) {
  const lines = [];
  lines.push(`搜索词：${result.query}`);
  (result.preview || []).forEach((item, idx) => {
    const num = startIndex + idx;
    if (typeof item === 'string') {
      lines.push(`  [${num}] ${item}`);
    } else {
      const title = item.title || item.name || '';
      const snippet = item.snippet || '';
      lines.push(`  [${num}] ${title}${snippet ? ' - ' + snippet : ''}`);
    }
  });
  return lines.join('\n');
}

function getResultStartIndex(results, resultIndex) {
  let idx = 1;
  for (let i = 0; i < resultIndex; i++) {
    idx += (results[i].preview || []).length;
  }
  return idx;
}

function parseSearchCommands(text) {
  const queries = [];
  const cleaned = text.replace(SEARCH_COMMAND_REGEX, (match, q) => {
    const trimmed = q.trim();
    if (trimmed) queries.push(trimmed);
    return '\n';
  });
  return { queries: [...new Set(queries)], cleaned: cleaned.replace(/\n{2,}/g, '\n').trim() };
}

async function callUpstream({ model, messages, reasoning }) {
  const source = await dispatcher.selectSource(model, 'openai');
  if (!source) throw new Error('No available source for this model');

  const apiKey = db.getApiKey(source, 'openai');
  const rawUrl = db.getApiUrl(source, 'openai');
  const baseUrl = String(rawUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Source has no base URL');

  const modelInfo = await proxyOpenAI.getModelInfo(model, source.id);
  const upstreamModel = modelInfo?.source_model_id || model;

  const body = {
    model: upstreamModel,
    messages: normalizeMessages(messages),
    stream: false,
    reasoning: reasoning === true,
  };

  const candidateUrls = [];
  if (!baseUrl.endsWith('/v1')) candidateUrls.push(`${baseUrl}/v1/chat/completions`);
  candidateUrls.push(`${baseUrl}/chat/completions`);

  let lastErr;
  for (const url of candidateUrls) {
    try {
      const res = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 300000,
        responseType: 'json',
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 404) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('All upstream chat completions URLs failed');
}

async function callUpstreamStream({ model, messages, reasoning }) {
  const source = await dispatcher.selectSource(model, 'openai');
  if (!source) throw new Error('No available source for this model');

  const apiKey = db.getApiKey(source, 'openai');
  const rawUrl = db.getApiUrl(source, 'openai');
  const baseUrl = String(rawUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('Source has no base URL');

  const modelInfo = await proxyOpenAI.getModelInfo(model, source.id);
  const upstreamModel = modelInfo?.source_model_id || model;

  const body = {
    model: upstreamModel,
    messages: normalizeMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
    reasoning: reasoning === true,
  };

  const candidateUrls = [];
  if (!baseUrl.endsWith('/v1')) candidateUrls.push(`${baseUrl}/v1/chat/completions`);
  candidateUrls.push(`${baseUrl}/chat/completions`);

  let lastErr;
  for (const url of candidateUrls) {
    try {
      const res = await axios.post(url, body, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 300000,
        responseType: 'stream',
      });
      return res.data;
    } catch (err) {
      if (err.response?.status === 404) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('All upstream chat completions URLs failed');
}

function parseSSEData(buffer) {
  const events = [];
  const parts = buffer.split('\n\n');
  parts.forEach(part => {
    const lines = part.split('\n');
    const dataLine = lines.find(l => l.startsWith('data: '));
    if (dataLine) {
      const data = dataLine.slice(6);
      if (data && data !== '[DONE]') events.push(data);
    }
  });
  return events;
}

function streamCollect(stream, { onReasoning, onContent }) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let reasoning = '';
    stream.on('data', chunk => {
      buffer += decoder.decode(chunk, { stream: true });
      const idx = buffer.lastIndexOf('\n\n');
      if (idx < 0) return;
      const complete = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const event of parseSSEData(complete)) {
        try {
          const json = JSON.parse(event);
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            onReasoning?.(delta.reasoning_content, reasoning);
          }
          if (delta.content) {
            content += delta.content;
            onContent?.(delta.content, content);
          }
        } catch {}
      }
    });
    stream.on('end', () => resolve({ content, reasoning }));
    stream.on('error', reject);
  });
}

function buildFinalMessages(messages, results) {
  const normalized = normalizeMessages(messages);
  if (!results || results.length === 0) {
    return [
      { role: 'system', content: '用户已开启联网搜索，但未能获取到搜索结果，请基于你的知识库谨慎作答。' },
      ...normalized,
    ];
  }
  let startIndex = 1;
  const context = results.map(r => {
    const text = formatResult(r, startIndex);
    startIndex += (r.preview || []).length;
    return text;
  }).join('\n\n');
  const systemContent =
    '用户已开启联网搜索。请优先基于以下搜索结果回答问题，在引用处标注来源序号。' +
    '如果搜索结果不足以回答，再使用你的知识库补充。不要告诉用户“未开启联网搜索”或“无法联网”。\n\n' +
    context;
  return [{ role: 'system', content: systemContent }, ...normalized];
}

async function runSingleSearch(query, cfg) {
  try {
    const result = await testSearch({ query });
    if (result.ok && result.preview?.length) {
      return { query, preview: result.preview };
    }
  } catch (err) {
    console.error('[webSearchPlanner] search failed:', query, err.message);
  }
  return null;
}

async function planSearches(userQuery, model, reasoning) {
  const cfg = await getConfig();
  const maxSteps = Math.max(1, Math.min(10, Number(cfg.search_max_steps) || 1));
  const provider = cfg.search_provider;
  console.log('[webSearchPlanner] config', { provider, search_enabled: cfg.search_enabled, maxSteps });
  if (!provider || provider === 'none' || cfg.search_enabled === false) {
    return [];
  }

  const results = [];
  const initial = await runSingleSearch(userQuery, cfg);
  console.log('[webSearchPlanner] initial search', { query: userQuery, found: !!initial, previewCount: initial?.preview?.length });
  if (initial) results.push(initial);

  const plannerMessages = [
    {
      role: 'system',
      content:
        '你是一个搜索规划助手。用户已经开启联网搜索。' +
        '请根据用户问题和当前搜索结果，判断是否需要继续搜索更多信息。' +
        '如果需要，请只输出一行：SEARCH: 具体搜索词。' +
        '如果信息已足够，请只输出：FINISHED。' +
        '不要回答问题本身，不要输出任何其他内容。',
    },
  ];

  for (let step = 0; step < maxSteps - 1; step++) {
    const context = [
      ...plannerMessages,
      {
        role: 'user',
        content: `用户问题：${userQuery}\n\n当前搜索结果：\n${results.map(formatResult).join('\n\n') || '（暂无）'}\n\n请判断是否需要继续搜索。`,
      },
    ];

    let reply;
    try {
      const data = await callUpstream({ model, messages: context, reasoning });
      reply = data.choices?.[0]?.message?.content || '';
    } catch (err) {
      console.error('[webSearchPlanner] planner call failed:', err.message);
      break;
    }

    const { queries, cleaned } = parseSearchCommands(reply);
    console.log('[webSearchPlanner] planner step', { step, queries, finished: queries.length === 0 });
    if (queries.length === 0) break;

    for (const q of queries.slice(0, 1)) {
      const r = await runSingleSearch(q, cfg);
      console.log('[webSearchPlanner] follow-up search', { query: q, found: !!r, previewCount: r?.preview?.length });
      if (r) results.push(r);
    }
  }

  return results;
}

async function buildSearchAugmentedMessages(messages, model, reasoning) {
  const normalized = normalizeMessages(messages);
  const userQuery = extractLastUserQuery(normalized);
  if (!userQuery) return normalized;

  const results = await planSearches(userQuery, model, reasoning);
  console.log('[webSearchPlanner] augmented results count', results.length);
  if (results.length === 0) {
    return [
      { role: 'system', content: '用户已开启联网搜索，但未能获取到搜索结果，请基于你的知识库谨慎作答。' },
      ...normalized,
    ];
  }

  let startIndex = 1;
  const context = results.map(r => {
    const text = formatResult(r, startIndex);
    startIndex += (r.preview || []).length;
    return text;
  }).join('\n\n');
  const systemContent =
    '用户已开启联网搜索。请优先基于以下搜索结果回答问题，在引用处标注来源序号。' +
    '如果搜索结果不足以回答，再使用你的知识库补充。不要告诉用户“未开启联网搜索”或“无法联网”。\n\n' +
    context;

  return [{ role: 'system', content: systemContent }, ...normalized];
}

async function streamSearchChat(res, { model, messages, reasoning, userId }) {
  const cfg = await getConfig();
  const provider = cfg.search_provider;
  if (!provider || provider === 'none' || cfg.search_enabled === false) {
    throw new Error('Search not enabled');
  }

  const userQuery = extractLastUserQuery(normalizeMessages(messages));
  if (!userQuery) throw new Error('No user query found');

  const maxSteps = Math.max(1, Math.min(10, Number(cfg.search_max_steps) || 1));
  const results = [];

  function sendProgress(progress) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'search_progress', ...progress })}
\n`);
    }
  }

  function sendThinking(thinking) {
    if (!res.writableEnded && thinking) {
      res.write(`data: ${JSON.stringify({ type: 'search_thinking', thinking })}
\n`);
    }
  }

  function sendSources(sources) {
    if (!res.writableEnded && sources?.length) {
      res.write(`data: ${JSON.stringify({ type: 'search_sources', sources })}
\n`);
    }
  }

  console.log('[webSearchAgent] streaming search started', { userId, model, query: userQuery, maxSteps });

  const plannerMessages = [
    {
      role: 'system',
      content:
        '你是一个搜索规划助手。用户已经开启联网搜索。' +
        '请根据用户问题，判断是否需要搜索更多信息才能回答。' +
        '如果需要搜索，请只输出一行：SEARCH: 具体搜索词。' +
        '如果当前信息已足够或问题不需要搜索，请只输出：FINISHED。' +
        '不要回答问题本身，不要输出任何其他内容。',
    },
  ];

  for (let step = 1; step <= maxSteps; step++) {
    sendProgress({ step, phase: 'think', message: step === 1 ? '正在分析问题…' : '正在判断是否需要进一步搜索…' });

    const context = [
      ...plannerMessages,
      {
        role: 'user',
        content: `用户问题：${userQuery}\n\n当前已搜索结果：\n${results.map((r, i) => formatResult(r, getResultStartIndex(results, i))).join('\n\n') || '（暂无）'}\n\n请判断是否需要继续搜索。`,
      },
    ];

    let reply = '';
    try {
      const upstreamStream = await callUpstreamStream({ model, messages: context, reasoning });
      await streamCollect(upstreamStream, {
        onReasoning: (delta) => sendThinking(delta),
        onContent: (delta, full) => { reply = full; },
      });
    } catch (err) {
      console.error('[webSearchAgent] planner call failed:', err.message);
      break;
    }

    const { queries } = parseSearchCommands(reply);
    console.log('[webSearchAgent] planner step', { step, queries, finished: queries.length === 0 });
    if (queries.length === 0) {
      sendProgress({ step, phase: 'done', message: '信息已足够，开始生成回答' });
      break;
    }

    const q = queries[0];
    sendProgress({ step, phase: 'search', query: q, message: `正在搜索：${q}` });
    const r = await runSingleSearch(q, cfg);
    if (r) results.push(r);
    sendProgress({ step, phase: 'done', found: r?.preview?.length || 0, message: `已找到 ${r?.preview?.length || 0} 条结果` });
  }

  const sources = [];
  results.forEach(r => {
    (r.preview || []).forEach(item => {
      sources.push({
        title: typeof item === 'string' ? item : (item.title || item.name || ''),
        url: typeof item === 'string' ? '' : (item.url || ''),
      });
    });
  });
  sendSources(sources);
  sendProgress({ phase: 'synthesize', message: '正在整合搜索结果，生成回答…' });

  const finalMessages = buildFinalMessages(messages, results);
  console.log('[webSearchAgent] final request', { userId, model, resultCount: results.length, messageCount: finalMessages.length, sourceCount: sources.length });

  const upstreamStream = await callUpstreamStream({ model, messages: finalMessages, reasoning });

  upstreamStream.on('data', (chunk) => {
    if (!res.writableEnded) res.write(chunk);
  });
  upstreamStream.on('end', () => {
    if (!res.writableEnded) res.end();
    console.log('[webSearchAgent] stream ended', { userId, model });
  });
  upstreamStream.on('error', (err) => {
    console.error('[webSearchAgent] upstream stream error', err?.message);
    if (!res.writableEnded) res.end();
  });
  res.on('close', () => {
    upstreamStream.destroy?.();
  });
}

module.exports = {
  buildSearchAugmentedMessages,
  planSearches,
  streamSearchChat,
};
