import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import SkeletonDashboard from '../components/skeletons/SkeletonDashboard';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { Activity, Zap, Gauge, DollarSign, TrendingUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAdminSSE } from '../hooks/useAdminSSE';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D', '#FFC0CB', '#A52A2A'];

function getThemeColors() {
  const isDark = document.documentElement.classList.contains('dark');
  return {
    text: isDark ? '#e2e8f0' : '#1e293b',
    textSecondary: isDark ? '#94a3b8' : '#64748b',
    bg: isDark ? '#1e293b' : '#ffffff',
    border: isDark ? '#334155' : '#e2e8f0',
  };
}

function CustomPieTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const c = getThemeColors();
  const d = payload[0];
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: '8px', padding: '8px 12px' }}>
      <p style={{ color: c.text, margin: 0, fontSize: '12px', fontWeight: 600 }}>{d.name}</p>
      <p style={{ color: d.payload?.fill || c.text, margin: '2px 0', fontSize: '12px' }}>
        {fmtTokens(d.value).toLocaleString()} tokens
      </p>
    </div>
  );
}

function CustomLegend({ payload }) {
  const c = getThemeColors();
  return (
    <div className="max-h-[280px] overflow-y-auto custom-scrollbar" style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingLeft: '12px', fontSize: '11px' }}>
      {payload?.map((entry, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: entry.color, flexShrink: 0 }} />
          <span style={{ color: c.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>{entry.value}</span>
          <span style={{ color: c.textSecondary, marginLeft: 'auto', whiteSpace: 'nowrap', fontSize: '10px' }}>
            {Number(entry.payload?.value || 0).toLocaleString()} tokens
          </span>
        </div>
      ))}
    </div>
  );
}

function fmtCost(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0.00';
  if (n === 0) return '0.00';
  const abs = Math.abs(n);
  const decimals = abs < 0.01 ? 4 : 2;
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtTokens(v) {
  if (v == null || v === 0) return 0;
  return Math.round(v);
}

const ITEMS_PER_PAGE = 10;

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [timeRange, setTimeRange] = useState('7d');
  const [trendData, setTrendData] = useState([]);
  const [trendLoading, setTrendLoading] = useState(false);
  const [modelPage, setModelPage] = useState(0);
  const [sourcePage, setSourcePage] = useState(0);
  const abortControllerRef = useRef(null);
  const isFetchingRef = useRef(false);

  const fetchOverview = useCallback(async (signal, { silent = false } = {}) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    if (!silent) setOverviewLoading(true);
    try {
      const res = await api.get('/admin/stats/overview', { signal });
      setStats(res.data);
    } catch (e) {
      // Ignore abort errors; keep existing stats on silent polls so the UI doesn't flicker
      const isAbort = e.name === 'CanceledError' || e.code === 'ERR_CANCELED' || e.name === 'AbortError';
      if (!isAbort) {
        console.error('[Dashboard] failed to fetch overview:', e);
      }
    } finally {
      isFetchingRef.current = false;
      if (!silent) setOverviewLoading(false);
    }
  }, []);

  useAdminSSE(['sources.changed', 'users.changed'], {
    'sources.changed': () => fetchOverview(abortControllerRef.current?.signal, { silent: true }),
    'users.changed': () => fetchOverview(abortControllerRef.current?.signal, { silent: true })
  });

  useEffect(() => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    fetchOverview(controller.signal);

    const interval = setInterval(() => {
      if (isFetchingRef.current) return;
      const controller = new AbortController();
      abortControllerRef.current = controller;
      fetchOverview(controller.signal, { silent: true });
    }, 10000);

    return () => {
      clearInterval(interval);
      abortControllerRef.current?.abort();
    };
  }, [fetchOverview]);

  useEffect(() => {
    const controller = new AbortController();
    setTrendLoading(true);
    api.get(`/admin/stats/tokens?range=${timeRange}`, { signal: controller.signal })
      .then((res) => {
        const data = (res.data || []).map((d) => ({
          ...d,
          tokens: fmtTokens(d.tokens),
          cost: fmtCost(d.cost),
        }));
        setTrendData(data);
      })
      .catch(() => setTrendData([]))
      .finally(() => setTrendLoading(false));

    return () => controller.abort();
  }, [timeRange]);

  if (overviewLoading) {
    return <SkeletonDashboard />;
  }

  const pieData = stats?.byModel?.map((m) => ({
    name: m.model?.split('/').pop() || m.model,
    value: fmtTokens(m.tokens),
  })).filter(d => d.value > 0) || [];

  // Pagination for byModel
  const allModels = stats?.byModel || [];
  const totalModelPages = Math.ceil(allModels.length / ITEMS_PER_PAGE);
  const pagedModels = allModels.slice(modelPage * ITEMS_PER_PAGE, (modelPage + 1) * ITEMS_PER_PAGE);

  // Pagination for bySource
  const allSources = stats?.bySource || [];
  const totalSourcePages = Math.ceil(allSources.length / ITEMS_PER_PAGE);
  const pagedSources = allSources.slice(sourcePage * ITEMS_PER_PAGE, (sourcePage + 1) * ITEMS_PER_PAGE);

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">仪表盘</h1>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">今日请求</CardTitle>
            <Activity className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate">
              {stats?.today?.requests?.toLocaleString() || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              平均延迟: {Math.round(stats?.today?.avg_latency || 0)}ms
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">今日Token</CardTitle>
            <Zap className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate">
              {fmtTokens(stats?.today?.tokens).toLocaleString() || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">今日消费</CardTitle>
            <DollarSign className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate">
              {fmtCost(stats?.today?.cost)}
            </div>
            <p className="text-xs text-muted-foreground">元</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">总请求量</CardTitle>
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate">
              {stats?.total?.requests?.toLocaleString() || 0}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">总消费</CardTitle>
            <DollarSign className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate">
              {fmtCost(stats?.total?.cost)}
            </div>
            <p className="text-xs text-muted-foreground">元</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">总Token</CardTitle>
            <Zap className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate">
              {fmtTokens(stats?.total?.tokens).toLocaleString() || 0}
            </div>
            <p className="text-xs text-muted-foreground">
              累计消耗 tokens
            </p>
          </CardContent>
        </Card>
      </div>

      {stats?.concurrency && stats.concurrency.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="w-5 h-5" />
              源站并发状态
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {stats.concurrency.map((c) => (
                <div key={c.id} className="p-4 border rounded-lg">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-sm text-muted-foreground">{c.current_concurrent}/{c.max_concurrent}</span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all ${c.utilization > 80 ? 'bg-red-500' : c.utilization > 50 ? 'bg-yellow-500' : 'bg-primary'}`}
                      style={{ width: `${c.utilization}%` }}
                    />
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    使用率: {c.utilization}%
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Token 与消费趋势</CardTitle>
            <select
              className="h-8 rounded border bg-background px-2 text-sm"
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value)}
            >
              <option value="5m">5分钟</option>
              <option value="1h">1小时</option>
              <option value="6h">6小时</option>
              <option value="24h">24小时</option>
              <option value="7d">7天</option>
              <option value="30d">30天</option>
            </select>
          </CardHeader>
          <CardContent>
            {trendLoading && trendData.length === 0 ? (
              <div className="text-center text-muted-foreground py-10">加载中...</div>
            ) : trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={340}>
                <AreaChart data={trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradTokensAdmin" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradCostAdmin" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} dy={8} />
                  <YAxis yAxisId="left" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} width={60} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} width={60} />
                  <Tooltip
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '12px', color: 'hsl(var(--card-foreground))', boxShadow: '0 4px 20px rgba(0,0,0,0.15)' }}
                    formatter={(value, name) => {
                      if (name === '消费(USD)') return [`$${fmtCost(value)}`, name];
                      return [Number(value).toLocaleString(), name];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 16 }} />
                  <Area yAxisId="left" type="monotone" dataKey="tokens" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#gradTokensAdmin)" name="Token数" dot={false} activeDot={{ r: 4 }} />
                  <Area yAxisId="right" type="monotone" dataKey="cost" stroke="#22c55e" strokeWidth={2.5} fill="url(#gradCostAdmin)" name="消费(USD)" dot={false} activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center text-muted-foreground py-10">暂无数据</div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>模型分布 (7天)</CardTitle>
          </CardHeader>
          <CardContent>
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={360}>
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="45%"
                    cy="50%"
                    labelLine={false}
                    label={false}
                    outerRadius={110}
                    innerRadius={50}
                    fill="#8884d8"
                    dataKey="value"
                    paddingAngle={2}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomPieTooltip />} />
                  <Legend
                    layout="vertical"
                    verticalAlign="middle"
                    align="right"
                    content={<CustomLegend />}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center text-muted-foreground py-10">暂无数据</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>按源站统计 (7天)</CardTitle>
            {allSources.length > ITEMS_PER_PAGE && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setSourcePage(p => Math.max(0, p - 1))}
                  disabled={sourcePage === 0}
                  className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span className="text-xs text-muted-foreground">{sourcePage + 1} / {totalSourcePages}</span>
                <button
                  onClick={() => setSourcePage(p => Math.min(totalSourcePages - 1, p + 1))}
                  disabled={sourcePage >= totalSourcePages - 1}
                  className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {pagedSources.length > 0 ? pagedSources.map((s) => (
                <div key={s.name} className="flex items-center justify-between">
                  <span className="font-medium">{s.name}</span>
                  <div className="text-right">
                    <div className="text-sm">{s.count?.toLocaleString()} 次请求</div>
                    <div className="text-xs text-muted-foreground">
                      {fmtTokens(s.tokens).toLocaleString()} tokens | ${fmtCost(s.cost)}
                    </div>
                  </div>
                </div>
              )) : <div className="text-center text-muted-foreground py-10">暂无数据</div>}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>模型消耗排名 (7天)</CardTitle>
          {allModels.length > ITEMS_PER_PAGE && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setModelPage(p => Math.max(0, p - 1))}
                disabled={modelPage === 0}
                className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-muted-foreground">{modelPage + 1} / {totalModelPages}</span>
              <button
                onClick={() => setModelPage(p => Math.min(totalModelPages - 1, p + 1))}
                disabled={modelPage >= totalModelPages - 1}
                className="p-1 rounded hover:bg-accent disabled:opacity-30 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {pagedModels.length > 0 ? pagedModels.map((m, i) => (
              <div key={m.model} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-muted-foreground w-6">{modelPage * ITEMS_PER_PAGE + i + 1}.</span>
                  <code className="text-xs">{m.model}</code>
                </div>
                <div className="text-right">
                  <div className="text-sm">{m.count?.toLocaleString()} 次</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtTokens(m.tokens).toLocaleString()} tokens | ${fmtCost(m.cost)}
                  </div>
                </div>
              </div>
            )) : <div className="text-center text-muted-foreground py-10">暂无数据</div>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
