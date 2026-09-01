import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../hooks/useAuth';
import { Card } from '../components/Card';
import { Input } from '../components/Input';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import {
  CreditCard, Wallet, Zap, Check, RefreshCw, Landmark, Smartphone,
  X, AlertCircle, CheckCircle, Loader2, ArrowDown, ArrowUp, Terminal
} from 'lucide-react';
import { cn } from '../lib/utils';
import api from '../lib/api';
import { formatCurrency } from '../utils/currency';

const API_URL = import.meta.env.VITE_API_URL || '/api';

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className={cn(
      "fixed top-4 right-4 z-[200] flex items-center gap-2 px-4 py-3 rounded-lg shadow-lg text-sm font-medium animate-in slide-in-from-right",
      type === 'error' ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white'
    )}>
      {type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
      {message}
      <button onClick={onClose} className="ml-2 opacity-70 hover:opacity-100"><X className="w-4 h-4" /></button>
    </div>
  );
}

export default function Billing() {
  const { token } = useAuth();
  const [plans, setPlans] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [selectedWsId, setSelectedWsId] = useState(null);
  const [rechargeAmount, setRechargeAmount] = useState('');
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsTotal, setRecordsTotal] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  const [billingLogs, setBillingLogs] = useState([]);
  const [logsPage, setLogsPage] = useState(1);
  const [logsTotal, setLogsTotal] = useState(0);
  const [logsLoading, setLogsLoading] = useState(false);

  const selectedWs = Array.isArray(workspaces) ? workspaces.find(w => w.id === selectedWsId) : undefined;

  const showToast = (message, type = 'success') => setToast({ message, type });

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, wsRes] = await Promise.all([
        api.get('/billing/plans'),
        api.get('/workspaces'),
      ]);
      setPlans(plansRes.data || []);
      const ws = wsRes.data || [];
      setWorkspaces(ws);
      if (ws.length > 0 && !selectedWsId) setSelectedWsId(ws[0].id);
    } catch (e) { showToast('网络错误', 'error'); }
    setLoading(false);
  }, [token, selectedWsId]);

  const fetchRecords = useCallback(async () => {
    if (!selectedWsId) return;
    try {
      const res = await api.get(`/workspaces/${selectedWsId}/billing?page=${recordsPage}&limit=20`);
      setRecords(res.data.records || []);
      setRecordsTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
  }, [token, selectedWsId, recordsPage]);

  const fetchBillingLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await api.get(`/billing/logs?page=${logsPage}&limit=20`);
      setBillingLogs(res.data.logs || []);
      setLogsTotal(res.data.total || 0);
    } catch (e) { console.error(e); }
    setLogsLoading(false);
  }, [token, logsPage]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { fetchRecords(); }, [fetchRecords]);
  useEffect(() => { if (showLogs) fetchBillingLogs(); }, [showLogs, fetchBillingLogs]);

  const recharge = async (channel) => {
    const amount = parseFloat(rechargeAmount);
    if (!selectedWsId) { showToast('请先选择 Workspace', 'error'); return; }
    if (!amount || amount <= 0) { showToast('请输入有效金额', 'error'); return; }
    if (amount < 0.01) { showToast('最小充值金额 0.01', 'error'); return; }

    setActionLoading(true);
    try {
      const res = await api.post('/billing/recharge', { workspace_id: selectedWsId, amount, channel });
      const data = res.data;

      // Mock payment
      const payRes = await api.get(data.payment_url);

      if (payRes.data?.success) {
        showToast(`充值成功！余额 ¥${formatCurrency(payRes.data.balance)}`);
        setRechargeAmount('');
        fetchData();
        fetchRecords();
      } else {
        showToast(payRes.data?.error || '支付失败', 'error');
      }
    } catch (err) {
      console.error('[Billing] recharge error:', err.response?.data || err.message);
      showToast(err.response?.data?.error || '网络错误', 'error');
    }
    setActionLoading(false);
  };

  const formatDate = (str) => {
    if (!str) return '-';
    const d = new Date(str);
    return isNaN(d.getTime()) ? String(str) : d.toLocaleString('zh-CN');
  };

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CreditCard className="w-6 h-6 text-primary" />
            计费中心
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            充值余额、查看账单、管理套餐
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => { setShowLogs(!showLogs); }}>
            <Terminal className="w-4 h-4 mr-1" />
            {showLogs ? '隐藏日志' : '操作日志'}
          </Button>
          <Button variant="outline" onClick={() => { fetchData(); fetchRecords(); }} disabled={loading}>
            <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} />
            刷新
          </Button>
        </div>
      </div>

      {/* Workspace selector + balance + recharge */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 md:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-muted-foreground">当前 Workspace</div>
              <select
                value={selectedWsId || ''}
                onChange={e => { setSelectedWsId(parseInt(e.target.value)); setRecordsPage(1); }}
                className="mt-1 h-10 px-3 rounded-md border border-input bg-background text-sm font-medium min-w-[200px]"
              >
                {workspaces.map(w => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>
            <div className="text-right">
              <div className="text-sm text-muted-foreground">可用余额</div>
              <div className="text-3xl font-bold truncate text-primary">
                ¥{formatCurrency(selectedWs?.balance)}
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="text-sm font-medium mb-3">快速充值</div>
          <Input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="输入金额"
            value={rechargeAmount}
            onChange={e => setRechargeAmount(e.target.value)}
            className="mb-3"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => recharge('alipay')}>
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Landmark className="w-4 h-4 mr-1" />}
              支付宝
            </Button>
            <Button size="sm" variant="outline" disabled={actionLoading} onClick={() => recharge('wechat')}>
              {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Smartphone className="w-4 h-4 mr-1" />}
              微信
            </Button>
          </div>
        </Card>
      </div>

      {/* Plans */}
      <div>
        <h2 className="text-lg font-semibold mb-3">套餐方案</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {plans.map((plan, idx) => (
            <Card key={plan.id} className={cn("p-5 relative", idx === 1 && "ring-2 ring-primary")}>
              {idx === 1 && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <Badge className="bg-primary text-primary-foreground">推荐</Badge>
                </div>
              )}
              <div className="text-lg font-semibold">{plan.name}</div>
              <div className="text-sm text-muted-foreground mt-1">{plan.description}</div>
              <div className="mt-4">
                <span className="text-3xl font-bold">¥{plan.price_monthly}</span>
                <span className="text-muted-foreground">/月</span>
              </div>
              {plan.price_yearly > 0 && (
                <div className="text-xs text-muted-foreground">
                  年付 ¥{plan.price_yearly}（省 ¥{(plan.price_monthly * 12 - plan.price_yearly).toFixed(0)}）
                </div>
              )}
              <div className="mt-4 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Zap className="w-4 h-4 text-primary" />
                  <span>配额 {plan.quota_limit?.toLocaleString()} tokens</span>
                </div>
                {plan.features && (() => {
                  try {
                    const f = JSON.parse(plan.features);
                    return Object.entries(f).map(([k, v]) => (
                      <div key={k} className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                        <span>{k}: {String(v)}</span>
                      </div>
                    ));
                  } catch { return null; }
                })()}
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Billing Records */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">账单流水</h2>
          <span className="text-sm text-muted-foreground">共 {recordsTotal} 条</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">时间</th>
                <th className="px-4 py-3 text-left font-medium">类型</th>
                <th className="px-4 py-3 text-left font-medium">金额</th>
                <th className="px-4 py-3 text-left font-medium">余额</th>
                <th className="px-4 py-3 text-left font-medium">说明</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">
                    暂无账单记录
                  </td>
                </tr>
              ) : (
                records.map(r => (
                  <tr key={r.id} className="border-b hover:bg-muted/30">
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatDate(r.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={r.type === 'recharge' ? 'default' : 'secondary'}>
                        {r.type === 'recharge' ? '充值' : '消费'}
                      </Badge>
                    </td>
                    <td className={cn("px-4 py-3 font-medium flex items-center gap-1",
                      r.type === 'recharge' ? 'text-emerald-600' : 'text-red-600'
                    )}>
                      {r.type === 'recharge' ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />}
                      {r.type === 'recharge' ? '+' : '-'}{r.amount}
                    </td>
                    <td className="px-4 py-3 font-medium">¥{formatCurrency(r.balance_after)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{r.description || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {recordsTotal > 20 && (
          <div className="flex items-center justify-between px-4 py-3 border-t">
            <div className="text-sm text-muted-foreground">第 {recordsPage} 页</div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setRecordsPage(p => Math.max(1, p - 1))} disabled={recordsPage <= 1}>
                上一页
              </Button>
              <Button size="sm" variant="outline" onClick={() => setRecordsPage(p => p + 1)} disabled={records.length < 20}>
                下一页
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Billing Logs */}
      {showLogs && (
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Terminal className="w-5 h-5" />
              操作日志
            </h2>
            <span className="text-sm text-muted-foreground">共 {logsTotal} 条</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left font-medium">时间</th>
                  <th className="px-4 py-3 text-left font-medium">操作</th>
                  <th className="px-4 py-3 text-left font-medium">数据</th>
                </tr>
              </thead>
              <tbody>
                {logsLoading ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-12 text-center text-muted-foreground">
                      <Loader2 className="w-5 h-5 animate-spin mx-auto" />
                    </td>
                  </tr>
                ) : billingLogs.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-12 text-center text-muted-foreground">
                      暂无日志记录
                    </td>
                  </tr>
                ) : (
                  billingLogs.map(log => (
                    <tr key={log.id} className="border-b hover:bg-muted/30">
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                        {formatDate(log.created_at)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline">{log.action}</Badge>
                      </td>
                      <td className="px-4 py-3 text-xs font-mono text-muted-foreground max-w-md truncate">
                        {log.data || '-'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {logsTotal > 20 && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <div className="text-sm text-muted-foreground">第 {logsPage} 页</div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setLogsPage(p => Math.max(1, p - 1))} disabled={logsPage <= 1}>
                  上一页
                </Button>
                <Button size="sm" variant="outline" onClick={() => setLogsPage(p => p + 1)} disabled={billingLogs.length < 20}>
                  下一页
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
