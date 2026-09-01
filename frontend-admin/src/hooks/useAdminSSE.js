import { useEffect, useRef } from 'react';

const API_URL = import.meta.env.VITE_API_URL || '/api';

/**
 * useAdminSSE
 * 订阅 /admin/events/stream，按 event 类型分发给 handlers。
 * 支持自动重连（指数退避 2s~30s），断线时触发 onDisconnect 供调用方降级到轮询。
 *
 * handlers: { [eventName]: (payload) => void }
 * events: string[] — 需要监听的 event 名称列表
 */
export function useAdminSSE(events, handlers, { enabled = true } = {}) {
  const esRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const retryDelayRef = useRef(2000);
  const handlersRef = useRef(handlers);

  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    const token = localStorage.getItem('token');
    if (!token) return;

    const connect = () => {
      if (esRef.current) {
        try { esRef.current.close(); } catch (e) {}
      }

      const url = `${API_URL}/admin/events/stream?token=${encodeURIComponent(token)}`;
      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => {
        retryDelayRef.current = 2000;
      };

      events.forEach(eventName => {
        es.addEventListener(eventName, (e) => {
          try {
            const payload = JSON.parse(e.data);
            handlersRef.current[eventName]?.(payload);
          } catch (err) {
            console.error('[useAdminSSE] failed to parse event:', eventName, e.data, err);
          }
        });
      });

      es.onerror = () => {
        try { es.close(); } catch (e) {}
        esRef.current = null;
        // 指数退避重连
        reconnectTimerRef.current = setTimeout(() => {
          retryDelayRef.current = Math.min(retryDelayRef.current * 1.5, 30000);
          connect();
        }, retryDelayRef.current);
      };
    };

    connect();

    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (esRef.current) {
        try { esRef.current.close(); } catch (e) {}
        esRef.current = null;
      }
    };
  }, [enabled, events.join(',')]);
}
