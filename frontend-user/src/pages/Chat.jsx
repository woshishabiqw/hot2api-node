import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useAuth } from '../hooks/useAuth';
import api from '../lib/api';
import { cn } from '../lib/utils';
import { encryptSessions, decryptSessions } from '../lib/chatCrypto';
import {
  SessionSelectorModal,
  ChatHeader,
  ChatMessage,
  ChatInput,
  WelcomeScreen,
} from '../components/chat';
import { AlertTriangle } from 'lucide-react';

const SESSIONS_KEY_PREFIX = 'fgw_chat_sessions_v2';
const LEGACY_SHARED_KEY = 'fgw_chat_sessions_v2';
const LEGACY_KEY = 'fgw_chat_session_v1';
const MAX_SESSIONS = 20;
const CONTEXT_MESSAGE_LIMIT = 20;
const RENDER_BATCH_MS = 80;
const RENDER_BATCH_CHARS = 32;

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTitle(messages) {
  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '新对话';
  const text = firstUser.content.replace(/\s+/g, ' ').trim();
  if (!text) return '新对话';
  return text.slice(0, 26) + (text.length > 26 ? '…' : '');
}

function storageKey(userId) {
  return `${SESSIONS_KEY_PREFIX}_${userId}`;
}

async function loadSessions(userId, token) {
  if (!userId) return [];
  const key = storageKey(userId);
  const encrypted = localStorage.getItem(key);
  if (encrypted) {
    const decrypted = await decryptSessions(encrypted, token);
    if (Array.isArray(decrypted)) return decrypted;
    // If decryption failed (e.g. token rotated), start empty rather than leak data.
    return [];
  }

  // One-time migration from the old unencrypted shared key to per-user encrypted storage.
  const legacy = localStorage.getItem(LEGACY_SHARED_KEY);
  if (legacy) {
    try {
      const parsed = JSON.parse(legacy);
      if (Array.isArray(parsed)) {
        await saveSessions(userId, parsed, token);
        localStorage.removeItem(LEGACY_SHARED_KEY);
        return parsed;
      }
    } catch { /* ignore */ }
  }

  // Very old single-session key.
  const v1 = localStorage.getItem(LEGACY_KEY);
  if (v1) {
    try {
      const legacyMessages = JSON.parse(v1);
      if (Array.isArray(legacyMessages) && legacyMessages.length > 0) {
        const session = {
          id: generateId(),
          title: makeTitle(legacyMessages),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: legacyMessages,
          model: '',
          stats: {},
        };
        const migrated = [session];
        await saveSessions(userId, migrated, token);
        localStorage.removeItem(LEGACY_KEY);
        return migrated;
      }
    } catch { /* ignore */ }
  }

  return [];
}

async function saveSessions(userId, sessions, token) {
  if (!userId || !token) return;
  const encrypted = await encryptSessions(sessions, token);
  if (encrypted) {
    localStorage.setItem(storageKey(userId), encrypted);
    // Per-user encrypted storage is now active; remove old plaintext keys.
    localStorage.removeItem(LEGACY_SHARED_KEY);
    localStorage.removeItem(LEGACY_KEY);
  }
}

function limitSessions(sessions) {
  if (sessions.length <= MAX_SESSIONS) return sessions;
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
}

// On page refresh an in-flight assistant placeholder is left behind.
// Clean it up so the UI doesn't stay stuck on "thinking...".
function sanitizeSessions(sessions) {
  return sessions.map(session => {
    const messages = session.messages.reduce((acc, m) => {
      if (m.role === 'assistant' && m.done === false) {
        // If some content already arrived, freeze it as a completed message.
        if (m.content || m.reasoning) {
          acc.push({ ...m, done: true });
        }
        // Otherwise it's an empty placeholder from an interrupted generation: drop it.
        return acc;
      }
      acc.push(m);
      return acc;
    }, []);
    return { ...session, messages };
  });
}

function buildSearchContext(preview) {
  const items = Array.isArray(preview) ? preview : [];
  if (items.length === 0) return '';
  const body = items.map((item, i) => {
    if (typeof item === 'string') return `[${i + 1}] ${item}`;
    const title = item.title || item.name || '';
    const url = item.url ? ` (${item.url})` : '';
    const snippet = item.snippet ? `\n${item.snippet}` : '';
    return `[${i + 1}] ${title}${url}${snippet}`;
  }).join('\n\n');
  return `用户已开启联网搜索。请优先基于以下搜索结果回答问题，并在相关处标注来源序号。如果搜索结果与问题无关，再使用你的知识库作答。不要告诉用户“未开启联网搜索”或“无法联网”。\n\n搜索结果（按相关性排序）：\n\n${body}`;
}

function parseSSE(raw) {
  const lines = raw.split('\n');
  const events = [];
  let current = { data: '' };
  for (const line of lines) {
    if (line.startsWith('data: ')) current.data = line.slice(6);
    else if (line.trim() === '') {
      if (current.data) { events.push(current.data); current = { data: '' }; }
    }
  }
  if (current.data) events.push(current.data);
  return events;
}

// Ease-in-out quad helper for smooth auto-scroll animations.
function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

let smoothScrollRafId = null;
function smoothScrollToBottom(container, smoothScrollingRef, duration = 220) {
  if (!container) return;
  if (smoothScrollRafId) cancelAnimationFrame(smoothScrollRafId);
  smoothScrollingRef.current = true;
  const start = container.scrollTop;
  let startTime = null;
  function step(timestamp) {
    if (!startTime) startTime = timestamp;
    const progress = Math.min((timestamp - startTime) / duration, 1);
    const target = container.scrollHeight - container.clientHeight;
    const distance = target - start;
    if (distance <= 0) {
      smoothScrollingRef.current = false;
      smoothScrollRafId = null;
      return;
    }
    container.scrollTop = start + distance * easeInOutQuad(progress);
    if (progress < 1) {
      smoothScrollRafId = requestAnimationFrame(step);
    } else {
      smoothScrollingRef.current = false;
      smoothScrollRafId = null;
    }
  }
  smoothScrollRafId = requestAnimationFrame(step);
}

/**
 * Extract <think>...</think> blocks from streamed content.
 * When reasoning is enabled, the inner text goes to the thinking block.
 * When reasoning is disabled, the entire block is stripped so the model
 * doesn't "leak" its thinking process into the answer.
 * Partial blocks are kept in bufferRef across flushes.
 */
function extractThinkSegments(text, keepReasoning, bufferRef) {
  const input = bufferRef.current + text;
  bufferRef.current = '';
  let content = '';
  let reasoning = '';
  let i = 0;
  while (i < input.length) {
    const open = input.indexOf('<think>', i);
    if (open === -1) {
      content += input.slice(i);
      break;
    }
    const close = input.indexOf('</think>', open);
    if (close === -1) {
      content += input.slice(i, open);
      bufferRef.current = input.slice(open);
      break;
    }
    content += input.slice(i, open);
    if (keepReasoning) reasoning += input.slice(open + 7, close);
    i = close + 8;
  }
  return { content, reasoning };
}

export default function Chat() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [input, setInput] = useState('');
  const [reasoningEnabled, setReasoningEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchProgressRef = useRef([]);
  const [models, setModels] = useState([]);
  const [chatConfig, setChatConfig] = useState({ default_model: '', reasoning_default: false, search_provider: 'none', search_enabled: true });
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [searchProgress, setSearchProgress] = useState([]);
  const [searchReasoning, setSearchReasoning] = useState('');
  const searchReasoningRef = useRef('');
  const [searchSources, setSearchSources] = useState([]);
  const searchSourcesRef = useRef([]);
  const [latencies, setLatencies] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const abortRef = useRef(null);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const inputRef = useRef(null);
  const scrollLockRef = useRef(false);
  const firstTokenScrolledRef = useRef(false);
  const smoothScrollingRef = useRef(false);
  const flushTimerRef = useRef(null);
  const thinkBufferRef = useRef('');
  const pendingDeltaRef = useRef({ content: '', reasoning: '', rawContent: '' });

  const activeSession = useMemo(
    () => sessions.find(s => s.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const messages = activeSession?.messages || [];
  const selectedModel = activeSession?.model || '';

  // Load encrypted per-user sessions when auth is known.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!user) {
        if (!cancelled) {
          setSessions([]);
          setActiveSessionId(null);
          setSessionsReady(true);
        }
        return;
      }
      const token = localStorage.getItem('token');
      const data = await loadSessions(user.id, token);
      if (cancelled) return;
      const sanitized = sanitizeSessions(Array.isArray(data) ? data : []);
      setSessions(sanitized);
      setActiveSessionId(sanitized.length > 0 ? sanitized[0].id : null);
      setSessionsReady(true);
    }
    setSessionsReady(false);
    load();
    return () => { cancelled = true; };
  }, [user]);

  // On first load, scroll an existing conversation to the bottom so the user
  // doesn't have to scroll down manually after refresh. Empty chats stay at top.
  useEffect(() => {
    if (!sessionsReady) return;
    const el = messagesContainerRef.current;
    if (!el) return;
    if (messages.length > 0) {
      scrollLockRef.current = true;
      const t = setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
      return () => clearTimeout(t);
    }
    el.scrollTop = 0;
  }, [sessionsReady, messages.length]);

  // Persist encrypted per-user sessions on change.
  useEffect(() => {
    if (!sessionsReady || !user) return;
    const token = localStorage.getItem('token');
    saveSessions(user.id, sessions, token);
  }, [sessions, sessionsReady, user]);

  // Scroll to bottom whenever messages change (synchronous, before paint).
  useLayoutEffect(() => {
    if (scrollLockRef.current && !smoothScrollingRef.current && messagesContainerRef.current) {
      const el = messagesContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Smoothly slide the reply placeholder into view when sending starts,
  // and again when the reply finishes (covers non-streaming responses).
  useLayoutEffect(() => {
    if (loading) {
      scrollLockRef.current = true;
      firstTokenScrolledRef.current = false;
      smoothScrollToBottom(messagesContainerRef.current, smoothScrollingRef);
    } else if (scrollLockRef.current) {
      smoothScrollToBottom(messagesContainerRef.current, smoothScrollingRef);
    }
  }, [loading]);

  // Also watch DOM mutations (streaming text, images loading) and keep pinned.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (scrollLockRef.current && !smoothScrollingRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [modelsRes, configRes] = await Promise.all([
          api.get('/chat/models'),
          api.get('/chat/config'),
        ]);
        if (cancelled) return;
        const list = modelsRes.data || [];
        const cfg = configRes.data || {};
        setModels(list);
        setChatConfig({
          default_model: cfg.default_model || '',
          reasoning_default: !!cfg.reasoning_default,
          search_provider: cfg.search_provider || 'none',
          search_enabled: cfg.search_enabled !== false,
        });
        setReasoningEnabled(!!cfg.reasoning_default);

        const preferredModelId = cfg.default_model || 'deepseek-v4-flash';
        const defaultModel = list.find(m => m.model_id === preferredModelId) || list[0];
        if (defaultModel) {
          setSessions(prev => {
            if (prev.length === 0) {
              const session = {
                id: generateId(),
                title: '新对话',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: [],
                model: defaultModel.model_id,
                stats: {},
              };
              setActiveSessionId(session.id);
              return [session];
            }
            return prev.map(s => s.model ? s : { ...s, model: s.model || defaultModel.model_id });
          });
        }
        for (const m of list) probeLatency(m.model_id);
      } catch (err) { console.error('[chat] failed to load models:', err); }
    }
    if (!sessionsReady) return;
    load();
    return () => { cancelled = true; };
  }, [sessionsReady]);

  const probeLatency = useCallback(async (modelId) => {
    const start = Date.now();
    try {
      const res = await api.get(`/chat/models/${encodeURIComponent(modelId)}/latency`);
      const ms = res.data?.ms;
      setLatencies(prev => ({ ...prev, [modelId]: ms != null ? ms : Date.now() - start }));
    } catch { setLatencies(prev => ({ ...prev, [modelId]: null })); }
  }, []);

  const createSession = useCallback(() => {
    const preferredModelId = chatConfig.default_model || 'deepseek-v4-flash';
    const firstModel = models.find(m => m.model_id === preferredModelId) || models[0];
    const session = {
      id: generateId(),
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      model: firstModel?.model_id || '',
      stats: {},
    };
    setSessions(prev => limitSessions([session, ...prev]));
    setActiveSessionId(session.id);
    setInput('');
    inputRef.current?.focus();
    scrollLockRef.current = true;
    setSidebarOpen(false);
  }, [models, chatConfig]);

  const selectSession = useCallback((id) => {
    setActiveSessionId(id);
    setSidebarOpen(false);
    inputRef.current?.focus();
    scrollLockRef.current = true;
  }, []);

  const deleteSession = useCallback((e, id) => {
    e.stopPropagation();
    setSessions(prev => {
      const next = prev.filter(s => s.id !== id);
      if (activeSessionId === id) setActiveSessionId(next[0]?.id || null);
      return next;
    });
  }, [activeSessionId]);

  const setActiveModel = useCallback((modelId) => {
    setSessions(prev => prev.map(s => s.id === activeSessionId ? { ...s, model: modelId } : s));
  }, [activeSessionId]);

  const updateActiveSessionMessages = useCallback((updater) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== activeSessionId) return s;
      const nextMessages = typeof updater === 'function' ? updater(s.messages) : updater;
      return {
        ...s,
        messages: nextMessages,
        title: s.title === '新对话' ? makeTitle(nextMessages) : s.title,
        updatedAt: Date.now(),
      };
    }));
  }, [activeSessionId]);

  const flushPendingDelta = useCallback((final = false) => {
    const { rawContent, reasoning: directReasoning } = pendingDeltaRef.current;
    if (!rawContent && !directReasoning && !thinkBufferRef.current) return;
    pendingDeltaRef.current = { content: '', reasoning: '', rawContent: '' };
    const { content, reasoning } = extractThinkSegments(rawContent, reasoningEnabled, thinkBufferRef);
    let finalContent = content;
    let finalReasoning = reasoning + (reasoningEnabled ? directReasoning : '');

    if (final && thinkBufferRef.current) {
      // Unclosed <think> at stream end: treat as reasoning if kept, otherwise discard.
      if (reasoningEnabled) finalReasoning += thinkBufferRef.current.replace(/^<think>/, '');
      thinkBufferRef.current = '';
    }

    if (!finalContent && !finalReasoning) return;
    updateActiveSessionMessages(prev => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === 'assistant') {
        last.content = (last.content || '') + finalContent;
        last.reasoning = (last.reasoning || '') + finalReasoning;
      }
      return next;
    });
  }, [updateActiveSessionMessages, reasoningEnabled]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushPendingDelta();
    }, RENDER_BATCH_MS);
  }, [flushPendingDelta]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading || !selectedModel) return;
    if (!activeSession) { createSession(); return; }

    const now = Date.now();
    const userMessage = { role: 'user', content: text, timestamp: now };
    const assistantMessage = { role: 'assistant', content: '', reasoning: '', done: false, stats: null, timestamp: now };

    updateActiveSessionMessages(prev => [...prev, userMessage, assistantMessage]);
    setInput('');
    setLoading(true);
    scrollLockRef.current = true;
    thinkBufferRef.current = '';
    pendingDeltaRef.current = { content: '', reasoning: '', rawContent: '' };

    const token = localStorage.getItem('token');
    const abortController = new AbortController();
    abortRef.current = abortController;

    const useWebSearch = webSearchEnabled && chatConfig.search_enabled && chatConfig.search_provider && chatConfig.search_provider !== 'none';
    const requestMessages = [...messages, userMessage]
      .filter(m => m.role !== 'system')
      .slice(-CONTEXT_MESSAGE_LIMIT)
      .map(m => ({ role: m.role, content: m.content }));

    searchProgressRef.current = [];
    setSearchProgress([]);
    searchReasoningRef.current = '';
    setSearchReasoning('');
    searchSourcesRef.current = [];
    setSearchSources([]);
    if (useWebSearch) {
      setSearching(true);
    }
    console.log('[chat] sending', { useWebSearch, messageCount: requestMessages.length });

    const reqStart = Date.now();
    let firstTokenTime = null;
    let inputTokensAcc = 0, outputTokensAcc = 0, totalTokensAcc = 0, speedAcc = 0;
    const modelInfo = models.find(m => m.model_id === selectedModel);
    const inputPrice = modelInfo?.input_price || 0;
    const outputPrice = modelInfo?.output_price || 0;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ model: selectedModel, messages: requestMessages, stream: true, reasoning: reasoningEnabled, web_search: useWebSearch }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: { message: '请求失败' } }));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = parseSSE(buffer);
        const lastNl = buffer.lastIndexOf('\n\n');
        if (lastNl >= 0) buffer = buffer.slice(lastNl + 2);

        for (const event of events) {
          if (event === '[DONE]') continue;
          try {
            const data = JSON.parse(event);
            if (data.type === 'search_thinking') {
              searchReasoningRef.current += data.thinking || '';
              setSearchReasoning(searchReasoningRef.current);
              continue;
            }
            if (data.type === 'search_sources') {
              const sources = Array.isArray(data.sources) ? data.sources : [];
              searchSourcesRef.current = sources;
              setSearchSources(sources);
              // Persist sources on the current assistant message so they survive
              // after the search phase ends and can be used to render linkable citations.
              updateActiveSessionMessages(prev => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') {
                  last.sources = sources;
                }
                return next;
              });
              continue;
            }
            if (data.type === 'search_progress') {
              searchProgressRef.current = [...searchProgressRef.current, data];
              setSearchProgress(searchProgressRef.current);
              continue;
            }
            if (data.error) {
              throw new Error(data.error.message || '搜索失败');
            }
            if (data.usage) {
              inputTokensAcc = data.usage.prompt_tokens || inputTokensAcc;
              outputTokensAcc = data.usage.completion_tokens || outputTokensAcc;
              totalTokensAcc = data.usage.total_tokens || totalTokensAcc;
              const elapsedSec = (Date.now() - reqStart) / 1000;
              speedAcc = elapsedSec > 0 ? outputTokensAcc / elapsedSec : 0;
            }
            const delta = data.choices?.[0]?.delta;
            if (delta) {
              if (firstTokenTime == null && (delta.content || delta.reasoning_content)) {
                firstTokenTime = Date.now() - reqStart;
                // Search phase ends when the model starts answering.
                setSearching(false);
                searchProgressRef.current = [];
                setSearchProgress([]);
                // Persist the search-stage reasoning into the assistant message so the
                // thinking block stays visible and final reasoning can append to it.
                if (searchReasoningRef.current) {
                  updateActiveSessionMessages(prev => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (last && last.role === 'assistant') {
                      last.reasoning = (last.reasoning || '') + searchReasoningRef.current;
                    }
                    return next;
                  });
                }
                if (!firstTokenScrolledRef.current) {
                  firstTokenScrolledRef.current = true;
                  smoothScrollToBottom(messagesContainerRef.current, smoothScrollingRef);
                }
              }
              if (reasoningEnabled && delta.reasoning_content) pendingDeltaRef.current.reasoning += delta.reasoning_content;
              if (delta.content) pendingDeltaRef.current.rawContent += delta.content;
              const shouldFlush =
                pendingDeltaRef.current.rawContent.length >= RENDER_BATCH_CHARS ||
                pendingDeltaRef.current.reasoning.length >= RENDER_BATCH_CHARS;
              if (shouldFlush) flushPendingDelta(); else scheduleFlush();
            }
          } catch { /* ignore */ }
        }
      }

      flushPendingDelta(true);
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }

      const costAcc = (inputTokensAcc * inputPrice + outputTokensAcc * outputPrice) / 1e6;
      updateActiveSessionMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
          last.done = true;
          last.stats = {
            inputTokens: inputTokensAcc,
            outputTokens: outputTokensAcc,
            totalTokens: totalTokensAcc,
            firstTokenMs: firstTokenTime,
            speed: speedAcc,
            cost: costAcc,
          };
        }
        return next;
      });
    } catch (err) {
      flushPendingDelta(true);
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      if (err.name === 'AbortError') {
        updateActiveSessionMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            last.content = (last.content || '') + '\n\n[已停止生成]';
            last.done = true;
          }
          return next;
        });
      } else {
        updateActiveSessionMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant') {
            last.content = `错误：${err.message}`;
            last.error = true;
            last.done = true;
          }
          return next;
        });
      }
    } finally {
      setLoading(false);
      setSearching(false);
      abortRef.current = null;
    }
  };

  const handleStop = () => abortRef.current?.abort();

  const handleRegenerate = useCallback(async () => {
    const lastUserIndex = [...messages].reverse().findIndex(m => m.role === 'user');
    if (lastUserIndex < 0) return;
    const targetIndex = messages.length - 1 - lastUserIndex;
    const userMessage = messages[targetIndex];
    setInput(userMessage.content);
    updateActiveSessionMessages(prev => prev.slice(0, targetIndex));
    scrollLockRef.current = true;
    // allow state to flush then send
    setTimeout(() => handleSend(), 0);
  }, [messages, updateActiveSessionMessages]);

  const showLongContextWarning = messages.length > 50;

  return (
    <div className="flex flex-1 min-h-0 -mx-6 -mt-6 bg-background overflow-hidden text-foreground">
      <main className="flex-1 flex flex-col min-w-0 relative bg-background overflow-hidden">
        <ChatHeader
          title={activeSession?.title}
          onMenuClick={() => setSidebarOpen(o => !o)}
          onNewSession={createSession}
        />

        <SessionSelectorModal
          sessions={sessions}
          activeSessionId={activeSessionId}
          onCreate={createSession}
          onSelect={selectSession}
          onDelete={deleteSession}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        <div className="flex-1 flex min-h-0 relative overflow-hidden">
            <div
              ref={messagesContainerRef}
              className="flex-1 overflow-y-auto custom-scrollbar min-h-0"
              onScroll={(e) => {
                const el = e.currentTarget;
                scrollLockRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {messages.length === 0 ? (
                <WelcomeScreen
                  input={input}
                  setInput={setInput}
                  onSend={handleSend}
                  loading={loading || searching}
                  selectedModel={selectedModel}
                  models={models}
                  latencies={latencies}
                  onSelectModel={setActiveModel}
                  onRefreshLatencies={() => models.forEach(m => probeLatency(m.model_id))}
                  reasoningEnabled={reasoningEnabled}
                  onToggleReasoning={() => setReasoningEnabled(v => !v)}
                  webSearchEnabled={webSearchEnabled}
                  onToggleWebSearch={() => setWebSearchEnabled(v => !v)}
                  webSearchAvailable={chatConfig.search_enabled && chatConfig.search_provider && chatConfig.search_provider !== 'none'}
                />
              ) : (
                <div className="py-4 space-y-1 flex flex-col justify-end min-h-full">
                  {showLongContextWarning && (
                    <div className="max-w-3xl mx-auto mb-4 px-4">
                      <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg px-3 py-2">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        当前会话消息较多，建议新建对话以获得更好性能。
                      </div>
                    </div>
                  )}
                  {messages.map((msg, idx) => (
                    <ChatMessage
                      key={idx}
                      msg={
                        searching &&
                        idx === messages.length - 1 &&
                        msg.role === 'assistant'
                          ? { ...msg, reasoning: searchReasoning || msg.reasoning, searchProgress, sources: searchSources }
                          : msg
                      }
                      index={idx}
                      onRegenerate={idx === messages.length - 1 && msg.role === 'assistant' ? handleRegenerate : undefined}
                    />
                  ))}
                  <div ref={messagesEndRef} className="h-6" />
                </div>
              )}
            </div>
          </div>

        {messages.length > 0 && (
          <ChatInput
            input={input}
            setInput={setInput}
            onSend={handleSend}
            onStop={handleStop}
            loading={loading || searching}
            models={models}
            selectedModel={selectedModel}
            latencies={latencies}
            onSelectModel={setActiveModel}
            onRefreshLatencies={() => models.forEach(m => probeLatency(m.model_id))}
            reasoningEnabled={reasoningEnabled}
            onToggleReasoning={() => setReasoningEnabled(v => !v)}
            webSearchEnabled={webSearchEnabled}
            onToggleWebSearch={() => setWebSearchEnabled(v => !v)}
            webSearchAvailable={chatConfig.search_enabled && chatConfig.search_provider && chatConfig.search_provider !== 'none'}
          />
        )}
      </main>
    </div>
  );
}
