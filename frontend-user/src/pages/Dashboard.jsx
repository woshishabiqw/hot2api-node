import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import api from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/Card';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import { Zap, TrendingUp, Key, DollarSign, Server, Wallet, CreditCard, ArrowRight, History, Loader2, LayoutGrid, User, Users } from 'lucide-react';
import { formatAmountInput, fmtMoney } from '../lib/utils';
import CardSkeleton from '../components/skeletons/CardSkeleton';
import ChartCardSkeleton from '../components/skeletons/ChartCardSkeleton';
import TableCardSkeleton from '../components/skeletons/TableCardSkeleton';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D'];

function getThemeColors() {
  const isDark = document.documentElement.classList.contains('dark');
  return {
    text: isDark ? '#e2e8f0' : '#1e293b',
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
        {Number(d.value).toLocaleString()} tokens
      </p>
    </div>
  );
}

function CustomLegend({ payload }) {
  const c = getThemeColors();
  if (!Array.isArray(payload)) return null;
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

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [statsLoading, setStatsLoading] = useState(true);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [currency, setCurrency] = useState('CNY');
  const [timeRange, setTimeRange] = useState('7d');
  const statsAbortRef = useRef(null);
  const [showRecharge, setShowRecharge] = useState(false);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [rechargeChannel, setRechargeChannel] = useState('');
  const [channels, setChannels] = useState([]);
  const [rechargeLoading, setRechargeLoading] = useState(false);
  const [billingRecords, setBillingRecords] = useState([]);
  const [showBilling, setShowBilling] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState(null);
  const [viewMode, setViewMode] = useState('overview'); // 'overview' | 'personal' | 'team'
  const didMountRef = useRef(false);

  const loadWorkspaces = async () => {
    try {
      const res = await api.get('/workspaces');
      const ws = res.data || [];
      setWorkspaces(ws);
      if (ws.length > 0 && !selectedWorkspace) {
        setSelectedWorkspace(ws[0]);
      }
    } catch (e) {
      console.error('Failed to load workspaces:', e);
    }
  };

  const loadStats = useCallback(async (range, cur) => {
    statsAbortRef.current?.abort();
    const controller = new AbortController();
    statsAbortRef.current = controller;
    const currencyParam = cur || currency;
    setStatsLoading(true);
    try {
      const res = await api.get(`/user/stats?range=${range}&currency=${currencyParam}`, { signal: controller.signal });
      setStats(res.data);
    } catch (e) {
      const isAbort = e.name === 'CanceledError' || e.code === 'ERR_CANCELED' || e.name === 'AbortError';
      if (!isAbort) {
        console.error('Failed to load stats:', e);
      }
    } finally {
      setStatsLoading(false);
    }
  }, [currency]);

  const loadChannels = async () => {
    try {
      const res = await api.get('/payment-gateway/payment-channels');
      setChannels(res.data.filter(c => c.is_active) || []);
    } catch (e) {
      console.error('Failed to load channels:', e);
    }
  };

  const loadBillingRecords = useCallback(async () => {
    if (!selectedWorkspace) return;
    try {
      const res = await api.get(`/workspaces/${selectedWorkspace.id}/billing`);
      setBillingRecords(res.data.records || []);
    } catch (e) {
      console.error('Failed to load billing records:', e);
    }
  }, [selectedWorkspace]);

  const handleRecharge = useCallback(async () => {
    const amount = parseFloat(rechargeAmount);
    if (!rechargeAmount || Number.isNaN(amount) || amount <= 0) {
      alert('请输入有效的充值金额');
      return;
    }
    if (amount > 1000) {
      alert(`充值金额最大为 ${currencySymbol}1000.00`);
      return;
    }
    const decimals = (rechargeAmount.split('.')[1] || '').length;
    if (decimals > 2) {
      alert('充值金额最多保留两位小数');
      return;
    }
    if (!rechargeChannel) {
      alert('请选择支付渠道');
      return;
    }
    if (!selectedWorkspace) {
      alert('请选择工作空间');
      return;
    }

    setRechargeLoading(true);
    try {
      const res = await api.post('/billing/recharge', {
        workspace_id: selectedWorkspace.id,
        amount,
        channel: rechargeChannel,
        payment_method: 'qrcode',
        return_url: window.location.href
      });
      
      if (res.data.qrDataUrl || res.data.qr_data_url) {
        alert('请前往「我的钱包」扫码支付');
      } else if (res.data.paymentUrl || res.data.payment_url) {
        window.location.href = res.data.paymentUrl || res.data.payment_url;
      } else if (res.data.form) {
        document.body.innerHTML = res.data.form;
        document.body.querySelector('form')?.submit();
      } else {
        alert('充值请求已提交');
        loadStats(timeRange);
      }
    } catch (e) {
      alert(e.response?.data?.error || '充值失败');
    }
    setRechargeLoading(false);
  }, [rechargeAmount, selectedWorkspace, rechargeChannel, loadStats, timeRange]);

  // Initial load: fetch workspaces, stats, channels in parallel with independent loading states
  useEffect(() => {
    setWorkspacesLoading(true);
    setStatsLoading(true);
    setChannelsLoading(true);

    loadStats(timeRange, currency);

    Promise.allSettled([
      api.get('/workspaces'),
      api.get('/payment-gateway/payment-channels'),
    ])
      .then(([wsRes, chRes]) => {
        if (wsRes.status === 'fulfilled') {
          const ws = wsRes.value.data || [];
          setWorkspaces(ws);
          if (ws.length > 0) {
            setSelectedWorkspace(ws[0]);
          }
        } else {
          console.error('Failed to load workspaces:', wsRes.reason);
        }
        if (chRes.status === 'fulfilled') {
          setChannels((chRes.value.data || []).filter(c => c.is_active));
        } else {
          console.error('Failed to load channels:', chRes.reason);
        }
      })
      .finally(() => {
        setWorkspacesLoading(false);
        setChannelsLoading(false);
      });
    // Note: stats loading is handled inside loadStats; loadStats is stable due to useCallback.
  }, []);

  // Reload stats when timeRange or currency changes (skip mount; initial load already covers it)
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    loadStats(timeRange, currency);
  }, [timeRange, currency, loadStats]);

  const currencySymbol = currency === 'USD' ? '$' : '¥';
  
  const overviewData = useMemo(() => {
    const personalBalance = Number(stats?.personal_balance) || 0;
    const workspaceBalance = workspaces.reduce((sum, w) => sum + (Number(w.balance) || 0), 0);
    const totalBalance = personalBalance + workspaceBalance;
    const totalQuotaLimit = workspaces.reduce((sum, w) => sum + (Number(w.quota_limit) || 0), 0);
    const totalQuotaUsed = workspaces.reduce((sum, w) => sum + (Number(w.quota_used) || 0), 0);
    const totalWs = workspaces.length;
    const ownerCount = workspaces.filter(w => w.member_role === 'owner').length;
    return { personalBalance, workspaceBalance, totalBalance, totalQuotaLimit, totalQuotaUsed, totalWs, ownerCount };
  }, [workspaces, stats]);

  const pieData = stats?.model_distribution?.map((m) => ({
    name: m.model?.split('/').pop() || m.model,
    value: m.tokens || 0,
  })).filter(d => d.value > 0) || [];

  const trendData = stats?.daily?.map(d => ({
    ...d,
    cost: Number(d.cost || 0),
    tokens: Math.round(d.tokens || 0)
  })) || [];

  const recentLogRows = useMemo(() => {
    if (!stats?.recent_logs?.length) return [];
    let runningBalance = stats.personal_balance || 0;
    return stats.recent_logs.map((log) => {
      const cached = log.cached_tokens || 0;
      const uncached = log.uncached_tokens || (log.input_tokens - cached);
      const cacheRate = log.input_tokens > 0 ? cached / log.input_tokens : 0;
      const balanceAfter = runningBalance;
      runningBalance -= (log.cost || 0);
      return {
        ...log,
        cached,
        uncached,
        cacheRate,
        balanceAfter,
        formattedTime: new Date(log.created_at).toLocaleString(),
      };
    });
  }, [stats]);

  const personalFeatures = useMemo(() => {
    if (statsLoading) {
      return (
        <>
          <CardSkeleton rows={2} />
          <div className="grid gap-4 md:grid-cols-2">
            <ChartCardSkeleton height={300} hasSelect />
            <ChartCardSkeleton height={360} />
          </div>
          <TableCardSkeleton rows={5} />
        </>
      );
    }
    return (
    <>
      {/* Personal Balance Management */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="w-5 h-5" />
            余额管理
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">账户独立余额</div>
            <div className={`text-xl font-bold truncate ${(stats?.personal_balance || 0) <= 0 ? 'text-destructive' : ''}`}>
              {`${currencySymbol}${fmtMoney(stats?.personal_balance)}`}
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-2">
            充值/计费将应用到当前默认工作空间：{selectedWorkspace?.name || '未选择'}
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => setShowRecharge(!showRecharge)} disabled={!selectedWorkspace}>
              <CreditCard className="w-4 h-4 mr-1" />
              充值
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setShowBilling(!showBilling); if (!showBilling) loadBillingRecords(); }} disabled={!selectedWorkspace}>
              <History className="w-4 h-4 mr-1" />
              计费记录
            </Button>
          </div>
          {showRecharge && (
            <div className="mt-4 p-4 bg-muted/30 rounded-md space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">充值金额</label>
                  <Input
                    type="number"
                    placeholder="100"
                    value={rechargeAmount}
                    onChange={e => setRechargeAmount(formatAmountInput(e.target.value))}
                    min="1"
                    max="1000"
                    step="0.01"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">支付渠道</label>
                  <select
                    value={rechargeChannel}
                    onChange={e => setRechargeChannel(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">请选择</option>
                    {channels.map(ch => (
                      <option key={ch.id} value={ch.type}>{ch.name} ({ch.env === 'production' ? '生产' : '沙盒'})</option>
                    ))}
                  </select>
                </div>
              </div>
              <Button size="sm" onClick={handleRecharge} disabled={rechargeLoading} className="w-full">
                {rechargeLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-2" />}
                立即充值
              </Button>
            </div>
          )}
          {showBilling && (
            <div className="mt-4 space-y-2">
              <div className="text-sm font-medium">计费记录</div>
              {!billingRecords || billingRecords.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center bg-muted/30 rounded-md">
                  暂无计费记录
                </div>
              ) : (
                <div className="space-y-1 max-h-60 overflow-auto">
                  {billingRecords.slice(0, 10).map(record => (
                    <div key={record.id} className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/30 text-sm">
                      <div className="flex-1">
                        <div className="font-medium">{record.description || record.type}</div>
                        <div className="text-xs text-muted-foreground">{new Date(record.created_at).toLocaleString()}</div>
                      </div>
                      <div className={`font-medium ${record.type === 'recharge' ? 'text-green-600' : 'text-red-600'}`}>
                        {record.type === 'recharge' ? '+' : '-'}{currencySymbol}{fmtMoney(record.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Token使用趋势</CardTitle>
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
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={trendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
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
                      if (name === '消费') return [`${currencySymbol}${fmtMoney(value)}`, name];
                      return [Number(value).toLocaleString(), name];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, paddingTop: 16 }} />
                  <Area yAxisId="left" type="monotone" dataKey="tokens" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#gradTokens)" name="Token数" dot={false} activeDot={{ r: 4 }} />
                  <Area yAxisId="right" type="monotone" dataKey="cost" stroke="#22c55e" strokeWidth={2.5} fill="url(#gradCost)" name="消费" dot={false} activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center text-muted-foreground py-10">
                暂无使用数据，开始调用API吧！
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>模型分布</CardTitle>
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
      </div>
      <Card>
        <CardHeader>
          <CardTitle>最近使用</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {stats?.recent_logs?.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b">
                  <tr>
                    <th className="p-3 text-left text-xs font-medium">时间</th>
                    <th className="p-3 text-left text-xs font-medium">模型</th>
                    <th className="p-3 text-left text-xs font-medium">输入(未/缓)</th>
                    <th className="p-3 text-left text-xs font-medium">输出</th>
                    <th className="p-3 text-left text-xs font-medium">命中率</th>
                    <th className="p-3 text-left text-xs font-medium">消费</th>
                    <th className="p-3 text-left text-xs font-medium">扣款后余额</th>
                    <th className="p-3 text-left text-xs font-medium">延迟</th>
                    <th className="p-3 text-left text-xs font-medium">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogRows.map((log) => (
                    <tr key={log.id} className="border-b">
                      <td className="p-3 text-xs">{log.formattedTime}</td>
                      <td className="p-3"><code className="text-xs">{log.model}</code></td>
                      <td className="p-3">
                        <div className="text-xs">
                          {log.input_tokens}
                          <span className="text-muted-foreground ml-1">
                            (<span className="text-foreground">{log.uncached}</span>/<span className="text-green-600">{log.cached}</span>)
                          </span>
                        </div>
                      </td>
                      <td className="p-3 text-xs">{log.output_tokens?.toLocaleString() || 0}</td>
                      <td className="p-3">
                        {log.input_tokens > 0 ? (
                          <Badge variant={log.cacheRate > 0.5 ? 'success' : log.cacheRate > 0 ? 'warning' : 'secondary'} className="text-xs">
                            {Math.round(log.cacheRate * 100)}%
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="p-3 text-xs">{`${currencySymbol}${fmtMoney(log.cost)}`}</td>
                      <td className="p-3 text-xs">{`${currencySymbol}${fmtMoney(log.balanceAfter)}`}</td>
                      <td className="p-3 text-xs">{log.latency_ms}ms</td>
                      <td className="p-3">
                        <Badge variant={log.status_code === 200 ? 'success' : 'destructive'}>
                          {log.status_code}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-6 text-center text-muted-foreground">暂无使用记录</div>
          )}
        </CardContent>
      </Card>
    </>
    );
  }, [statsLoading, stats, selectedWorkspace, currency, channels, showRecharge, showBilling, rechargeAmount, rechargeChannel, rechargeLoading, billingRecords, timeRange, handleRecharge, loadBillingRecords]);

  const quotaPercent = 0; // Balance mode: no longer meaningful as a percentage

  // Stats is the bottleneck; render page shell immediately and show per-card skeletons
  // while individual data sections are still loading.
  const showStatsSkeleton = statsLoading;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">仪表盘</h1>
        <div className="flex items-center gap-2">
          {workspaces.length > 0 && (
            <>
              <div className="flex items-center rounded-md border bg-background overflow-hidden">
                <button
                  onClick={() => setViewMode('overview')}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm font-medium transition-colors ${
                    viewMode === 'overview'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  总揽
                </button>
                <button
                  onClick={() => setViewMode('personal')}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm font-medium transition-colors ${
                    viewMode === 'personal'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <User className="w-3.5 h-3.5" />
                  个人
                </button>
                <button
                  onClick={() => setViewMode('team')}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm font-medium transition-colors ${
                    viewMode === 'team'
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  团队
                </button>
              </div>
              {viewMode === 'team' && workspaces.length > 0 && (
                <>
                  <span className="text-sm text-muted-foreground">工作空间:</span>
                  <select
                    className="h-8 rounded border bg-background px-2 text-sm"
                    value={selectedWorkspace?.id || ''}
                    onChange={(e) => {
                      const ws = workspaces.find(w => w.id === parseInt(e.target.value));
                      setSelectedWorkspace(ws);
                    }}
                  >
                    {workspaces.map(ws => (
                      <option key={ws.id} value={ws.id}>{ws.name}</option>
                    ))}
                  </select>
                </>
              )}
            </>
          )}
          <span className="text-sm text-muted-foreground">币种:</span>
          <select
            className="h-8 rounded border bg-background px-2 text-sm"
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="CNY">CNY (元)</option>
            <option value="USD">USD ($)</option>
          </select>
        </div>
      </div>

      {viewMode === 'overview' && (
        <>
          {/* Overview Summary Cards */}
          {showStatsSkeleton || workspacesLoading ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">工作空间总数</CardTitle>
                  <Server className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">{overviewData.totalWs}</div>
                  <p className="text-xs text-muted-foreground">其中 {overviewData.ownerCount} 个为所有者</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">个人余额</CardTitle>
                  <DollarSign className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">
                    {currencySymbol}{fmtMoney(overviewData.personalBalance)}
                  </div>
                  <p className="text-xs text-muted-foreground">当前用户全局余额</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">工作空间总余额</CardTitle>
                  <Wallet className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">
                    {currencySymbol}{fmtMoney(overviewData.workspaceBalance)}
                  </div>
                  <p className="text-xs text-muted-foreground">所有工作空间余额合计</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">总余额</CardTitle>
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">
                    {currencySymbol}{fmtMoney(overviewData.totalBalance)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    个人 + {overviewData.totalWs} 个工作空间
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">总配额</CardTitle>
                  <Zap className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">
                    {overviewData.totalQuotaLimit > 0 ? overviewData.totalQuotaLimit.toLocaleString() : '无限制'}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {overviewData.totalQuotaLimit > 0 ? `已用 ${overviewData.totalQuotaUsed.toLocaleString()}` : '配额模式未启用'}
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Workspace List */}
          {workspacesLoading ? (
            <TableCardSkeleton rows={4} />
          ) : (
          <Card>
            <CardHeader>
              <CardTitle>工作空间一览</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {workspaces.length === 0 ? (
                <div className="p-6 text-center text-muted-foreground">暂无工作空间</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b bg-muted/50">
                      <tr>
                        <th className="px-4 py-3 text-left font-medium">名称</th>
                        <th className="px-4 py-3 text-left font-medium">角色</th>
                        <th className="px-4 py-3 text-right font-medium">余额</th>
                        <th className="px-4 py-3 text-right font-medium">配额</th>
                        <th className="px-4 py-3 text-right font-medium">已用</th>
                        <th className="px-4 py-3 text-center font-medium">状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {workspaces.map(ws => (
                        <tr key={ws.id} className="border-b hover:bg-muted/30">
                          <td className="px-4 py-3 font-medium">{ws.name}</td>
                          <td className="px-4 py-3">
                            <Badge variant={ws.member_role === 'owner' ? 'default' : ws.member_role === 'admin' ? 'secondary' : 'outline'} className="text-[10px]">
                              {ws.member_role === 'owner' ? '所有者' : ws.member_role === 'admin' ? '管理员' : '成员'}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-right font-mono">{currencySymbol}{fmtMoney(ws.balance)}</td>
                          <td className="px-4 py-3 text-right font-mono">{(ws.quota_limit || 0).toLocaleString()}</td>
                          <td className="px-4 py-3 text-right font-mono">{(ws.quota_used || 0).toLocaleString()}</td>
                          <td className="px-4 py-3 text-center">
                            <Badge variant={ws.status === 'active' ? 'success' : 'secondary'} className="text-[10px]">
                              {ws.status === 'active' ? '活跃' : ws.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
          )}
          {/* User Activity Summary */}
          {showStatsSkeleton ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <CardSkeleton key={i} />
              ))}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">今日Token</CardTitle>
                  <Zap className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">
                    {stats?.today?.tokens?.toLocaleString() || 0}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    今日请求: {stats?.today?.requests || 0} 次
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">今日消费</CardTitle>
                  <TrendingUp className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">
                    {currencySymbol}{fmtMoney(stats?.today?.cost)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    平均延迟: {stats?.today?.avg_latency || 0}ms
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">累计Token</CardTitle>
                  <Zap className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">
                    {stats?.cumulative_tokens?.toLocaleString() || 0}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    累计: {stats?.cumulative_requests?.toLocaleString() || 0} 次请求
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium">API密钥</CardTitle>
                  <Key className="w-4 h-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold truncate">
                    {stats?.active_keys || 0}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    累计消费: {currencySymbol}{fmtMoney(stats?.cumulative_cost)}
                  </p>
                </CardContent>
              </Card>
            </div>
          )}
          {personalFeatures}
        </>
      )}

      {viewMode === 'personal' && (
        <>
      {showStatsSkeleton ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">余额</CardTitle>
              <DollarSign className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold truncate">
                {`${currencySymbol}${fmtMoney(stats?.personal_balance)}`}
              </div>
              <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
                <div>账户独立余额</div>
                <div>与充值、退款统一</div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">今日Token</CardTitle>
              <Zap className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold truncate">
                {stats?.today?.tokens?.toLocaleString() || 0}
              </div>
              <p className="text-xs text-muted-foreground">
                今日请求: {stats?.today?.requests || 0} 次
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">今日消费</CardTitle>
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold truncate">
                {`${currencySymbol}${fmtMoney(stats?.today?.cost)}`}
              </div>
              <p className="text-xs text-muted-foreground">
                平均延迟: {stats?.today?.avg_latency || 0}ms
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">累计Token</CardTitle>
              <Zap className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold truncate">
                {stats?.cumulative_tokens?.toLocaleString() || 0}
              </div>
              <p className="text-xs text-muted-foreground">
                累计: {stats?.cumulative_requests?.toLocaleString() || 0} 次请求
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">API密钥</CardTitle>
              <Key className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold truncate">
                {stats?.active_keys || 0}
              </div>
              <p className="text-xs text-muted-foreground">
                累计消费: {`${currencySymbol}${fmtMoney(stats?.cumulative_cost)}`}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {personalFeatures}
        </>
      )}

      {viewMode === 'team' && (
        workspaces.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Users className="w-12 h-12 mx-auto mb-4 text-muted-foreground/50" />
            <p className="text-lg font-medium">暂无工作空间</p>
            <p className="text-sm mt-1">团队视图需要至少一个工作空间</p>
          </div>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Wallet className="w-5 h-5" />
                  工作空间余额
                </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="text-sm text-muted-foreground">当前工作空间: <strong>{selectedWorkspace?.name}</strong></div>
                <div className={`text-xl font-bold truncate ${(selectedWorkspace?.balance || 0) <= 0 ? 'text-destructive' : ''}`}>
                  {currencySymbol}{fmtMoney(selectedWorkspace?.balance || 0)}
                </div>
                <div className="text-sm text-muted-foreground">
                  已用额度：{currencySymbol}{fmtMoney(selectedWorkspace?.quota_used || 0)} / {currencySymbol}{fmtMoney(selectedWorkspace?.quota_limit || 0)}
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button size="sm" onClick={() => setShowRecharge(!showRecharge)} disabled={!selectedWorkspace}>
                  <CreditCard className="w-4 h-4 mr-1" />
                  充值
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setShowBilling(!showBilling); if (!showBilling) loadBillingRecords(); }} disabled={!selectedWorkspace}>
                  <History className="w-4 h-4 mr-1" />
                  计费记录
                </Button>
              </div>
            </CardContent>
          </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="w-5 h-5" />
            余额详情
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground">工作空间余额</div>
            <div className={`text-xl font-bold truncate ${(selectedWorkspace?.balance || 0) <= 0 ? 'text-destructive' : ''}`}>
              {currencySymbol}{fmtMoney(selectedWorkspace?.balance || 0)}
            </div>
            <div className="text-sm text-muted-foreground">
              已用额度：{`${currencySymbol}${fmtMoney(selectedWorkspace?.quota_used || 0)}`} / {currencySymbol}{fmtMoney(selectedWorkspace?.quota_limit || 0)}
            </div>
          </div>
          
          <div className="mt-4 flex gap-2">
            <Button size="sm" onClick={() => setShowRecharge(!showRecharge)} disabled={!selectedWorkspace}>
              <CreditCard className="w-4 h-4 mr-1" />
              充值
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setShowBilling(!showBilling); if (!showBilling) loadBillingRecords(); }} disabled={!selectedWorkspace}>
              <History className="w-4 h-4 mr-1" />
              计费记录
            </Button>
          </div>

          {showRecharge && (
            <div className="mt-4 p-4 bg-muted/30 rounded-md space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">充值金额</label>
                  <Input
                    type="number"
                    placeholder="100"
                    value={rechargeAmount}
                    onChange={e => setRechargeAmount(formatAmountInput(e.target.value))}
                    min="1"
                    max="1000"
                    step="0.01"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1.5 block">支付渠道</label>
                  <select
                    value={rechargeChannel}
                    onChange={e => setRechargeChannel(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">请选择</option>
                    {channels.map(ch => (
                      <option key={ch.id} value={ch.type}>{ch.name} ({ch.env === 'production' ? '生产' : '沙盒'})</option>
                    ))}
                  </select>
                </div>
              </div>
              <Button size="sm" onClick={handleRecharge} disabled={rechargeLoading} className="w-full">
                {rechargeLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-2" />}
                立即充值
              </Button>
            </div>
          )}

          {showBilling && (
            <div className="mt-4 space-y-2">
              <div className="text-sm font-medium">计费记录</div>
              {!billingRecords || billingRecords.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center bg-muted/30 rounded-md">
                  暂无计费记录
                </div>
              ) : (
                <div className="space-y-1 max-h-60 overflow-auto">
                  {billingRecords.slice(0, 10).map(record => (
                    <div key={record.id} className="flex items-center justify-between px-3 py-2 rounded-md bg-muted/30 text-sm">
                      <div className="flex-1">
                        <div className="font-medium">{record.description || record.type}</div>
                        <div className="text-xs text-muted-foreground">{new Date(record.created_at).toLocaleString()}</div>
                      </div>
                      <div className={`font-medium ${record.type === 'recharge' ? 'text-green-600' : 'text-red-600'}`}>
                        {record.type === 'recharge' ? '+' : '-'}{currencySymbol}{fmtMoney(record.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="mt-4 grid gap-4 md:grid-cols-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">配额额度</span>
              <span className="font-medium">{currencySymbol}{fmtMoney(selectedWorkspace?.quota_limit || 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">已用额度</span>
              <span className="font-medium">{currencySymbol}{fmtMoney(selectedWorkspace?.quota_used || 0)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">剩余额度</span>
              <span className="font-medium">
                {currencySymbol}{fmtMoney((selectedWorkspace?.quota_limit || 0) - (selectedWorkspace?.quota_used || 0))}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">工作空间余额</span>
              <span className="font-medium">{currencySymbol}{fmtMoney(selectedWorkspace?.balance || 0)}</span>
            </div>
          </div>
        </CardContent>
      </Card>
          </>
        )
      )}
    </div>
  );
}
