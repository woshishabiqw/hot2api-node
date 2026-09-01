import { useEffect, useState, useCallback, useRef, memo, useMemo } from 'react';
import api from '../lib/api';
import { Button } from '../components/Button';
import { RefreshCw, Wifi, Activity, AlertCircle, CheckCircle, Clock } from 'lucide-react';

/* ─── 颜色阈值 ─── */
const BARS = 40; // 与前台模型广场保持一致
const PROTO_COLORS = {
  openai: { dot: '#22c55e', label: 'OpenAI', bg: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  anthropic: { dot: '#f59e0b', label: 'Anthropic', bg: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  gemini: { dot: '#3b82f6', label: 'Gemini', bg: 'bg-blue-500/15 text-blue-600 dark:text-blue-400' },
  bedrock: { dot: '#f97316', label: 'Bedrock', bg: 'bg-orange-500/15 text-orange-600 dark:text-orange-400' },
};

// 全局tooltip单例管理
let currentTooltipId = null;

function latencyColor(ms, status) {
  if (!ms || status === 'error' || status === 'invalid_key') return { bar: '#374151', text: '#6b7280' };
  if (ms < 200)  return { bar: '#22c55e', text: '#16a34a' };
  if (ms < 500)  return { bar: '#84cc16', text: '#65a30d' };
  if (ms < 800)  return { bar: '#f59e0b', text: '#d97706' };
  if (ms < 1500) return { bar: '#f97316', text: '#ea580c' };
  return { bar: '#ef4444', text: '#dc2626' };
}

function latencyLabel(ms, status) {
  if (status === 'error') return 'err';
  if (!ms) return '-';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/* ─── localStorage 历史管理 ─── */
const HISTORY_KEY = 'probe-history-v2';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); }
  catch { return {}; }
}

function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {}
}

// 尽可能保持对象引用不变，减少 React 重渲染
function mergeHistory(history, freshData) {
  const activeIds = new Set(freshData.map(s => String(s.id)));
  let next = history;
  let changed = false;

  // 移除已删除源站
  for (const id of Object.keys(history)) {
    if (!activeIds.has(id)) {
      if (!changed) { next = { ...history }; changed = true; }
      delete next[id];
    }
  }

  const ts = Date.now();
  for (const source of freshData) {
    const sid = String(source.id);
    let sourceHistory = next[sid];
    let sourceChanged = false;

    for (const [proto, info] of Object.entries(source.probe || {})) {
      const arr = sourceHistory?.[proto];
      const last = arr?.[arr.length - 1];
      const newData = { ms: info.latencyMs || 0, status: info.status, error: info.error || null, ts };

      // 只有当数据真正变化时才添加，且只复制受影响的分支
      if (!last || last.ms !== newData.ms || last.status !== newData.status) {
        if (!sourceChanged) {
          sourceHistory = sourceHistory ? { ...sourceHistory } : {};
          sourceChanged = true;
        }
        sourceHistory[proto] = arr ? [...arr.slice(-(BARS - 1)), newData] : [newData];
      }
    }

    if (sourceChanged) {
      if (!changed) { next = { ...history }; changed = true; }
      next[sid] = sourceHistory;
    }
  }

  return changed ? next : history;
}

/* ─── 悬浮批注框 ─── */
function ProtoTooltip({ data, isError, lastOk, lastErr, validMs }) {
  const avg = validMs.length > 0 ? Math.round(validMs.reduce((a, b) => a + b, 0) / validMs.length) : 0;
  const min = validMs.length > 0 ? Math.min(...validMs) : 0;
  const max = validMs.length > 0 ? Math.max(...validMs) : 0;
  const fmtTs = (ts) => {
    if (!ts) return '-';
    const d = new Date(ts);
    return isNaN(d.getTime()) ? String(ts) : d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div
      className="absolute z-[9999] bottom-full left-1/2 mb-2 w-56 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl text-xs"
      style={{ transform: 'translateX(-50%)' }}
    >
      <div className="px-3 py-2.5 space-y-2">
        {isError ? (
          <>
            <div className="flex items-center gap-1.5 text-destructive font-semibold">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              探测失败
            </div>
            <div className="text-muted-foreground break-all leading-snug">
              {lastErr?.error || lastErr?.status || '未知错误'}
            </div>
            {lastErr?.status === 'invalid_key' && (
              <div className="text-amber-500 text-[10px]">密钥无效或权限不足，请检查源站配置</div>
            )}
            <div className="flex items-center gap-1 text-muted-foreground/60 text-[10px]">
              <Clock className="w-3 h-3" />
              最后探测 {fmtTs(lastErr?.ts)}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 font-semibold">
              <CheckCircle className="w-3.5 h-3.5 shrink-0" />
              探测正常
            </div>
            {validMs.length > 0 ? (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-muted-foreground text-[10px]">最低</div>
                  <div className="font-semibold tabular-nums">{min}ms</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-[10px]">平均</div>
                  <div className="font-semibold tabular-nums">{avg}ms</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-[10px]">最高</div>
                  <div className="font-semibold tabular-nums">{max}ms</div>
                </div>
              </div>
            ) : (
              <div className="text-muted-foreground text-[10px]">暂无有效数据</div>
            )}
          </>
        )}
      </div>
      {/* 小三角 */}
      <div
        className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
        style={{ borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '6px solid hsl(var(--border))' }}
      />
    </div>
  );
}

/* ─── 单协议延迟行 ─── */
const ProtoRow = memo(function ProtoRow({ protocol, history }) {
  const [hovered, setHovered] = useState(false);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef(null);
  const rowRef = useRef(null);
  const tooltipId = useRef(`proto-${Math.random().toString(36).substr(2, 9)}`);
  const meta = PROTO_COLORS[protocol] || { dot: '#6b7280', label: protocol, bg: 'bg-secondary text-secondary-foreground' };
  const bars = Array.from({ length: BARS }, (_, i) => history[i] || null);

  // 只取 ok 状态的最后一条（修复：错误条目的 ms>0 不应被当作成功）
  const lastOk = [...history].reverse().find(h => h?.status === 'ok' && h.ms > 0);
  const lastErr = [...history].reverse().find(h => h?.status === 'error' || h?.status === 'invalid_key');
  const col = latencyColor(lastOk?.ms, lastOk?.status);

  // 动态 max：只用 ok 状态的 ms 值，避免错误耗时拉高比例
  const validMs = bars.filter(b => b?.status === 'ok' && b.ms > 0).map(b => b.ms);
  const maxMs = validMs.length > 0 ? Math.max(...validMs) : 500;

  const isError = !lastOk && !!lastErr;

  // 移出 3s CD
  const handleMouseLeave = () => {
    setHovered(false);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 3000);
  };

  // 全局tooltip单例显示
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (rowRef.current && !rowRef.current.contains(e.target)) {
        setVisible(false);
        if (hideTimer.current) clearTimeout(hideTimer.current);
        if (currentTooltipId === tooltipId.current) {
          currentTooltipId = null;
        }
      }
    };

    const handleOtherTooltipShow = (e) => {
      if (e.detail.tooltipId !== tooltipId.current) {
        setVisible(false);
        if (hideTimer.current) clearTimeout(hideTimer.current);
      }
    };

    if (visible) {
      document.addEventListener('click', handleClickOutside);
      document.addEventListener('tooltip-show', handleOtherTooltipShow);
      // 通知其他tooltip隐藏
      document.dispatchEvent(new CustomEvent('tooltip-show', { detail: { tooltipId: tooltipId.current } }));
    }

    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('tooltip-show', handleOtherTooltipShow);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [visible]);

  return (
    <div className="relative">
      {visible && (
        <ProtoTooltip
          isError={isError}
          lastOk={lastOk}
          lastErr={lastErr}
          validMs={validMs}
        />
      )}
      <div ref={rowRef} className="flex items-center gap-2 py-1 w-full overflow-hidden min-w-0"
        onMouseEnter={() => { setHovered(true); setVisible(true); if (hideTimer.current) clearTimeout(hideTimer.current); }}
        onMouseLeave={handleMouseLeave}>
        {/* 状态点 */}
        <span className="relative flex h-2 w-2 shrink-0">
          {!isError && <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-50" style={{ backgroundColor: col.bar }} />}
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: isError ? '#ef4444' : col.bar }} />
        </span>
        {/* 协议标签 */}
        <span className="shrink-0 text-[10px] font-medium w-14 truncate text-muted-foreground" title={meta.label || protocol}>
          {meta.label || protocol}
        </span>
        {/* 方块行 */}
        <div className="flex items-end gap-[2px] flex-1 h-8">
          {bars.map((b, i) => {
            if (!b) return <div key={i} className="w-1 rounded-[2px] bg-muted" style={{ height: 10 }} />;
            if (b.status !== 'ok') {
              return <div key={i} className="w-1 rounded-[2px]"
                style={{ height: 4, backgroundColor: '#ef4444', opacity: i === bars.length - 1 ? 0.9 : 0.35 }} />;
            }
            const { bar } = latencyColor(b.ms, b.status);
            const MAX_BAR_HEIGHT = 32;
            const h = Math.min(MAX_BAR_HEIGHT, Math.max(4, Math.round((b.ms / maxMs) * MAX_BAR_HEIGHT)));
            return (
              <div key={i} className="w-1 rounded-[2px]"
                style={{ height: h, backgroundColor: bar, opacity: i === bars.length - 1 ? 1 : 0.5 + (i / BARS) * 0.5 }} />
            );
          })}
        </div>
        {/* 数值 */}
        <span className="shrink-0 text-[11px] tabular-nums font-semibold w-12 text-right truncate"
          style={{ color: isError ? '#ef4444' : col.text }}>
          {isError ? '离线' : latencyLabel(lastOk?.ms, lastOk?.status)}
        </span>
      </div>
    </div>
  );
});

/* ─── 单源站卡片 ─── */
const SourceCard = memo(function SourceCard({ source, history }) {
  const sourceHistory = history[String(source.id)] || {};
  const protocols = Object.keys(source.probe || {})
    .filter(p => source.probe[p]?.latencyMs > 0 || source.probe[p]?.status === 'error');

  if (protocols.length === 0) return null;

  // 整体状态
  const allOk = protocols.every(p => source.probe[p]?.status === 'ok');
  const anyOk = protocols.some(p => source.probe[p]?.status === 'ok');
  const statusColor = allOk ? '#22c55e' : anyOk ? '#f59e0b' : '#ef4444';
  const statusLabel = allOk ? '正常' : anyOk ? '部分' : '离线';

  // 平均延迟
  const latencies = protocols.map(p => source.probe[p]?.latencyMs || 0).filter(Boolean);
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  return (
    <div className="rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md">
      {/* 卡片头 */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30 rounded-t-xl">
        <div className="flex items-center gap-2 min-w-0">
          {/* 状态脉冲点 */}
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            {allOk && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                style={{ backgroundColor: statusColor }} />
            )}
            <span className="relative inline-flex rounded-full h-2.5 w-2.5"
              style={{ backgroundColor: statusColor }} />
          </span>
          <span className="font-semibold text-sm truncate">{source.name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {avgMs > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">
              均 {latencyLabel(avgMs, 'ok')}
            </span>
          )}
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-md"
            style={{ backgroundColor: statusColor + '22', color: statusColor }}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* 协议延迟行 */}
      <div className="px-4 py-3 space-y-2.5">
        {protocols.sort().map(proto => (
          <ProtoRow key={proto} protocol={proto} history={sourceHistory[proto] || []} />
        ))}
      </div>
    </div>
  );
});

/* ─── 主页面 ─── */
export default function Probe() {
  const [probeData, setProbeData] = useState([]);
  const [history, setHistory] = useState(loadHistory);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [sources, setSources] = useState([]);
  const sourcesRef = useRef([]);
  const saveTimer = useRef(null);

  const isFirstLoad = useRef(true);

  // 将 localStorage 写入防抖到下一帧，避免每次 SSE 都同步写磁盘
  const persistHistory = useCallback((next) => {
    if (saveTimer.current) cancelAnimationFrame(saveTimer.current);
    saveTimer.current = requestAnimationFrame(() => {
      saveHistory(next);
      saveTimer.current = null;
    });
  }, []);

  // Update ref when sources change
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  // 清理未执行的持久化任务
  useEffect(() => {
    return () => {
      if (saveTimer.current) cancelAnimationFrame(saveTimer.current);
    };
  }, []);

  const loadProbe = useCallback(async (manual = false) => {
    // 仅首次加载或手动刷新时显示 loading
    if (isFirstLoad.current || manual) setLoading(true);
    try {
      const res = await api.get('/admin/sources/probe');
      const fresh = res.data || [];
      setProbeData(fresh);
      setHistory(prev => {
        const next = mergeHistory(prev, fresh);
        persistHistory(next);
        return next;
      });
      setLastUpdate(new Date());
    } catch (e) {
      console.error('[Probe] load failed:', e);
    } finally {
      if (isFirstLoad.current || manual) setLoading(false);
      isFirstLoad.current = false;
    }
  }, []);

  useEffect(() => {
    // Load sources
    api.get('/admin/sources').then(res => {
      setSources(res.data || []);
    });
  }, []);

  useEffect(() => {
    // Only establish SSE connection after sources are loaded
    if (sources.length === 0) return;

    const token = localStorage.getItem('token');
    let eventSource = null;
    let retryTimer = null;

    const connectSSE = () => {
      if (eventSource) eventSource.close();

      eventSource = new EventSource(`/api/admin/sources/probe/stream?token=${token}`);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          // Merge probe data with source names
          const merged = sourcesRef.current.map(s => ({
            id: s.id,
            name: s.name,
            probe: data[s.id] || {}
          }));

          setProbeData(merged);
          setHistory(prev => {
            const next = mergeHistory(prev, merged);
            persistHistory(next);
            return next;
          });
          setLastUpdate(new Date());
        } catch (e) {
          console.error('[Probe] SSE parse error:', e);
        }
      };

      eventSource.onerror = (e) => {
        console.error('[Probe] SSE error, reconnecting in 3s...');
        eventSource.close();
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(connectSSE, 3000);
      };
    };

    connectSSE();

    return () => {
      if (eventSource) eventSource.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [sources]);

  const visibleSources = useMemo(() =>
    probeData.filter(s => Object.keys(s.probe || {}).length > 0),
    [probeData]
  );

  const totalOk = useMemo(() =>
    visibleSources.filter(s => Object.values(s.probe || {}).every(p => p.status === 'ok')).length,
    [visibleSources]
  );

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" />
            源站延迟
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            实时监控各源站在不同协议下的响应延迟 · 正常源站约每 5 分钟探测一次，状态变化实时推送
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => loadProbe(true)} disabled={loading}>
            <RefreshCw className={"w-4 h-4 mr-1.5 " + (loading ? "animate-spin" : "")} />
            刷新
          </Button>
        </div>
      </div>

      {/* 汇总条 */}
      {visibleSources.length > 0 && (
        <div className="flex items-center gap-4 rounded-xl border bg-card px-4 py-3 text-sm">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="font-medium">{totalOk}</span>
            <span className="text-muted-foreground">正常</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            <span className="font-medium">{visibleSources.length - totalOk}</span>
            <span className="text-muted-foreground">异常</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block w-3 h-2 rounded-[2px] bg-emerald-500 opacity-70" />
            &lt;200ms
            <span className="inline-block w-3 h-2 rounded-[2px] bg-amber-500 opacity-70 ml-2" />
            &lt;800ms
            <span className="inline-block w-3 h-2 rounded-[2px] bg-red-500 opacity-70 ml-2" />
            ≥800ms
          </div>
        </div>
      )}

      {/* 卡片网格 */}
      {visibleSources.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Wifi className="w-10 h-10 mb-3 opacity-30" />
          <p className="font-medium">暂无探针数据</p>
          <p className="text-sm mt-1">等待首次探测（每5分钟自动探测）</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visibleSources.map(source => (
            <SourceCard key={source.id} source={source} history={history} />
          ))}
        </div>
      )}
    </div>
  );
}
